/*
 * Diamond Operatore Player (diaop.de) - single-connection sequential pipeline.
 * Licensed under the GNU GPL v3.0 - https://www.gnu.org/licenses/gpl-3.0.html
 *
 * SOURCE of js/pv/single-stream.js. Do not edit the bundle by hand: change
 * this file and run `npm run build:single-stream` (esbuild, ESM, unminified).
 *
 * Strict IPTV panels allow ONE open connection per movie file. This player
 * streams the whole file through a single request: Mediabunny sequential
 * demux, video passthrough, audio -> AAC in-browser (playsvideo's wasm ffmpeg
 * adapter), fMP4 -> MediaSource. Seeking reconnects once (Matroska cluster +
 * keyframe resync), playback auto-resumes after CDN drops, memory is bounded.
 */
import {
  ALL_FORMATS, Input, Output, Mp4OutputFormat, StreamTarget, ReadableStreamSource,
  EncodedPacketSink, EncodedAudioPacketSource, EncodedVideoPacketSource,
} from 'mediabunny';
import { WasmFfmpegRunner } from 'playsvideo';
// playsvideo's package "exports" only expose its index, so the audio helpers
// are reached by relative path (esbuild bundles them the same way).
import {
  concatEncodedPacketData, packetsFromAdtsData, runFfmpegAudioTranscode,
} from '../node_modules/playsvideo/dist/pipeline/audio-transcode.js';

