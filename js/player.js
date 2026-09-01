/*
 * Diamond Operatore Player (diaop.de) - playback engine (HLS via hls.js, native HLS, direct files).
 * Licensed under the GNU GPL v3.0 - https://www.gnu.org/licenses/gpl-3.0.html
 *
 * Exactly one stream is active at a time; switching or stopping always
 * destroys the previous hls.js instance and detaches the media element.
 */
'use strict';

const Player = (() => {
  let hls = null;
  let current = null;   // { video, statusEl, url, retries }
  let retryTimer = null;
  let audioTimer = null;
  let audioWarn = '';   // set when the stream declares an unsupported audio codec
  let onTracks = null;  // app callback for audio/subtitle track lists

  // Alternate audio and subtitle tracks (HLS streams that declare them).
  function notifyTracks() {
    if (!onTracks) return;
    if (!hls) { onTracks({ audio: [], subs: [], audioId: -1, subId: -1 }); return; }
    const name = (t, prefix, i) => String(t.name || t.lang || (prefix + ' ' + (i + 1)));
    onTracks({
      audio: (hls.audioTracks || []).map((t, i) => ({ id: t.id, name: name(t, 'Audio', i) })),
      subs: (hls.subtitleTracks || []).map((t, i) => ({ id: t.id, name: name(t, 'Subtitle', i) })),
      audioId: hls.audioTrack,
      subId: hls.subtitleTrack,
    });
  }

  function setStatus(msg, isError) {
    if (!current || !current.statusEl) return;
    current.statusEl.textContent = msg || '';
    current.statusEl.hidden = !msg;
    current.statusEl.classList.toggle('error', !!isError);
  }

  function stop() {
    clearTimeout(retryTimer);
    clearTimeout(audioTimer);
    retryTimer = null;
    audioTimer = null;
    audioWarn = '';
    destroyPvEngine();
    destroySsPlayer();
    if (hls) { hls.destroy(); hls = null; }
    if (current && current.video) {
      const v = current.video;
      v.onplaying = null;
      v.onerror = null;
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    setStatus('');
    current = null;
    if (onTracks) onTracks({ audio: [], subs: [], audioId: -1, subId: -1 });
  }

  // ── Optional local audio helper (tools/audio-helper.py) ───────────────────
  // When running on the user's machine, it transcodes only the audio track to
  // AAC via ffmpeg, fixing Dolby AC-3 silence and unplayable containers.
  const HELPER_BASE = 'http://127.0.0.1:8765';
  let helperOk = null; // null = not probed yet
  async function helperAvailable() {
    if (helperOk !== null) return helperOk;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(HELPER_BASE + '/probe', { signal: ctrl.signal });
      clearTimeout(t);
      const data = await res.json();
      helperOk = !!(data && data.ok && data.ffmpeg);
    } catch {
      helperOk = false;
    }
    return helperOk;
  }
  const helperUrl = (url) => HELPER_BASE + '/play?url=' + encodeURIComponent(url);

  // ── In-browser MKV/codec engine (playsvideo, MIT) ──────────────────────────
  // Remuxes MKV/AVI to fMP4 segment-by-segment and transcodes unsupported
  // audio (AC-3/DTS → AAC) with a small ffmpeg build - fully client-side, so
  // it needs no local helper. Vendored in js/pv (playsvideo 0.4.7, MIT) with
  // its ffmpeg-core assets in js/vendor/ffmpeg-core-audio; loaded lazily.
  // Resolved against the page URL (not this script's folder) so it works at
  // any deploy path.
  // Cache-bust the dynamically imported engine bundles with the same ?v= as
  // this script. They are not referenced from the HTML, so without this the
  // browser can keep serving a STALE cached copy of them across updates.
  const ASSET_V = (() => {
    try {
      const v = new URL(document.currentScript.src, location.href).searchParams.get('v');
      if (v) return v;
    } catch { /* no currentScript (unexpected) */ }
    return String(Date.now());
  })();
  const PV_SRC = new URL('js/pv/playsvideo.js?v=' + ASSET_V, document.baseURI).href;
  const VOD_CONTAINER_RX = /\.(mkv|avi|wmv|flv)(\?|$)/i;
  let pvLibPromise = null;
  let pvEngine = null;
  // Set once we learn this provider refuses the engine's overlapping file
  // reads (strict 1-connection panels): later titles skip the engine and go
  // straight to single-connection mode. Persisted so future sessions start
  // fast; cleared by Change Playlist.
  const STRICT_PANEL_KEY = 'browplayer_strict_panel';
  let pvPanelBlocked = false;
  try { pvPanelBlocked = localStorage.getItem(STRICT_PANEL_KEY) === '1'; } catch { /* storage blocked */ }
  function markPanelStrict() {
    pvPanelBlocked = true;
    try { localStorage.setItem(STRICT_PANEL_KEY, '1'); } catch { /* storage blocked */ }
  }
  function clearPanelStrict() {
    pvPanelBlocked = false;
    try { localStorage.removeItem(STRICT_PANEL_KEY); } catch { /* storage blocked */ }
  }

  function loadPlaysVideoLib() {
    if (!pvLibPromise) {
      pvLibPromise = import(PV_SRC)
        .then(m => (m && m.PlaysVideoEngine) ? m.PlaysVideoEngine : null)
        .catch(() => null);
    }
    return pvLibPromise;
  }

  function destroyPvEngine() {
    if (pvEngine) {
      try { pvEngine.destroy(); } catch { /* already gone */ }
      pvEngine = null;
    }
  }

  // ── Experimental single-open sequential pipeline (js/pv/single-stream.js) ──
  // Exactly ONE HTTP request for the whole playback - for panels that refuse
  // any second connection to a movie file. Forced via ?scs=1 (dev flag) or
  // window.BROWPLAYER_SINGLE_STREAM; otherwise used automatically after the
  // ranged engine hits the strict-panel pattern.
  const SS_SRC = new URL('js/pv/single-stream.js?v=' + ASSET_V, document.baseURI).href;
  const singleStreamForced = () =>
    /[?&]scs=1\b/.test(location.search) || !!window.BROWPLAYER_SINGLE_STREAM;
  let ssPlayer = null;

  function destroySsPlayer() {
    if (ssPlayer) {
      try { ssPlayer.destroy(); } catch { /* already gone */ }
      ssPlayer = null;
    }
  }

  async function trySingleStream() {
    if (!current || current.viaSS || current.viaHelper) return false;
    const me = current;
    current.viaSS = true;
    setStatus('Single-connection mode: streaming the file through one open request…');
    try {
      const mod = await import(SS_SRC);
      if (current !== me) return false;
      destroyPvEngine();
      if (hls) { hls.destroy(); hls = null; }
      destroySsPlayer();
      ssPlayer = new mod.SingleStreamPlayer(current.video, {
        dev: singleStreamForced(),
        onstatus: (ev) => {
          if (current !== me) return;
          const tempStatus = (msg, ms) => {
            setStatus(msg, false);
            setTimeout(() => {
              if (current === me && current.statusEl && current.statusEl.textContent === msg) setStatus('');
            }, ms);
          };
          if (ev.type === 'subtitles') {
            me.ssSubs = ev.tracks;
            if (onTracks) onTracks({ audio: [], subs: ev.tracks, audioId: -1, subId: -1 });
          } else if (ev.type === 'subtitle-selected') {
            // The browser's own CC menu changed the selection - mirror it in
            // the external picker so the two controls always agree.
            if (onTracks) onTracks({ audio: [], subs: me.ssSubs || [], audioId: -1, subId: ev.id });
          } else if (ev.type === 'resuming') {
            setStatus('Connection lost - resuming from ' + Math.floor(ev.at / 60) + ':' + String(Math.floor(ev.at % 60)).padStart(2, '0') + '…');
          } else if (ev.type === 'seeking-remote' || ev.type === 'seek-waiting') {
            setStatus('Seeking - reconnecting to the provider…');
          } else if (ev.type === 'seeked') {
            setStatus('');
          } else if (ev.type === 'seek-failed') {
            tempStatus('Seek failed - the provider refused a new connection. Resumed from the previous position.', 6000);
          } else if (ev.type === 'seek-unavailable') {
            tempStatus('Seeking is unavailable for this stream (size or duration unknown).', 5000);
          } else if (ev.type === 'error') {
            setStatus('Single-connection stream failed: ' + ev.message, true);
          }
        },
      });
      await ssPlayer.load(Bridge.wrap(current.originalUrl));
      current.video.play().catch(() => {});
      if (current.resumeAt > 5 && ssPlayer.canSeekTo(current.resumeAt)) {
        const at = current.resumeAt;
        current.resumeAt = 0;
        ssPlayer.seekTo(Math.max(1, at - 2));
      }
      return 'ok';
    } catch (err) {
      destroySsPlayer();
      const s = String(err && err.message || err);
      if (/\b(458|509)\b/.test(s)) return 'busy';
      if (current === me && /unsupported-codecs/.test(s)) {
        setStatus('This title uses a video codec (' + s.replace(/^.*: /, '') + ') that this browser cannot decode.', true);
        return 'handled';
      }
      return 'fail';
    }
  }

  // Run single-connection mode with proper busy handling: a refused slot goes
  // to the API-polling wait and retries the SINGLE fetch - never the ranged
  // engine. Returns true when the situation is handled.
  async function singleStreamChain() {
    const r = await trySingleStream();
    if (r === 'ok' || r === 'handled') return true;
    if (r === 'busy') {
      if (current) current.viaSS = false; // retry single-stream once the slot frees
      if (scheduleBusyRetry()) return true;
      fail(false, 458);
      return true;
    }
    return false; // 'fail': genuinely could not start
  }

  // Definitive strict-panel handoff: remember the panel, drop the ranged
  // engine, continue with the single-connection pipeline (then helper).
  function enginePanelBlockedHandoff(me) {
    if (current !== me || me.pvErrorHandled) return;
    me.pvErrorHandled = true;
    destroyPvEngine();
    me.pvCorsBlocked = true;
    markPanelStrict();
    (async () => {
      if (await singleStreamChain()) return;
      if (await tryHelperReroute()) return;
      if (current === me) fail(false, 0);
    })();
  }

  // Strict panels refuse the engine's SECOND connection without CORS headers,
  // so that fetch rejects ("Failed to fetch") inside the vendored engine -
  // which can swallow the rejection and stall forever on "Preparing…". The
  // fetch shim announces the final rejection with this event; hearing it
  // while the ranged engine is the active pipeline is the strict-panel
  // signature.
  window.addEventListener('browplayer-fetch-failed', () => {
    if (!current || !current.viaPV || current.viaSS || current.viaHelper) return;
    enginePanelBlockedHandoff(current);
  });

  // Returns 'ok' | 'busy' (provider connection limit) | 'fail'.
  async function tryPlaysVideo() {
    // The ranged engine requires standard MediaSource (absent on iPhone).
    if (!window.MediaSource) return 'fail';
    if (!current || current.viaPV || current.viaHelper || pvPanelBlocked) return 'fail';
    const me = current;
    setStatus('Preparing this file for browser playback…');
    const Engine = await loadPlaysVideoLib();
    if (!Engine || current !== me) return 'fail';
    current.viaPV = true;
    try {
      destroyPvEngine();
      pvEngine = new Engine(current.video);
      // Errors after startup (e.g. the connection slot stolen mid-movie).
      pvEngine.addEventListener('error', (e) => {
        if (current !== me || me.pvErrorHandled) return;
        me.pvErrorHandled = true;
        const msg = String(e?.detail?.message || '');
        destroyPvEngine();
        if (/\b(458|509)\b/.test(msg)) {
          me.viaPV = false; // retry the engine once the slot frees
          me.pvErrorHandled = false;
          if (!scheduleBusyRetry()) fail(false, 458);
        } else if (/access control|not allowed by Access-Control|failed to fetch|\b50[0-4]\b/i.test(msg)) {
          // The strict-panel pattern. Chrome reports CORS-refused fetches as
          // plain "Failed to fetch", Safari mentions access control - either
          // way: don't re-run the ranged engine, remember the panel is strict,
          // and go straight to the single-connection sequential pipeline.
          me.pvCorsBlocked = true;
          markPanelStrict();
          (async () => {
            if (await singleStreamChain()) return;
            if (await tryHelperReroute()) return;
            if (current === me) fail(false, 0);
          })();
        } else {
          (async () => {
            if (pvPanelBlocked && await singleStreamChain()) return;
            if (await tryHelperReroute()) return;
            if (current === me) fail(false, 0);
          })();
        }
      });
      await pvEngine.loadUrl(Bridge.wrap(current.originalUrl));
      if (current !== me) { destroyPvEngine(); return 'fail'; }
      current.video.play().catch(() => {});
      // Watchdog: a stall with nothing buffered this long after startup means
      // the engine's follow-up fetches are being refused (worker-side
      // rejections never surface as events) - hand off instead of hanging.
      setTimeout(() => {
        if (current !== me || !me.viaPV || me.viaSS || me.viaHelper) return;
        const v = me.video;
        if (v.readyState >= 2 || (v.buffered && v.buffered.length > 0)) return;
        enginePanelBlockedHandoff(me);
      }, 15000);
      return 'ok';
    } catch (err) {
      me.pvErrorHandled = true;
      destroyPvEngine();
      const s = String(err || '');
      if (/\b(458|509)\b/.test(s)) return 'busy';
      if (/access control|not allowed by Access-Control|failed to fetch|\b50[0-4]\b/i.test(s)) {
        me.pvCorsBlocked = true;
        markPanelStrict();
      }
      return 'fail';
    }
  }
  const HELPER_HINT = ' Press Restart stream to try again, or use Copy link to open it in a desktop player like VLC.';

  // Reroute the current stream through the local helper (once per stream).
  async function tryHelperReroute() {
    if (!current || current.viaHelper) return false;
    const me = current;
    if (!(await helperAvailable())) return false;
    if (current !== me) return false; // switched streams while probing
    current.viaHelper = true;
    current.triedHlsFallback = true; // helper replaces the panel-HLS fallback
    current.url = helperUrl(current.originalUrl);
    if (hls) { hls.destroy(); hls = null; }
    setStatus('Fixing audio/format through the local helper…');
    retryTimer = setTimeout(() => { if (current) begin(); }, 300);
    return true;
  }

  // Xtream panels can usually serve the same VOD file remuxed as HLS by
  // requesting …/movie/u/p/id.m3u8 instead of id.mkv. When direct playback of
  // a VOD file fails, try that once before giving up.
  function tryVodHlsFallback() {
    if (!current || current.triedHlsFallback) return false;
    const u = current.url;
    if (!/\/(movie|series)\//i.test(u) || /\.m3u8(\?|$)/i.test(u)) return false;
    const m = u.match(/\.([a-z0-9]{2,4})(\?|$)/i);
    current.origExt = m ? m[1].toLowerCase() : '';
    current.triedHlsFallback = true;
    current.url = u.replace(/\.[a-z0-9]{2,4}(\?|$)/i, '.m3u8$1');
    if (hls) { hls.destroy(); hls = null; }
    setStatus('Direct playback failed - trying the provider\'s HLS version…');
    retryTimer = setTimeout(() => { if (current) begin(); }, 400);
    return true;
  }

  // The <video> element hides HTTP status codes (a 458 and a codec failure
  // look identical), so after a native playback error we probe the URL with a
  // 1-byte range request to learn the real status. Returns 0 when unknown.
  async function probeStatus(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(Bridge.wrap(url), {
        headers: { Range: 'bytes=0-0' },
        signal: ctrl.signal,
        cache: 'no-store',
      });
      try { if (res.body) await res.body.cancel(); } catch { /* already closed */ }
      return res.status;
    } catch {
      return 0;
    } finally {
      clearTimeout(timer);
    }
  }

  function fallbackFailedMsg() {
    const ext = current && current.origExt ? '.' + current.origExt : 'this format';
    return `This title (${ext}) uses a container/codec this browser cannot decode, and the provider does not offer a browser-compatible (HLS) version of it. It will play in a desktop app like VLC.`;
  }

  // Progressive retry for the provider's connection limit: the previous
  // stream stays counted server-side for a short while after switching, so
  // spacing the retries out (3s, 8s, 15s) lets the old slot expire.
  const RETRY_DELAYS = [3000, 8000, 15000];

  // Circuit breaker: after the provider refuses a connection (458/509), hold
  // off ALL new stream requests for a cooldown window instead of letting the
  // next channel click hammer the server while the old slot is still counted.
  let busyUntil = 0;
  function markProviderBusy(ms) {
    busyUntil = Math.max(busyUntil, Date.now() + ms);
  }

  // Live connection facts (e.g. "1 of 1 connections in use") appended to busy
  // messages - supplied by the app, which can query the provider's API.
  let busyInfoFn = null;
  function setBusyInfoProvider(fn) { busyInfoFn = fn; }
  function appendBusyInfo() {
    if (!busyInfoFn || !current) return;
    const me = current;
    Promise.resolve().then(busyInfoFn).then(info => {
      if (info && current === me && current.statusEl &&
          /busy|connection/i.test(current.statusEl.textContent || '')) {
        current.statusEl.textContent += ' ' + info;
      }
    }).catch(() => { /* info is best-effort */ });
  }

  // The app can supply a slot checker (Xtream player_api reports active_cons /
  // max_connections). With it, instead of blind timed retries we poll the API
  // - which does not consume a stream slot - and reconnect the moment the
  // provider reports the slot free.
  let slotCheckFn = null;
  function setSlotChecker(fn) { slotCheckFn = fn; }

  function scheduleBusyRetry() {
    if (!current || current.retries <= 0) return false;
    const delay = RETRY_DELAYS[RETRY_DELAYS.length - current.retries] || 8000;
    current.retries--;
    if (hls) { hls.destroy(); hls = null; }

    if (slotCheckFn) {
      markProviderBusy(3000);
      const me = current;
      setStatus('Connection limit reached - waiting for the provider to free the slot…');
      appendBusyInfo();
      (async () => {
        const deadline = Date.now() + 45000;
        while (current === me && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 3500));
          if (current !== me) return;
          try {
            const s = await slotCheckFn();
            if (current !== me) return;
            if (s && s.active < s.max) { begin(); return; }
            if (s) setStatus(`Connection limit: ${s.active} of ${s.max} in use - waiting for it to free…`);
          } catch { /* API hiccup - keep waiting */ }
        }
        if (current === me) begin(); // last attempt after the wait budget
      })();
      return true;
    }

    markProviderBusy(delay);
    setStatus(`Stream busy (connection limit) - retrying in ${Math.round(delay / 1000)}s…`);
    appendBusyInfo();
    retryTimer = setTimeout(() => { if (current) begin(); }, delay);
    return true;
  }

  function fail(networkLikely, httpCode) {
    if (hls) { hls.destroy(); hls = null; }
    let msg;
    if (httpCode === 458 || httpCode === 509) {
      markProviderBusy(15000);
      msg = `The provider refused the stream (HTTP ${httpCode}): the account's connection limit is in use. Close any other IPTV app or tab using this account, wait up to a minute for the provider to drop the previous connection, then press Restart stream.`;
      setStatus(msg, true);
      appendBusyInfo();
      return;
    } else if (httpCode === 401 || httpCode === 403) {
      msg = `The provider rejected this stream (HTTP ${httpCode}). The account may not be authorized for it, or the provider blocks web players.`;
    } else if (current && current.pvCorsBlocked) {
      msg = 'This provider restricts movie playback in a way this session could not work around. Press Restart stream to try again, or use Copy link to open it in a desktop player like VLC.';
    } else if (current && current.triedHlsFallback) {
      msg = fallbackFailedMsg();
    } else if (httpCode === 404) {
      msg = 'Stream not found (HTTP 404). This channel may be offline right now.';
    } else if (networkLikely) {
      msg = 'This stream could not be loaded. The channel may be offline, or the IPTV provider may block browser playback or cross-origin (CORS) requests.';
    } else {
      msg = 'This stream could not be played in the browser.';
    }
    setStatus(msg, true);
  }

  async function begin() {
    const { video, url } = current;

    // Respect the busy cooldown: wait it out without touching the provider,
    // so the lingering previous connection can expire.
    const wait = busyUntil - Date.now();
    if (wait > 500 && !current.viaHelper) {
      const me = current;
      setStatus(`Provider busy - waiting ${Math.ceil(wait / 1000)}s for the previous connection to close…`);
      retryTimer = setTimeout(() => { if (current === me) begin(); }, wait);
      return;
    }

    setStatus('Loading stream…');
    video.onplaying = () => {
      setStatus('');
      // Silent-playback detection: browsers cannot decode Dolby AC-3/E-AC3
      // audio (common on IPTV) and just drop the audio track. Warn the user
      // instead of leaving them wondering.
      clearTimeout(audioTimer);
      audioTimer = setTimeout(async () => {
        if (!current || current.video !== video || video.paused || video.muted) return;
        if (!(video.currentTime > 2)) return; // not actually playing yet
        const decoded = video.webkitAudioDecodedByteCount;
        if (typeof decoded === 'number' && decoded === 0) {
          // Silent playback (usually Dolby AC-3): reroute through the local
          // audio helper automatically when it is running.
          if (!current.viaHelper && await tryHelperReroute()) return;
          const msg = (audioWarn || 'No sound: this stream uses an audio codec (usually Dolby AC-3) that this browser cannot decode.') +
            HELPER_HINT;
          setStatus(msg, false);
          setTimeout(() => {
            if (current && current.statusEl && current.statusEl.textContent === msg) setStatus('');
          }, 15000);
        }
      }, 4000);
    };
    video.onerror = async () => {
      if (!current || !video.error) return;
      const my = current;
      const code = video.error.code; // 2 network, 3 decode, 4 src not supported
      // Decode errors (3) are definitive codec failures; for everything else
      // check the real HTTP status first, since the provider may simply have
      // refused the request (connection limit, offline title, auth).
      let status = 0;
      if (code !== 3) status = await probeStatus(url);
      if (current !== my) return; // user switched streams while probing
      if ((status === 458 || status === 509) && scheduleBusyRetry()) return;
      if (status === 458 || status === 509 || status === 401 || status === 403 || status === 404) {
        fail(false, status);
        return;
      }
      if (tryVodHlsFallback()) return;
      // Codec/container failure: remux/transcode in the browser, else via the
      // local helper.
      if (code !== 2 && (await tryPlaysVideo()) === 'ok') return;
      if (code !== 2 && await tryHelperReroute()) return;
      const ext = (url.match(/\.([a-z0-9]{2,4})(\?|$)/i)?.[1] || '').toLowerCase();
      let msg;
      if (current.pvCorsBlocked) {
        msg = 'This provider restricts movie playback in a way this session could not work around. Press Restart stream to try again, or use Copy link to open it in a desktop player like VLC.';
      } else if (current.viaHelper) {
        msg = 'This stream could not be played even through the local helper. The source may be broken or use a video codec this browser cannot decode.';
      } else if (current.triedHlsFallback) {
        msg = fallbackFailedMsg();
      } else if (code === 2) {
        msg = 'Network error while loading this stream. The provider may be busy (connection limit) or blocking browser access.';
      } else if (['mkv', 'avi', 'wmv', 'flv'].includes(ext)) {
        msg = `This title is a .${ext} file whose container/codec your browser cannot decode.` + HELPER_HINT;
      } else if (code === 3) {
        msg = 'This video uses a codec your browser cannot decode (often HEVC/H.265).' + HELPER_HINT;
      } else {
        msg = 'This stream could not be played in the browser. The format or codec is not supported.' + HELPER_HINT;
      }
      if (hls) { hls.destroy(); hls = null; }
      setStatus(msg, true);
    };

    const isHls = /\.m3u8(\?|$)/i.test(url);

    if (isHls && window.Hls && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        fragLoadingTimeOut: 20000,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 0,
        // When a stream offers several audio renditions, prefer AAC - browsers
        // can always decode it, unlike Dolby AC-3/E-AC-3.
        audioPreference: { audioCodec: 'mp4a.40.2' },
      });
      let recovered = false;
      hls.loadSource(Bridge.wrap(url));
      hls.attachMedia(video);
      hls.on(Hls.Events.BUFFER_CODECS, (_, data) => {
        const codec = data && data.audio && data.audio.codec;
        if (codec && window.MediaSource && !MediaSource.isTypeSupported(`audio/mp4;codecs="${codec}"`)) {
          audioWarn = `No sound: this stream uses ${codec} (Dolby) audio, which this browser cannot decode.`;
          // Fix it right away through the local helper instead of waiting for
          // the silence detector.
          tryHelperReroute();
        }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        notifyTracks();
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, notifyTracks);
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, notifyTracks);
      hls.on(Hls.Events.ERROR, async (_, data) => {
        if (!data.fatal || !current) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
          recovered = true;
          hls.recoverMediaError();
          return;
        }
        const httpCode = data.response && typeof data.response.code === 'number' ? data.response.code : 0;
        if ((httpCode === 458 || httpCode === 509) && scheduleBusyRetry()) return;
        // Unrecoverable media error: the local helper can transcode it.
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && await tryHelperReroute()) return;
        // Manifest loaded but the video segments did not: with IPTV panels this
        // almost always means the channel is offline (they serve a placeholder
        // clip, often on a CDN that also blocks browser access).
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR &&
            data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR && !httpCode) {
          if (hls) { hls.destroy(); hls = null; }
          setStatus('This channel appears to be offline - the provider returned a stream index, but its video segments cannot be loaded (providers serve a placeholder for dead channels). Try another channel or variant.', true);
          return;
        }
        fail(data.type === Hls.ErrorTypes.NETWORK_ERROR, httpCode);
      });
    } else {
      // Containers browsers cannot play natively: remux/transcode them in the
      // browser first (no probe beforehand - the engine's own fetch reports
      // the HTTP status, and an extra request can trip the connection limit).
      if (VOD_CONTAINER_RX.test(url) && !current.viaHelper && !current.viaPV) {
        // Dev flag, known-strict panel, or iPhone Safari (no MediaSource -
        // the ranged engine cannot run, but the single-connection pipeline
        // works through ManagedMediaSource): go straight to single-connection.
        const iosOnlyMMS = !window.MediaSource && !!window.ManagedMediaSource;
        if ((singleStreamForced() || pvPanelBlocked || iosOnlyMMS) && !current.viaSS) {
          if (await singleStreamChain()) return;
          if (singleStreamForced()) {
            setStatus('Single-connection mode could not start this stream.', true);
            return;
          }
          if (await tryHelperReroute()) return;
        }
        const pv = await tryPlaysVideo();
        if (pv === 'ok') return;
        if (pv === 'busy') {
          current.viaPV = false; // retry the engine once the slot frees
          current.pvErrorHandled = false;
          if (scheduleBusyRetry()) return;
          fail(false, 458);
          return;
        }
        // Ranged engine failed on a strict panel: try the single-connection
        // sequential pipeline before the helper.
        if (current.pvCorsBlocked || pvPanelBlocked) {
          if (await singleStreamChain()) return;
        }
        if (await tryHelperReroute()) return;
      }
      // Native HLS (Safari) or direct MP4/MP3/AAC playback.
      // Preflight with a 1-byte request first: browsers fire many internal
      // retries against a refusing URL (hammering the provider's connection
      // tracker), so catch HTTP refusals before the video element sees it.
      if (!current.viaHelper && /^https?:/i.test(url)) {
        const me = current;
        const status = await probeStatus(url);
        if (current !== me) return;
        if ((status === 458 || status === 509) && scheduleBusyRetry()) return;
        if (status === 458 || status === 509 || status === 401 || status === 403 || status === 404) {
          fail(false, status);
          return;
        }
      }
      video.src = Bridge.wrap(url);
      video.load();
      video.play().catch(() => {});
    }
  }

  async function play(videoEl, statEl, rawUrl, opts) {
    stop();
    if (!Playlist.isSafeHttpUrl(rawUrl)) {
      current = { video: videoEl, statusEl: statEl, url: '', retries: 0 };
      setStatus('This stream has an unsupported URL and was blocked.', true);
      return;
    }
    current = { video: videoEl, statusEl: statEl, url: rawUrl, originalUrl: rawUrl, retries: RETRY_DELAYS.length, triedHlsFallback: false, viaHelper: false, viaPV: false, viaSS: false, pvRetries: 2, pvErrorHandled: false, origExt: '', resumeAt: (opts && opts.resumeAt) || 0 };
    const m = rawUrl.match(VOD_CONTAINER_RX);
    if (m) current.origExt = m[1].toLowerCase();
    begin();
  }

  // Restart the current stream from scratch (fresh retries and fallbacks)
  // without touching the rest of the app.
  function restart() {
    if (!current) return false;
    const { video, statusEl, originalUrl } = current;
    let resumeAt = 0;
    try { resumeAt = video.currentTime || 0; } catch { /* detached */ }
    play(video, statusEl, originalUrl, { resumeAt });
    return true;
  }

  function setAudioTrack(id) { if (hls) hls.audioTrack = id; }
  function setSubtitleTrack(id) {
    if (current && current.viaSS && ssPlayer) {
      // The <video> accumulates text tracks from every playback (they cannot
      // be removed), so the player instance maps the id to its own tracks.
      ssPlayer.setSubtitleTrack(id);
      return;
    }
    if (!hls) return;
    hls.subtitleTrack = id;
    hls.subtitleDisplay = id >= 0;
  }
  function setTrackListener(fn) { onTracks = fn; }

  const currentUrl = () => (current ? current.originalUrl : '');

  return { play, stop, restart, setAudioTrack, setSubtitleTrack, setTrackListener, currentUrl, setBusyInfoProvider, setSlotChecker, clearPanelStrict };
})();
