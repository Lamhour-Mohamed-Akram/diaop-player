/*
 * Diamond Operatore Player (diaop.de) - M3U parsing, content classification and series grouping.
 * Licensed under the GNU GPL v3.0 - https://www.gnu.org/licenses/gpl-3.0.html
 *
 * Everything runs client-side. Playlist content is treated as untrusted input:
 * items are only ever rendered through textContent / DOM APIs, and stream URLs
 * are restricted to http(s).
 */
'use strict';

const Playlist = (() => {

  // ── Classification rules ───────────────────────────────────────────────────
  // Centralized and easy to extend. Keywords cover common EN/FR/AR/DE/ES
  // variants. Rules are checked in order; anything uncertain stays Live TV.
  const RADIO_RX = /(\bradios?\b|\bfm\b|راديو|إذاعة|اذاعة)/i;
  const SERIES_RX = /(\bs[ée]ri(e|es|en)\b|\bseriale\b|\bshows?\b|\btv ?shows?\b|\bepisod|\bdizi\b|\bnovelas?\b|مسلسل|مسلسلات)/i;
  const MOVIES_RX = /(\bmovies?\b|\bvod\b|\bfilms?\b|\bfilme\b|\bcin[ée]ma\b|\bcine\b|\bkino\b|\bpel[ií]culas?\b|\baflam\b|فيلم|افلام|أفلام)/i;
  const VOD_FILE_RX = /\.(mp4|mkv|avi|mov|wmv|flv|webm)(\?|$)/i;

  // Conservative "Series S01E02"-style matcher (also SxxEPxx, "Season 1 Episode 2",
  // "Staffel 1", "Saison 1"). Requires explicit S/E markers so plain years or
  // numbers never match.
  const SE_RX = /^(.*?)[\s._|-]*\bS(?:eason|aison|taffel)?\s*(\d{1,2})\s*[\s._|-]*E(?:p(?:isode)?)?\s*(\d{1,4})\b/i;

  function isRadioGroup(group) {
    return RADIO_RX.test(group || '');
  }

  // Returns 'live' | 'movies' | 'series' | 'radio'
  function classify(item) {
    if (item.radioAttr || RADIO_RX.test(item.group)) return 'radio';
    // Xtream-generated M3U links carry the type in the URL path - strongest hint.
    if (/\/movie\//i.test(item.url)) return 'movies';
    if (/\/series\//i.test(item.url)) return 'series';
    if (SERIES_RX.test(item.group)) return 'series';
    if (MOVIES_RX.test(item.group)) return 'movies';
    if (SE_RX.test(item.name)) return 'series';
    if (VOD_FILE_RX.test(item.url)) return 'movies';
    return 'live';
  }

  // ── URL safety ─────────────────────────────────────────────────────────────
  function isSafeHttpUrl(raw) {
    try {
      const u = new URL(raw);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  // ── M3U parser ─────────────────────────────────────────────────────────────
  // Line-state machine over the playlist text: an #EXTINF directive stores the
  // pending entry metadata (all key="value" attributes collected in one pass),
  // and the next non-directive line is taken as its stream URL. Bare URLs
  // without a preceding #EXTINF are kept too. Parsed once per load.
  function parse(text) {
    const items = [];
    let sawHeader = false;
    let meta = null; // { attrs, display } from the most recent #EXTINF

    for (const rawLine of String(text).split(/\r?\n|\r/)) {
      const line = rawLine.trim();
      if (!line) continue;

      if (!sawHeader) {
        if (line.replace(/^﻿/, '').startsWith('#EXTM3U')) { sawHeader = true; continue; }
        return []; // not an M3U playlist
      }

      if (line.startsWith('#EXTINF')) {
        const comma = line.lastIndexOf(',');
        const head = comma === -1 ? line : line.slice(0, comma);
        const attrs = {};
        const attrRx = /([\w-]+)="([^"]*)"/g;
        for (let m; (m = attrRx.exec(head)) !== null;) attrs[m[1].toLowerCase()] = m[2];
        meta = { attrs, display: comma === -1 ? '' : line.slice(comma + 1).trim() };
        continue;
      }
      if (line[0] === '#') continue; // other directives are ignored

      // Stream URL line
      if (!isSafeHttpUrl(line)) { meta = null; continue; }
      const a = meta ? meta.attrs : {};
      items.push({
        id: 'm' + items.length,
        url: line,
        tvgId: a['tvg-id'] || '',
        name: a['tvg-name'] || (meta && meta.display) || line,
        logo: a['tvg-logo'] || '',
        group: a['group-title'] || 'Uncategorized',
        radioAttr: String(a.radio || '').toLowerCase() === 'true',
      });
      meta = null;
    }
    return items;
  }

  // ── Series grouping (plain M3U mode) ───────────────────────────────────────
  // Groups items whose names reliably match SxxEyy patterns; anything that
  // cannot be grouped is returned in `singles` so no content is ever lost.
  function groupSeries(items) {
    const map = new Map();
    const singles = [];

    for (const it of items) {
      const m = it.name.match(SE_RX);
      const base = m ? m[1].replace(/[\s._|-]+$/, '').trim() : '';
      if (!m || !base) { singles.push(it); continue; }

      const key = base.toLowerCase();
      let s = map.get(key);
      if (!s) {
        s = { id: 'sg' + map.size, name: base, logo: it.logo, group: it.group, seasons: new Map(), episodeCount: 0 };
        map.set(key, s);
      }
      if (!s.logo && it.logo) s.logo = it.logo;
      const season = parseInt(m[2], 10) || 0;
      const episode = parseInt(m[3], 10) || 0;
      if (!s.seasons.has(season)) s.seasons.set(season, []);
      s.seasons.get(season).push({ name: it.name, episode, url: it.url });
      s.episodeCount++;
    }

    for (const s of map.values()) {
      for (const eps of s.seasons.values()) eps.sort((a, b) => a.episode - b.episode);
    }
    return { grouped: [...map.values()], singles };
  }

  // True when the text is an HLS stream manifest (master or media playlist)
  // rather than an IPTV channel playlist.
  function isHlsManifest(text) {
    return /#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)/.test(String(text).slice(0, 8000));
  }

  // Heuristic for URLs that look like a direct stream (used when the playlist
  // fetch itself is CORS-blocked but playback might still work).
  function looksLikeStream(url) {
    return /\.(m3u8|ts|mp4|mp3|aac|mkv)(\?|$)/i.test(url) && !/\.(m3u)(\?|$)/i.test(url);
  }

  return { parse, classify, groupSeries, isRadioGroup, isSafeHttpUrl, isHlsManifest, looksLikeStream };
})();