// src-single/single-stream.js
var batchSecAt = (ts) => ts < 12 ? 1 : 3;
var HIGH_WATER_SEC = 40;
var LOW_WATER_SEC = 20;
var EVICT_KEEP_BEHIND_SEC = 20;
var CLUSTER_ID = [31, 67, 182, 117];
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var TEXT_SUB_CODECS = /* @__PURE__ */ new Set(["srt", "webvtt", "ass", "ssa"]);
var utf8 = new TextDecoder("utf-8", { fatal: false });
function decodeSubPayload(codec, data) {
  let text = utf8.decode(data).trim();
  if (codec === "ass" || codec === "ssa") {
    const parts = text.split(",");
    if (parts.length > 8) text = parts.slice(8).join(",");
    text = text.replace(/\{[^}]*\}/g, "");
  }
  return text.replace(/\\N/gi, "\n").trim();
}
function parseMkvDuration(bytes2) {
  const readUint = (off, len) => {
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + bytes2[off + i];
    return v;
  };
  let scale = 1e6;
  let duration = null;
  const view3 = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  for (let i = 0; i < bytes2.length - 12; i++) {
    if (bytes2[i] === 42 && bytes2[i + 1] === 215 && bytes2[i + 2] === 177) {
      const sizeByte = bytes2[i + 3];
      const len = sizeByte >= 129 && sizeByte <= 136 ? sizeByte - 128 : 0;
      if (len >= 1 && len <= 8) scale = readUint(i + 4, len);
    }
    if (bytes2[i] === 68 && bytes2[i + 1] === 137 && duration === null) {
      const sizeByte = bytes2[i + 2];
      const len = sizeByte === 132 ? 4 : sizeByte === 136 ? 8 : 0;
      if (len) {
        try {
          const v = len === 4 ? view3.getFloat32(i + 3) : view3.getFloat64(i + 3);
          if (Number.isFinite(v) && v > 0) duration = v;
        } catch {
        }
      }
    }
  }
  return duration !== null ? duration * scale / 1e9 : null;
}
function findClusterSync(chunk, carry) {
  const merged = carry.length ? (() => {
    const m = new Uint8Array(carry.length + chunk.length);
    m.set(carry, 0);
    m.set(chunk, carry.length);
    return m;
  })() : chunk;
  for (let i = 0; i <= merged.length - 4; i++) {
    if (merged[i] === CLUSTER_ID[0] && merged[i + 1] === CLUSTER_ID[1] && merged[i + 2] === CLUSTER_ID[2] && merged[i + 3] === CLUSTER_ID[3]) {
      return i - carry.length;
    }
  }
  return -1;
}
var SingleStreamPlayer = class {
  constructor(video, opts = {}) {
    this.video = video;
    this.onstatus = opts.onstatus || (() => {
    });
    this.dev = !!opts.dev;
    this._subsDisabled = false;
    this.stats = {
      sourceFetchCount: 0,
      concurrentViolations: 0,
      bytesReceived: 0,
      contentLength: null,
      durationSec: null
    };
    this._url = "";
    this._gen = 0;
    this._aborted = false;
    this._controller = null;
    this._activeConn = 0;
    this._headerBytes = null;
    this._runner = null;
    this._appendQueue = [];
    this._afterFlush = null;
    this._sb = null;
    this._ms = null;
    this._objectUrl = null;
    this._lastSafeTime = 0;
    this._seekBusy = false;
    this._pendingSeekTarget = null;
    this._seekLandTs = null;
    this._resumes = 0;
    this._highWater = HIGH_WATER_SEC;
    this._onTimeUpdate = null;
    this._onSeeking = null;
    this._textTracks = [];
    this._trackEls = [];
    this._onTtChange = null;
    this._cueKeys = /* @__PURE__ */ new Set();
  }
  _log(msg) {
    if (this.dev) console.log("[single-stream] " + msg);
  }
  async load(url2) {
    this._url = url2;
    this._runner = new WasmFfmpegRunner();
    const runnerReady = this._runner.loadForCodec("eac3").catch(() => {
    });
    await this._openPipeline(0, null, runnerReady);
  }
  // ── One connection at a time, enforced and instrumented ────────────────────
  async _openConnection(byteOffset) {
    if (this._activeConn > 0) {
      this.stats.concurrentViolations++;
      throw new Error("single-stream invariant violation: concurrent source connection attempted");
    }
    this.stats.sourceFetchCount++;
    this._controller = new AbortController();
    const headers = byteOffset > 0 ? { Range: "bytes=" + byteOffset + "-" } : {};
    this._log("opening source connection #" + this.stats.sourceFetchCount + (byteOffset ? " at ~" + Math.round(byteOffset / 1e6) + "MB" : ""));
    const response = await fetch(this._url, { headers, signal: this._controller.signal });
    if (!response.ok || !response.body) throw new Error("HTTP " + response.status);
    if (byteOffset === 0) {
      const len = response.headers.get("Content-Length");
      this.stats.contentLength = len ? Number(len) : null;
    }
    this._activeConn = 1;
    const self2 = this;
    return response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        self2.stats.bytesReceived += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        self2._activeConn = 0;
      }
    }));
  }
  // Build the demuxer input stream. At offset 0, also capture the header
  // bytes (needed to restart the demuxer after a seek) and the MKV duration.
  // For seek connections, skip to the next cluster and prepend the header.
  _composeInputStream(raw, byteOffset) {
    const self2 = this;
    if (byteOffset === 0) {
      const headerChunks = [];
      let headerDone = false;
      let carry2 = new Uint8Array(0);
      return raw.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          if (!headerDone) {
            const idx = findClusterSync(chunk, carry2);
            if (idx !== -1) {
              headerChunks.push(chunk.slice(0, Math.max(0, idx)));
              headerDone = true;
              let total = 0;
              for (const c of headerChunks) total += c.length;
              const merged = new Uint8Array(total);
              let o = 0;
              for (const c of headerChunks) {
                merged.set(c, o);
                o += c.length;
              }
              self2._headerBytes = idx < 0 ? merged.slice(0, merged.length + idx) : merged;
              self2.stats.durationSec = parseMkvDuration(self2._headerBytes);
              if (self2.stats.durationSec) {
                self2._log("duration from header: " + self2.stats.durationSec.toFixed(0) + "s");
                self2._applyDuration();
              }
            } else {
              headerChunks.push(chunk.slice());
              carry2 = chunk.slice(Math.max(0, chunk.length - 3));
              if (headerChunks.reduce((n, c) => n + c.length, 0) > 32 * 2 ** 20) headerDone = true;
            }
          }
          controller.enqueue(chunk);
        }
      }));
    }
    let synced = false;
    let carry = new Uint8Array(0);
    const header = this._headerBytes;
    return raw.pipeThrough(new TransformStream({
      start(controller) {
        controller.enqueue(header);
      },
      transform(chunk, controller) {
        if (synced) {
          controller.enqueue(chunk);
          return;
        }
        const idx = findClusterSync(chunk, carry);
        if (idx === -1) {
          carry = chunk.slice(Math.max(0, chunk.length - 3));
          return;
        }
        synced = true;
        if (idx < 0) {
          controller.enqueue(carry.slice(carry.length + idx));
          controller.enqueue(chunk);
        } else {
          controller.enqueue(chunk.slice(idx));
        }
      }
    }));
  }
  _applyDuration() {
    if (this._ms && this._ms.readyState === "open" && this.stats.durationSec) {
      try {
        this._ms.duration = this.stats.durationSec;
      } catch {
      }
    }
  }
  async _openPipeline(byteOffset, targetTimeSec, runnerReady) {
    const gen = ++this._gen;
    const raw = await this._openConnection(byteOffset);
    const stream = this._composeInputStream(raw, byteOffset);
    const ssCacheMB = window.BROWPLAYER_SS_CACHE_MB ||
      (/PlayStation|Nintendo|SMART-TV|SmartTV|Tizen|WebOS|Web0S/i.test(navigator.userAgent) ? 96 : 384);
    const source = new ReadableStreamSource(stream, { maxCacheSize: ssCacheMB * 2 ** 20 });
    const input = new Input({ formats: ALL_FORMATS, source });
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!videoTrack) throw new Error("no video track found");
    let subTracks = [];
    try {
      const allSubs = await input.getSubtitleTracks();
      subTracks = allSubs.filter((t) => t.codec && TEXT_SUB_CODECS.has(t.codec));
      if (allSubs.length && byteOffset === 0) {
        console.log("[single-stream] subtitle tracks: " + allSubs.map(
          (t) => `${t.languageCode || "?"}:${t.codec || "?"}${TEXT_SUB_CODECS.has(t.codec) ? "" : " (image-based, unsupported)"}`
        ).join(", "));
      }
    } catch {
    }
    this._checkGen(gen);
    const vParam = await videoTrack.getCodecParameterString();
    const vConfig = await videoTrack.getDecoderConfig();
    if (!vParam || !vConfig) throw new Error("video codec parameters unavailable");
    const audioCodecIn = audioTrack ? audioTrack.codec : null;
    const mime = audioTrack ? `video/mp4; codecs="${vParam}, mp4a.40.2"` : `video/mp4; codecs="${vParam}"`;
    if (byteOffset === 0) {
      const MSImpl = window.MediaSource || window.ManagedMediaSource;
      if (!MSImpl || !MSImpl.isTypeSupported(mime)) {
        throw new Error("unsupported-codecs: " + mime);
      }
      this._log(`tracks: video=${videoTrack.codec} (${vParam}) audio=${audioCodecIn || "none"} -> aac`);
      await this._setupMediaSource(mime);
      this._checkGen(gen);
      this._applyDuration();
      if (subTracks.length) {
        const safeName = (t, i) => {
          const n = t.name && !/https?:\/\/|@/.test(t.name) && t.name.length <= 48 ? t.name.trim() : "";
          return n || t.languageCode || "Subtitle " + (i + 1);
        };
        for (let i = 0; i < subTracks.length; i++) {
          const t = subTracks[i];
          const label = safeName(t, i);
          const el = document.createElement("track");
          el.kind = "subtitles";
          el.label = label;
          el.srclang = t.languageCode || "";
          el.src = URL.createObjectURL(new Blob(["WEBVTT\n\n"], { type: "text/vtt" }));
          this.video.appendChild(el);
          el.track.mode = "hidden";
          this._trackEls.push(el);
          this._textTracks.push(el.track);
        }
        this._onTtChange = () => {
          let id = -1;
          for (let i = 0; i < this._textTracks.length; i++) {
            if (this._textTracks[i].mode === "showing") {
              id = i;
              break;
            }
          }
          this.onstatus({ type: "subtitle-selected", id });
        };
        this.video.textTracks.addEventListener("change", this._onTtChange);
        this._log("embedded subtitle tracks: " + subTracks.length);
        this.onstatus({
          type: "subtitles",
          tracks: subTracks.map((t, i) => ({ id: i, name: safeName(t, i) }))
        });
      }
      if (runnerReady) await runnerReady;
    }
    let sampleRate = 48e3;
    if (audioTrack) {
      await this._runner.loadForCodec(audioCodecIn || "ac3");
      sampleRate = audioTrack.sampleRate || 48e3;
    }
    this._checkGen(gen);
    const writable = new WritableStream({
      write: (chunk) => {
        if (gen === this._gen) this._enqueueAppend(chunk.data);
      }
    });
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 }),
      target: new StreamTarget(writable)
    });
    this._output = output;
    const vOut = new EncodedVideoPacketSource(videoTrack.codec);
    output.addVideoTrack(vOut);
    let aOut = null;
    if (audioTrack) {
      aOut = new EncodedAudioPacketSource("aac");
      output.addAudioTrack(aOut);
    }
    await output.start();
    this._checkGen(gen);
    this._pump(gen, videoTrack, audioTrack, subTracks, vOut, aOut, vConfig, sampleRate, audioCodecIn, targetTimeSec).catch((err) => {
      if (gen !== this._gen || this._aborted) return;
      const msg = String(err && err.message || err);
      this._log("pipeline error: " + msg);
      if (/before the cached region/i.test(msg)) {
        this._subsDisabled = true;
      }
      if (/network|fetch|timed? ?out|aborted|reset|before the cached region/i.test(msg) && this._resumes < 5) {
        this._resumes++;
        const at = Math.max(0, (this.video.currentTime || this._lastSafeTime) - 2);
        this.onstatus({ type: "resuming", at });
        this.seekTo(Math.max(at, 1));
        return;
      }
      this.onstatus({ type: "error", message: msg });
    });
  }
  async _pump(gen, videoTrack, audioTrack, subTracks, vOut, aOut, vConfig, sampleRate, audioCodecIn, targetTimeSec) {
    const vSink = new EncodedPacketSink(videoTrack);
    const aSink = audioTrack ? new EncodedPacketSink(audioTrack) : null;
    const subs = subTracks.map((t, i) => ({
      sink: new EncodedPacketSink(t),
      codec: t.codec,
      tt: this._textTracks[i],
      pkt: null,
      started: false,
      dead: false,
      idx: i
    }));
    const subDied = (sc, why) => {
      sc.dead = true;
      console.warn(`[single-stream] subtitle track ${sc.idx} (${sc.codec}) stopped: ${why} (${sc.cueCount || 0} cues delivered)`);
    };
    const CACHE_MISS_RX = /before the cached region/i;
    const reanchorSub = (sc, ts) => {
      sc.anchorCount = (sc.anchorCount || 0) + 1;
      if (sc.anchorCount > 20) {
        subDied(sc, "keeps falling out of the stream cache");
        return;
      }
      sc.sink.getPacket(ts).then((p) => {
        if (p) {
          sc.pkt = p;
          return;
        }
        sc.needsAnchor = true;
        sc.nextAnchorTs = ts + 10;
      }).catch((e) => {
        sc.anchorFails = (sc.anchorFails || 0) + 1;
        if (sc.anchorFails > 3) {
          subDied(sc, "re-anchor failed: " + (e && e.message || e));
          return;
        }
        sc.needsAnchor = true;
        sc.nextAnchorTs = ts + 10;
      });
    };
    const startSub = (sc) => {
      sc.started = true;
      sc.sink.getFirstPacket().then((p) => {
        sc.pkt = p;
        if (!p) subDied(sc, "no packets in stream");
      }).catch((e) => {
        const m = String(e && e.message || e);
        if (CACHE_MISS_RX.test(m)) {
          sc.needsAnchor = true;
          sc.nextAnchorTs = 0;
        } else subDied(sc, "first packet failed: " + m);
      });
      setTimeout(() => {
        if (gen === this._gen && !sc.pkt && !sc.dead && !sc.cueCount) {
          console.log(`[single-stream] subtitle track ${sc.idx} (${sc.codec}): no cue yet after 60s - still scanning (normal if no dialogue so far)`);
        }
      }, 6e4);
    };
    const deliverSub = (sc) => {
      const p = sc.pkt;
      sc.pkt = null;
      try {
        const text = decodeSubPayload(sc.codec, p.data);
        const key = sc.idx + ":" + p.timestamp.toFixed(3);
        if (text && !this._cueKeys.has(key)) {
          this._cueKeys.add(key);
          const Cue = window.VTTCue || window.TextTrackCue;
          sc.tt.addCue(new Cue(p.timestamp, p.timestamp + Math.max(0.5, p.duration || 2), text));
          sc.cueCount = (sc.cueCount || 0) + 1;
          if (sc.cueCount === 1) console.log(`[single-stream] subtitle track ${sc.idx} (${sc.codec}): first cue at ${p.timestamp.toFixed(1)}s`);
        } else if (!text) {
          sc.emptyCount = (sc.emptyCount || 0) + 1;
          if (sc.emptyCount === 20) console.warn(`[single-stream] subtitle track ${sc.idx} (${sc.codec}): cues decode to empty text (unexpected payload format)`);
        }
      } catch (e) {
        this._log(`subtitle track ${sc.idx}: bad cue at ${p.timestamp.toFixed(1)}s: ` + (e && e.message || e));
      }
      sc.sink.getNextPacket(p).then((n) => {
        sc.pkt = n;
        if (!n) sc.dead = true;
      }).catch((e) => {
        const m = String(e && e.message || e);
        if (CACHE_MISS_RX.test(m)) {
          // Fell behind the sequential cache - rejoin at the current
          // position instead of dying (duplicate cues are deduped).
          sc.needsAnchor = true;
          sc.nextAnchorTs = 0;
          return;
        }
        subDied(sc, "read failed: " + m);
      });
    };
    let vPkt = await vSink.getFirstPacket();
    let aPkt = aSink ? await aSink.getFirstPacket() : null;
    if (targetTimeSec !== null && targetTimeSec !== void 0) {
      while (vPkt && vPkt.type !== "key") {
        this._checkGen(gen);
        vPkt = await vSink.getNextPacket(vPkt);
      }
      if (vPkt && aSink) {
        while (aPkt && aPkt.timestamp < vPkt.timestamp - 0.2) {
          this._checkGen(gen);
          aPkt = await aSink.getNextPacket(aPkt);
        }
      }
    }
    let firstV = true;
    let firstA = true;
    let batch = [];
    let batchStart = null;
    let lastAudioTs = -Infinity;
    let announcedStart = false;
    const flushAudio = async () => {
      if (!batch.length || !this._runner) return;
      const packets = batch;
      const startSec = batchStart;
      batch = [];
      batchStart = null;
      const { data } = concatEncodedPacketData(packets);
      const { aacData } = await runFfmpegAudioTranscode({
        ffmpeg: this._runner,
        inputData: data,
        sourceCodec: audioCodecIn || "ac3"
      });
      this._checkGen(gen);
      const parsed = packetsFromAdtsData(aacData, sampleRate, startSec);
      for (const p of parsed.packets) {
        if (p.timestamp <= lastAudioTs + 1e-4) continue;
        this._checkGen(gen);
        await aOut.add(p, firstA ? { decoderConfig: parsed.decoderConfig } : void 0);
        firstA = false;
        lastAudioTs = p.timestamp;
      }
    };
    while ((vPkt || aPkt) && gen === this._gen && !this._aborted) {
      if (!announcedStart) {
        announcedStart = true;
        const startTs = vPkt ? vPkt.timestamp : aPkt ? aPkt.timestamp : 0;
        if (targetTimeSec !== null && targetTimeSec !== void 0) {
          this._log("resynced at " + startTs.toFixed(1) + "s (target " + targetTimeSec.toFixed(1) + "s)");
          this._seekLandTs = startTs;
        }
      }
      const nowTs = vPkt ? vPkt.timestamp : aPkt ? aPkt.timestamp : 0;
      for (const sc of subs) {
        if (sc.dead || this._subsDisabled) continue;
        if (!sc.started && nowTs > 1) startSub(sc);
        if (sc.needsAnchor && nowTs >= (sc.nextAnchorTs || 0)) {
          sc.needsAnchor = false;
          reanchorSub(sc, nowTs);
        }
        while (sc.pkt && sc.pkt.timestamp <= nowTs + 90) deliverSub(sc);
      }
      const takeVideo = vPkt && (!aPkt || vPkt.timestamp <= aPkt.timestamp);
      if (takeVideo) {
        if (batch.length && vPkt.timestamp > batchStart + batchSecAt(batchStart)) await flushAudio();
        this._checkGen(gen);
        await vOut.add(vPkt, firstV ? { decoderConfig: vConfig } : void 0);
        firstV = false;
        vPkt = await vSink.getNextPacket(vPkt);
      } else {
        if (batchStart === null) batchStart = aPkt.timestamp;
        batch.push(aPkt);
        if (aPkt.timestamp - batchStart >= batchSecAt(batchStart)) await flushAudio();
        aPkt = await aSink.getNextPacket(aPkt);
      }
      await this._backpressure(gen);
    }
    if (gen !== this._gen || this._aborted) return;
    await flushAudio();
    await this._output.finalize();
    this._flushQueueThen(() => {
      if (this._ms && this._ms.readyState === "open") {
        try {
          this._ms.endOfStream();
        } catch {
        }
      }
    });
    this._log("pipeline complete");
  }
  async _backpressure(gen) {
    for (; ; ) {
      if (gen !== this._gen || this._aborted) return;
      const v = this.video;
      let ahead = 0;
      try {
        const b = v.buffered;
        const t = v.currentTime;
        for (let i = 0; i < b.length; i++) {
          if (t >= b.start(i) - 0.5 && t <= b.end(i) + 0.5) {
            ahead = b.end(i) - t;
            break;
          }
        }
      } catch {
      }
      if (ahead < (this._throttled ? LOW_WATER_SEC : this._highWater)) {
        this._throttled = false;
        return;
      }
      this._throttled = true;
      this._maybeEvict();
      await sleep(500);
    }
  }
  // ── Seeking: abort the connection, open exactly one new one ────────────────
  _timeToOffset(t) {
    const size = this.stats.contentLength;
    const dur = this.stats.durationSec;
    if (!size || !dur || !this._headerBytes) return null;
    const headerLen = this._headerBytes.length;
    const frac = Math.min(0.99, Math.max(0, t / dur));
    const bytesPerSec = (size - headerLen) / dur;
    const off = headerLen + Math.max(0, Math.floor((size - headerLen) * frac - 12 * bytesPerSec));
    return Math.max(headerLen, off);
  }
  canSeekTo(t) {
    return this._timeToOffset(t) !== null;
  }
  async seekTo(t) {
    if (this._seekBusy || this._aborted) return;
    const offset = this._timeToOffset(t);
    if (offset === null) {
      this.onstatus({ type: "seek-unavailable" });
      return;
    }
    this._seekBusy = true;
    this._pendingSeekTarget = t;
    this._seekLandTs = null;
    this.onstatus({ type: "seeking-remote" });
    this._gen++;
    try {
      if (this._controller) this._controller.abort();
    } catch {
    }
    if (this._output) {
      this._output.cancel().catch(() => {
      });
      this._output = null;
    }
    this._appendQueue = [];
    this._activeConn = 0;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await this._openPipeline(offset, t, null);
          return;
        } catch (err) {
          const s = String(err && err.message || err);
          if ((/\b(458|509)\b/.test(s) || /network|fetch|timed? ?out/i.test(s)) && attempt < 3) {
            this.onstatus({ type: "seek-waiting", attempt });
            await sleep(3e3 * (attempt + 1));
            if (this._aborted) return;
            continue;
          }
          this._log("seek failed: " + s);
          this._pendingSeekTarget = null;
          this._seekLandTs = null;
          try {
            this.video.currentTime = this._lastSafeTime;
          } catch {
          }
          this.onstatus({ type: "seek-failed", message: s });
          return;
        }
      }
    } finally {
      this._seekBusy = false;
      this._pendingSeekTarget = null;
      this._seekLandTs = null;
      this._resumes = 0;
    }
  }
  // ── MediaSource plumbing ───────────────────────────────────────────────────
  async _setupMediaSource(mime) {
    const MSImpl = window.MediaSource || window.ManagedMediaSource;
    const ms = new MSImpl();
    this._ms = ms;
    if (!window.MediaSource) {
      try {
        this.video.disableRemotePlayback = true;
      } catch {
      }
    }
    this._objectUrl = URL.createObjectURL(ms);
    await new Promise((resolve, reject) => {
      ms.addEventListener("sourceopen", resolve, { once: true });
      ms.addEventListener("error", reject, { once: true });
      this.video.src = this._objectUrl;
    });
    const sb = ms.addSourceBuffer(mime);
    this._sb = sb;
    sb.addEventListener("updateend", () => this._pumpAppends());
    this._onTimeUpdate = () => {
      const v = this.video;
      if (!v.seeking) this._lastSafeTime = v.currentTime;
      this._maybeEvict();
    };
    this._onSeeking = () => {
      const v = this.video;
      const t = v.currentTime;
      if (this._seekBusy || this._pendingSeekTarget !== null) return;
      let inBuffered = false;
      try {
        const b = v.buffered;
        for (let i = 0; i < b.length; i++) {
          if (t >= b.start(i) - 0.5 && t <= b.end(i) + 0.5) {
            inBuffered = true;
            break;
          }
        }
      } catch {
      }
      if (inBuffered) return;
      if (this.canSeekTo(t)) {
        this.seekTo(t);
      } else {
        this.onstatus({ type: "seek-unavailable" });
        v.currentTime = this._lastSafeTime;
      }
    };
    this.video.addEventListener("timeupdate", this._onTimeUpdate);
    this.video.addEventListener("seeking", this._onSeeking);
  }
  _enqueueAppend(data) {
    if (this._aborted) return;
    this._appendQueue.push(data.slice ? data.slice() : data);
    this._pumpAppends();
  }
  _maybeFinishSeek() {
    if (this._pendingSeekTarget === null || this._seekLandTs === null) return;
    try {
      const b = this.video.buffered;
      for (let i = 0; i < b.length; i++) {
        if (this._seekLandTs >= b.start(i) - 0.3 && this._seekLandTs + 0.4 <= b.end(i)) {
          const tgt = Math.max(
            this._seekLandTs + 0.1,
            Math.min(this._pendingSeekTarget, b.end(i) - 0.2)
          );
          this._pendingSeekTarget = null;
          this._seekLandTs = null;
          this.video.currentTime = tgt;
          this.video.play().catch(() => {
          });
          this.onstatus({ type: "seeked", at: tgt });
          return;
        }
      }
    } catch {
    }
  }
  _pumpAppends() {
    if (this._aborted || !this._sb || this._sb.updating) return;
    this._maybeFinishSeek();
    if (!this._appendQueue.length) {
      if (this._afterFlush) {
        const f = this._afterFlush;
        this._afterFlush = null;
        f();
      }
      return;
    }
    const op = this._appendQueue[0];
    try {
      this._sb.appendBuffer(op);
      this._appendQueue.shift();
    } catch (e) {
      if (e && e.name === "QuotaExceededError") {
        this._highWater = Math.max(12, Math.floor(this._highWater / 2));
        this._log("quota hit - shrinking forward window to " + this._highWater + "s");
        const t = this.video.currentTime;
        try {
          if (!this._sb.updating && t > 6) this._sb.remove(0, Math.max(0.5, t - 5));
          else this._appendQueue.shift();
        } catch {
          this._appendQueue.shift();
        }
      } else {
        this._log("append failed: " + e);
        this._appendQueue.shift();
      }
    }
  }
  _flushQueueThen(fn) {
    this._afterFlush = fn;
    this._pumpAppends();
  }
  _maybeEvict() {
    if (!this._sb || this._sb.updating) return;
    const t = this.video.currentTime;
    try {
      const b = this._sb.buffered;
      if (b.length && t - b.start(0) > EVICT_KEEP_BEHIND_SEC + 10) {
        this._sb.remove(0, t - EVICT_KEEP_BEHIND_SEC);
      } else if (b.length && b.end(b.length - 1) > t + 150) {
        this._sb.remove(t + 120, Infinity);
      }
    } catch {
    }
  }
  _checkGen(gen) {
    if (gen !== this._gen || this._aborted) throw new Error("aborted");
  }
  // Text tracks added with addTextTrack() stay on the <video> element for its
  // whole lifetime - every earlier playback leaves its tracks behind - so
  // selection must map into THIS instance's tracks, never into the element's
  // full textTracks list by index.
  setSubtitleTrack(id) {
    const all = this.video.textTracks;
    for (let i = 0; i < all.length; i++) all[i].mode = "disabled";
    for (const tt of this._textTracks) tt.mode = "hidden";
    if (id >= 0 && this._textTracks[id]) this._textTracks[id].mode = "showing";
  }
  destroy() {
    if (this._aborted) return;
    this._aborted = true;
    if (this._onTtChange && this.video) {
      try {
        this.video.textTracks.removeEventListener("change", this._onTtChange);
      } catch {
      }
    }
    for (const el of this._trackEls) {
      try {
        el.track.mode = "disabled";
        URL.revokeObjectURL(el.src);
        el.remove();
      } catch {
      }
    }
    this._trackEls = [];
    this._textTracks = [];
    this._gen++;
    this._pendingSeekTarget = null;
    try {
      if (this._controller) this._controller.abort();
    } catch {
    }
    if (this._output) {
      this._output.cancel().catch(() => {
      });
    }
    this._appendQueue = [];
    if (this.video) {
      if (this._onTimeUpdate) this.video.removeEventListener("timeupdate", this._onTimeUpdate);
      if (this._onSeeking) this.video.removeEventListener("seeking", this._onSeeking);
    }
    if (this._objectUrl) {
      try {
        URL.revokeObjectURL(this._objectUrl);
      } catch {
      }
    }
    this._sb = null;
    this._ms = null;
    this._runner = null;
  }
};
export {
  SingleStreamPlayer
};
