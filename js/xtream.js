/*
 * Diamond Operatore Player (diaop.de) - Xtream Codes API client.
 * Licensed under the GNU GPL v3.0 - https://www.gnu.org/licenses/gpl-3.0.html
 *
 * Credentials live only in JavaScript memory for the current tab.
 * They are never persisted, logged, or sent anywhere except the provider.
 */
'use strict';

const Xtream = (() => {
  const TIMEOUT_MS = 20000;
  const enc = encodeURIComponent;

  // If the pasted URL looks like an Xtream-style M3U link
  // (…/get.php?username=U&password=P&…), extract server/username/password.
  function detect(raw) {
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const username = u.searchParams.get('username');
    const password = u.searchParams.get('password');
    if (!username || !password) return null;
    // Server base = origin + path with the final file segment removed
    // (handles both /get.php and /some/prefix/get.php).
    const basePath = u.pathname.replace(/\/[^/]*$/, '').replace(/\/+$/, '');
    return { server: u.origin + basePath, username, password };
  }

  // ── Tolerant JSON parsing ──────────────────────────────────────────────────
  // Panels routinely break their own JSON on the huge VOD/series dumps: PHP
  // notices or HTML get printed around the payload, or the connection drops
  // mid-array leaving it unterminated. Rather than losing the whole catalogue,
  // salvage whatever is structurally complete.
  function salvageJson(text) {
    const start = text.search(/[[{]/);
    if (start < 0) return null;
    const body = text.slice(start);

    // Junk printed after the payload (PHP warnings, HTML, stray bytes).
    const lastClose = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
    if (lastClose > 0) {
      try { return JSON.parse(body.slice(0, lastClose + 1)); } catch { /* keep trying */ }
    }

    // Truncated array: keep every element that arrived complete and close it.
    if (body[0] === '[') {
      for (let cut = body.lastIndexOf('},'); cut > 0; cut = body.lastIndexOf('},', cut - 1)) {
        try { return JSON.parse(body.slice(0, cut + 1) + ']'); } catch { /* try an earlier element */ }
      }
    }
    return null;
  }

  // Turns a parse failure into something actionable: where it broke and what
  // the payload actually looked like there.
  function describeParseFailure(text, err) {
    const mb = (text.length / 1048576).toFixed(1);
    const pos = Number((/position (\d+)/.exec(err && err.message) || [])[1]);
    let where = '';
    if (Number.isFinite(pos)) {
      const snippet = text.slice(Math.max(0, pos - 40), pos + 40).replace(/\s+/g, ' ');
      where = ' Broke at byte ' + pos + ' of ' + text.length + ' near: "' + snippet + '".';
    } else {
      where = ' Response started with: "' + text.slice(0, 80).replace(/\s+/g, ' ') + '".';
    }
    return 'The provider sent ' + mb + ' MB of invalid JSON.' + where;
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (err) {
      const salvaged = salvageJson(text);
      if (salvaged !== null) return salvaged;
      throw new Error(describeParseFailure(text, err));
    }
  }

  // Reads the body while reporting progress, so the caller's watchdog can tell
  // "still downloading" from "stalled". Falls back to res.text() where the
  // streaming body is unavailable.
  async function readBody(res, onProgress) {
    if (!res.body || typeof res.body.getReader !== 'function') return res.text();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      onProgress(out.length);
    }
    return out + decoder.decode();
  }

  // The watchdog is an INACTIVITY timeout, not a total one: get_vod_streams and
  // get_series routinely return tens of megabytes and can legitimately take
  // minutes on a busy panel, so aborting on total elapsed time killed downloads
  // that were still progressing. The timer restarts on every received chunk,
  // so only a genuinely stalled connection is cut off.
  async function call(creds, action, extra, opts) {
    const idleMs = (opts && opts.idleMs) || TIMEOUT_MS;
    const onProgress = opts && opts.onProgress;
    const qs = new URLSearchParams({ username: creds.username, password: creds.password });
    if (action) qs.set('action', action);
    if (extra) for (const [k, v] of Object.entries(extra)) qs.set(k, String(v));
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(), idleMs);
    const bump = (bytes) => {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), idleMs);
      if (onProgress) onProgress(bytes);
    };
    try {
      const apiUrl = `${creds.server}/player_api.php?${qs}`;
      // Through the local bridge when the page is https and the panel http.
      const res = await fetch(typeof Bridge !== 'undefined' ? Bridge.wrapFetch(apiUrl) : apiUrl,
        { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error('The provider answered HTTP ' + res.status + '.');
      const text = await readBody(res, bump);
      if (!text.trim()) throw new Error('The provider returned an empty response.');
      return parseJson(text);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('The provider stopped responding (no data for ' +
          Math.round(idleMs / 1000) + 's).');
      }
      if (err instanceof TypeError) {
        // fetch() rejects with TypeError for network-level failures: DNS, TLS,
        // a blocked mixed-content request, or a missing CORS header.
        throw new Error('The provider could not be reached from the browser ' +
          '(network error, or it blocks browser access with CORS).');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function authenticate(creds) {
    const data = await call(creds, '');
    const info = data && data.user_info;
    if (!info || Number(info.auth) !== 1) throw new Error('auth-failed');
    return info;
  }

  const liveUrl = (c, id) => `${c.server}/live/${enc(c.username)}/${enc(c.password)}/${id}.m3u8`;
  const movieUrl = (c, id, ext) => `${c.server}/movie/${enc(c.username)}/${enc(c.password)}/${id}.${ext || 'mp4'}`;
  const episodeUrl = (c, id, ext) => `${c.server}/series/${enc(c.username)}/${enc(c.password)}/${id}.${ext || 'mp4'}`;

  return { detect, call, authenticate, liveUrl, movieUrl, episodeUrl };
})();
