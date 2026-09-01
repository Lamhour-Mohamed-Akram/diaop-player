/*
 * Diamond Operatore Player (diaop.de) - local HTTPS bridge client.
 * Licensed under the GNU GPL v3.0 - https://www.gnu.org/licenses/gpl-3.0.html
 *
 * An HTTPS page is forbidden from loading plain-HTTP content (mixed content),
 * with one deliberate exception: 127.0.0.1 is a trustworthy origin. The
 * optional local helper (tools/audio-helper.py) uses that exception to relay
 * HTTP providers through the user's OWN machine - never a third party. This
 * module decides when the bridge is needed and rewrites URLs through it.
 */
'use strict';

const Bridge = (() => {
  const BASE = 'http://127.0.0.1:8765';
  let active = false;

  // The bridge is only ever needed when the page itself is HTTPS (or when
  // forced with ?bridge=1 for testing).
  const needed = (url) =>
    (location.protocol === 'https:' || /[?&]bridge=1\b/.test(location.search)) &&
    /^http:\/\//i.test(url || '');

  async function probe() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(BASE + '/probe', { signal: ctrl.signal });
      clearTimeout(t);
      const data = await res.json();
      return !!(data && data.ok && data.bridge);
    } catch {
      return false;
    }
  }

  function enable() { active = true; }
  const isActive = () => active;

  // Rewrite a provider URL through the bridge. HLS manifests go through /hls
  // (which rewrites their segment URIs too); everything else through /raw.
  const wrappable = (url) =>
    active && /^http:\/\//i.test(url || '') && !String(url).startsWith(BASE);

  function wrap(url) {
    if (!wrappable(url)) return url;
    const ep = /\.m3u8(\?|$)/i.test(url.split('#')[0]) ? '/hls' : '/raw';
    return BASE + ep + '?url=' + encodeURIComponent(url);
  }

  // For playlist/API text fetches (get.php, player_api.php, .m3u files).
  function wrapFetch(url) {
    if (!wrappable(url)) return url;
    return BASE + '/fetch?url=' + encodeURIComponent(url);
  }

  return { needed, probe, enable, isActive, wrap, wrapFetch };
})();
