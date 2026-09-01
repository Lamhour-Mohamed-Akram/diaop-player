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

  async function call(creds, action, extra) {
    const qs = new URLSearchParams({ username: creds.username, password: creds.password });
    if (action) qs.set('action', action);
    if (extra) for (const [k, v] of Object.entries(extra)) qs.set(k, String(v));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const apiUrl = `${creds.server}/player_api.php?${qs}`;
      // Through the local bridge when the page is https and the panel http.
      const res = await fetch(typeof Bridge !== 'undefined' ? Bridge.wrapFetch(apiUrl) : apiUrl,
        { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
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
