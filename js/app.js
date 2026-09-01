/*
 * Diamond Operatore Player (diaop.de) - application shell: state, SPA navigation and rendering.
 * Licensed under the GNU GPL v3.0 - https://www.gnu.org/licenses/gpl-3.0.html
 *
 * All parsed playlist data is in-memory only. The one thing persisted is the
 * playlist URL itself (localStorage, this browser only) so a refresh
 * reconnects automatically; "Change Playlist" removes it. Nothing is ever
 * sent anywhere except the provider, and IPTV URLs (which may contain
 * credentials) are never logged.
 */
'use strict';

(() => {

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString();
const PAGE_SIZE = 100;
const GRID_PAGE_SIZE = 60;

const SECTION_DEFS = {
  live:   { label: 'Live TV', icon: '📺' },
  movies: { label: 'Movies',  icon: '🎬' },
  series: { label: 'Series',  icon: '🎞' },
  radio:  { label: 'Radio',   icon: '📻' },
};
const SECTION_ORDER = ['live', 'movies', 'series', 'radio'];

const state = {
  mode: null,          // 'xtream' | 'm3u' | 'direct'
  creds: null,         // Xtream credentials (memory only)
  account: null,       // Xtream user_info (expiry etc.)
  sections: {},        // key -> { loaded, items, cats, catMap?, catCount? }
  section: null,       // current section key
  category: 'all',     // 'all' or 'g:<group name>'
  search: '',
  activeId: null,      // currently playing live/radio item id
  detail: null,        // item shown on the detail screen
  playerBack: null,    // screen to return to from the VOD player
  screen: 'screen-connect',
  dataUpdatedAt: null, // when the playlist data was last fetched from the provider
};

const isMobile = () => window.matchMedia('(max-width: 800px)').matches;

// ── Remembered playlist URL ──────────────────────────────────────────────────
// The playlist URL survives refresh until "Change Playlist" is pressed.
// Guarded with try/catch for private-browsing modes that block storage.
const STORAGE_KEY = 'browplayer_url';

// The same app served over plain HTTP, on a dedicated subdomain that can
// NEVER have https: a CAA DNS record forbids all certificate authorities
// from issuing for it. This matters because modern browsers silently upgrade
// http:// navigations to https:// when an https version exists - with no
// https possible, the upgrade fails and the browser falls back to plain
// http, which is exactly what HTTP-only IPTV providers need (mixed content).
// The HTTPS site hops here automatically - zero user action.
const HTTP_MIRROR = 'http://watch.diaop.de/';
function saveUrl(url) { try { localStorage.setItem(STORAGE_KEY, url); } catch { /* storage blocked */ } }
function clearSavedUrl() { try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage blocked */ } }
function savedUrl() { try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; } }

// ── Cached playlist data (IndexedDB) ─────────────────────────────────────────
// The parsed playlist is cached so a reload restores instantly instead of
// refetching everything from the provider. It is refreshed by the dashboard's
// "Update playlist data" button (or automatically when older than a day) and
// deleted by "Change Playlist".
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DB = (() => {
  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('browplayer', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function tx(mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction('kv', mode);
      const out = fn(t.objectStore('kv'));
      t.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : undefined); };
      t.onerror = () => { db.close(); reject(t.error); };
    }));
  }
  return {
    get: (key) => tx('readonly', s => s.get(key)),
    set: (key, val) => tx('readwrite', s => s.put(val, key)),
    del: (key) => tx('readwrite', s => s.delete(key)),
  };
})();

function saveCache() {
  if (state.mode !== 'xtream' && state.mode !== 'm3u') return;
  state.dataUpdatedAt = Date.now();
  DB.set('cache', {
    url: savedUrl(),
    mode: state.mode,
    creds: state.creds,
    account: state.account,
    sections: state.sections,
    savedAt: state.dataUpdatedAt,
  }).catch(() => { /* cache unavailable; app still works from memory */ });
}

// ── Toasts ───────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  }, duration);
}

// ── Screens & top bar ────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  state.screen = id;
  updateTopbar();
}

function updateTopbar() {
  const connected = !!state.mode && state.screen !== 'screen-connect';
  $('topbar').hidden = !connected;
  $('btnHome').disabled = state.mode === 'direct';
  $('btnBack').hidden = state.mode === 'direct' || state.screen === 'screen-dashboard';

  const searchable = state.screen === 'screen-browse' || state.screen === 'screen-grid';
  $('searchWrap').hidden = !searchable;

  let title = '';
  if (state.screen === 'screen-browse' || state.screen === 'screen-grid') {
    title = SECTION_DEFS[state.section]?.label || '';
  } else if (state.screen === 'screen-detail') {
    title = state.detail?.name || '';
  }
  $('topTitle').textContent = title;
}

// ── Connect screen ───────────────────────────────────────────────────────────
function setConnectBusy(busy, msg) {
  $('loadBtn').disabled = busy;
  $('urlInput').disabled = busy;
  const st = $('connectStatus');
  st.classList.remove('error', 'notice');
  if (busy) {
    st.hidden = false;
    st.textContent = '';
    const spin = document.createElement('span');
    spin.className = 'spinner';
    st.append(spin, msg || 'Loading…');
  } else if (msg === undefined) {
    st.hidden = true;
  }
}

function connectError(msg) {
  setConnectBusy(false, null);
  const st = $('connectStatus');
  st.hidden = false;
  st.classList.add('error');
  st.textContent = msg + ' ';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn small';
  retry.textContent = 'Retry';
  retry.onclick = () => connect($('urlInput').value);
  st.appendChild(retry);
}

// ── HTTP-edition hand-off notice ─────────────────────────────────────────────
// Before the FIRST hop to the plain-HTTP edition, pause and explain the
// switch: http-only providers cannot be loaded from an https page (mixed
// content), so playback continues on the HTTP edition - the exact same app,
// nothing else changes. Once the notice has been seen (or the hop taken),
// later hops are instant again, keeping the zero-action flow.
const HTTP_NOTICE_KEY = 'browplayer_http_notice_seen';
let httpNoticeTimer = 0;

function hopToHttpEdition(url) {
  try { localStorage.setItem(HTTP_NOTICE_KEY, '1'); } catch { /* storage blocked */ }
  setConnectBusy(true, 'Switching to the HTTP edition…');
  location.href = HTTP_MIRROR + '#u=' + encodeURIComponent(url);
}

function offerHttpEdition(url) {
  let seen = false;
  try { seen = !!localStorage.getItem(HTTP_NOTICE_KEY); } catch { /* storage blocked */ }
  if (seen) { hopToHttpEdition(url); return; }

  setConnectBusy(false, null);
  const st = $('connectStatus');
  st.hidden = false;
  st.classList.add('notice');
  st.textContent = '';

  const mirrorHost = new URL(HTTP_MIRROR).host;
  const p1 = document.createElement('p');
  p1.textContent = 'Your playlist uses http:// (not https). Browsers forbid this secure page from ' +
    'talking to http-only providers, so the player continues on its HTTP edition: ' + mirrorHost + '.';
  const p2 = document.createElement('p');
  p2.textContent = 'It is the exact same app and nothing else changes - same features, and your ' +
    'playlist URL still stays only in your browser. The address bar there will say "Not secure" ' +
    'simply because your provider only speaks plain http.';

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'btn accent small';
  go.textContent = 'Continue to ' + mirrorHost;
  go.onclick = () => { clearInterval(httpNoticeTimer); hopToHttpEdition(url); };

  const stay = document.createElement('button');
  stay.type = 'button';
  stay.className = 'btn small';
  stay.textContent = 'Cancel';
  stay.onclick = () => {
    clearInterval(httpNoticeTimer);
    st.hidden = true;
    st.classList.remove('notice');
  };

  const count = document.createElement('p');
  count.className = 'countdown muted';
  let secs = 12;
  count.textContent = `Continuing automatically in ${secs}s…`;
  clearInterval(httpNoticeTimer);
  httpNoticeTimer = setInterval(() => {
    secs -= 1;
    if (secs <= 0) { clearInterval(httpNoticeTimer); hopToHttpEdition(url); }
    else count.textContent = `Continuing automatically in ${secs}s…`;
  }, 1000);

  const row = document.createElement('div');
  row.className = 'notice-actions';
  row.append(go, stay);
  st.append(p1, p2, row, count);
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(Bridge.wrapFetch(url), { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function connect(raw) {
  clearInterval(httpNoticeTimer); // a pending hand-off countdown must not fire with a stale URL
  let url = (raw || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    connectError('Enter a valid URL starting with http:// or https://.');
    return;
  }

  setConnectBusy(true, 'Checking URL…');

  // Mixed content: a page served over HTTPS is forbidden by the browser from
  // loading anything over plain HTTP. In order: (1) try the provider over
  // https (some panels support both), (2) use the local bridge helper
  // (127.0.0.1 is exempt from the mixed-content rule), (3) explain honestly.
  if (Bridge.needed(url)) {
    const httpsUrl = url.replace(/^http:\/\//i, 'https://');
    setConnectBusy(true, 'Provider uses http - checking if it also supports https…');
    let upgraded = false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      await fetch(httpsUrl, { method: 'HEAD', mode: 'no-cors', signal: ctrl.signal });
      clearTimeout(t);
      upgraded = true; // reachable over https - use it for everything
    } catch { /* provider has no https */ }
    if (upgraded) {
      url = httpsUrl;
    } else {
      setConnectBusy(true, 'Provider is http-only - adapting…');
      // The ?bridge=1 relay exists for the test harness only - the web flow
      // never asks anyone to install or run anything.
      if (/[?&]bridge=1\b/.test(location.search) && await Bridge.probe()) {
        Bridge.enable();
      } else if (location.protocol === 'https:' && location.host !== new URL(HTTP_MIRROR).host) {
        // Fallback: hop to the plain-HTTP edition of this same app, carrying
        // the playlist URL in the #fragment (fragments never leave the
        // browser, so credentials are not sent to any server). The http
        // edition auto-connects on arrival. Guarded against loops: never hop
        // when we are already on the mirror host. The first hop shows a short
        // explanatory notice; after that the switch is instant again.
        offerHttpEdition(url);
        return;
      } else if (location.protocol === 'https:') {
        connectError('The browser forced this page onto HTTPS, where an http-only provider cannot load. ' +
          'Open ' + HTTP_MIRROR + ' and load the playlist there.');
        return;
      } else {
        connectError('This provider could not be reached over plain HTTP or HTTPS. ' +
          'It may be offline, or it may block browser access.');
        return;
      }
    }
  }

  // 1) Xtream-style URL? Try the richer player_api first.
  const creds = Xtream.detect(url);
  if (creds) {
    setConnectBusy(true, 'Connecting to provider…');
    if (await tryXtream(creds)) {
      saveUrl(url);
      saveCache();
      setConnectBusy(false);
      enterDashboard();
      return;
    }
    // API not available - fall back to fetching the M3U itself.
  }

  // 2) Fetch the URL as text (playlist or stream manifest).
  setConnectBusy(true, 'Fetching playlist…');
  let text = null;
  try {
    text = await fetchText(url);
  } catch {
    if (Playlist.looksLikeStream(url)) {
      // Could not read it (likely CORS), but it looks like a direct stream -
      // hand it to the player, which may still be able to play it.
      saveUrl(url);
      setConnectBusy(false);
      enterDirect(url);
      return;
    }
    connectError('Playlist could not be loaded. This provider may not allow this resource to be accessed directly from a web browser (CORS), or the URL is unreachable.');
    return;
  }

  // 3) Direct HLS stream manifest → open the player directly.
  if (Playlist.isHlsManifest(text)) {
    saveUrl(url);
    setConnectBusy(false);
    enterDirect(url);
    return;
  }

  // 4) Parse as an M3U channel playlist.
  const items = Playlist.parse(text);
  if (!items.length) {
    connectError('No playable entries were found - this does not look like a valid M3U playlist.');
    return;
  }
  buildM3uSections(items);
  if (!Object.keys(state.sections).length) {
    connectError('The playlist was parsed but contained no playable entries.');
    return;
  }
  state.mode = 'm3u';
  saveUrl(url);
  saveCache();
  setConnectBusy(false);
  enterDashboard();
}

// ── Xtream mode ──────────────────────────────────────────────────────────────
async function tryXtream(creds) {
  try {
    const account = await Xtream.authenticate(creds);
    setConnectBusy(true, 'Loading channel list…');
    const [liveCats, vodCats, serCats, liveStreams] = await Promise.all([
      Xtream.call(creds, 'get_live_categories').catch(() => []),
      Xtream.call(creds, 'get_vod_categories').catch(() => []),
      Xtream.call(creds, 'get_series_categories').catch(() => []),
      Xtream.call(creds, 'get_live_streams').catch(() => null),
    ]);
    state.creds = creds;
    state.account = account;
    state.mode = 'xtream';
    buildXtreamSections(liveCats, vodCats, serCats, liveStreams);
    return true;
  } catch {
    return false;
  }
}

function catNameMap(cats) {
  const m = new Map();
  (Array.isArray(cats) ? cats : []).forEach(c => {
    m.set(String(c.category_id), String(c.category_name || 'Unknown'));
  });
  return m;
}

// Builds { loaded, items, cats } - category order follows the provider order
// when a category map is given, otherwise first appearance in the item list.
function makeSection(items, orderMap) {
  const counts = new Map();
  for (const it of items) counts.set(it.group, (counts.get(it.group) || 0) + 1);
  const names = [];
  if (orderMap) {
    for (const n of new Set(orderMap.values())) if (counts.has(n)) names.push(n);
  }
  for (const n of counts.keys()) if (!names.includes(n)) names.push(n);
  return { loaded: true, items, cats: names.map(n => ({ name: n, count: counts.get(n) })) };
}

function normalizeLiveStreams(streams, liveMap) {
  const live = [], radio = [];
  for (const s of streams) {
    const group = liveMap.get(String(s.category_id)) || 'Uncategorized';
    const item = {
      id: 'L' + s.stream_id,
      name: String(s.name || 'Unknown'),
      logo: s.stream_icon || '',
      group,
      url: Xtream.liveUrl(state.creds, s.stream_id),
    };
    const isRadio = /radio/i.test(String(s.stream_type || '')) || Playlist.isRadioGroup(group);
    (isRadio ? radio : live).push(item);
  }
  return { live, radio };
}

function buildXtreamSections(liveCats, vodCats, serCats, liveStreams) {
  state.sections = {};
  const liveMap = catNameMap(liveCats);

  if (Array.isArray(liveStreams)) {
    const { live, radio } = normalizeLiveStreams(liveStreams, liveMap);
    if (live.length) state.sections.live = makeSection(live, liveMap);
    if (radio.length) state.sections.radio = makeSection(radio, null);
  } else if (liveMap.size) {
    // Stream list failed but categories exist - load lazily on open.
    state.sections.live = { loaded: false, catMap: liveMap, catCount: liveMap.size };
  }

  const vodMap = catNameMap(vodCats);
  if (vodMap.size) state.sections.movies = { loaded: false, catMap: vodMap, catCount: vodMap.size };

  const serMap = catNameMap(serCats);
  if (serMap.size) state.sections.series = { loaded: false, catMap: serMap, catCount: serMap.size };
}

// Movies and Series are the two heaviest player_api responses (often tens of
// megabytes), so they get a generous inactivity budget - see Xtream.call.
const SECTION_IDLE_MS = 90000;

// One shared promise per section: opening Movies, going Back and opening it
// again must not start a second multi-megabyte download - providers that cap
// concurrent API requests fail both when that happens.
const sectionLoads = new Map();

// Progress goes through this registry so whichever UI is currently watching
// receives it: a download started silently in the background keeps reporting
// into the loading screen the moment the user opens that section.
const sectionReporters = new Map(); // key -> { bytes, status }
function reporterFor(key) {
  return {
    bytes: (n) => { const r = sectionReporters.get(key); if (r) r.bytes(n); },
    status: (m) => { const r = sectionReporters.get(key); if (r) r.status(m); },
  };
}

// Lazily fetch Xtream section contents on first open (M3U sections are always
// already loaded).
function ensureSection(key) {
  const sec = state.sections[key];
  if (!sec || sec.loaded) return Promise.resolve(sec);
  let p = sectionLoads.get(key);
  if (!p) {
    p = loadSection(key, sec, reporterFor(key)).finally(() => sectionLoads.delete(key));
    sectionLoads.set(key, p);
  }
  return p;
}

// Preload Movies and Series in the background as soon as the dashboard
// appears, so opening them later is as instant as Live TV (whose list is
// fetched during connect). Sequential on purpose: two multi-megabyte dumps at
// once trip providers that cap concurrent API requests.
function prefetchHeavySections() {
  if (state.mode !== 'xtream') return;
  (async () => {
    let loadedAny = false;
    for (const key of ['movies', 'series']) {
      const sec = state.sections[key];
      if (!sec || sec.loaded) continue;
      try {
        await ensureSection(key);
        loadedAny = true;
      } catch { /* opening the section shows the error and offers Retry */ }
    }
    // Refresh the tiles ("N categories" becomes "N items") if still visible.
    if (loadedAny && state.screen === 'screen-dashboard') enterDashboard();
  })();
}

// Fetches a full list, falling back to one request per category when the
// single monolithic dump fails. Big panels often cannot emit a valid
// multi-megabyte VOD payload in one go (truncated, or with PHP notices printed
// into it) yet answer per-category requests perfectly.
async function fetchList(action, sec, report) {
  const opts = { idleMs: SECTION_IDLE_MS, onProgress: report.bytes };
  let firstErr = null;
  try {
    const data = await Xtream.call(state.creds, action, null, opts);
    if (Array.isArray(data)) return data;
    firstErr = new Error(providerListError(data));
  } catch (err) {
    firstErr = err;
  }

  const ids = sec.catMap ? [...sec.catMap.keys()] : [];
  if (!ids.length) throw firstErr;

  // One request per category, three in parallel: hundreds of categories at
  // one-at-a-time took minutes, while a small pool stays gentle on panels
  // that throttle their API.
  const parts = new Array(ids.length);
  let next = 0, done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= ids.length) return;
      try {
        const part = await Xtream.call(state.creds, action, { category_id: ids[i] },
          { idleMs: SECTION_IDLE_MS });
        if (Array.isArray(part)) parts[i] = part;
      } catch { /* one bad category must not lose the rest */ }
      done++;
      report.status('The provider\'s full list failed - loading category ' +
        done + ' of ' + ids.length + '…');
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  const seen = new Set();
  const out = [];
  let ok = 0;
  for (let i = 0; i < ids.length; i++) {
    if (!parts[i]) continue;
    ok++;
    for (const s of parts[i]) {
      const uid = String(s.stream_id ?? s.series_id ?? '');
      if (uid && seen.has(uid)) continue;
      if (uid) seen.add(uid);
      // Some panels omit category_id in per-category responses.
      out.push(s.category_id ? s : { ...s, category_id: ids[i] });
    }
  }
  if (!ok) throw firstErr;
  return out;
}

// Raw provider rows -> app items. Shared by the full-list load and the quick
// per-category fetch, so both produce identical objects.
const mapMovieItem = (s, sec) => ({
  id: 'M' + s.stream_id,
  streamId: s.stream_id,
  name: String(s.name || 'Unknown'),
  logo: s.stream_icon || '',
  group: sec.catMap.get(String(s.category_id)) || 'Uncategorized',
  url: Xtream.movieUrl(state.creds, s.stream_id, s.container_extension),
  meta: { year: s.year || '', rating: s.rating || '' },
});
const mapSeriesItem = (s, sec) => ({
  id: 'S' + s.series_id,
  kind: 'series',
  seriesId: s.series_id,
  name: String(s.name || 'Unknown'),
  logo: s.cover || '',
  group: sec.catMap.get(String(s.category_id)) || 'Uncategorized',
  meta: { year: s.releaseDate || s.release_date || '', rating: s.rating || '', plot: s.plot || '' },
});

async function loadSection(key, sec, report) {
  const opts = { idleMs: SECTION_IDLE_MS, onProgress: report.bytes };

  if (key === 'live') {
    const data = await Xtream.call(state.creds, 'get_live_streams', null, opts);
    const { live, radio } = normalizeLiveStreams(Array.isArray(data) ? data : [], sec.catMap);
    Object.assign(sec, makeSection(live, sec.catMap));
    if (radio.length && !state.sections.radio) state.sections.radio = makeSection(radio, null);
  } else if (key === 'movies') {
    const data = await fetchList('get_vod_streams', sec, report);
    Object.assign(sec, makeSection(data.map(s => mapMovieItem(s, sec)), sec.catMap));
  } else if (key === 'series') {
    const data = await fetchList('get_series', sec, report);
    Object.assign(sec, makeSection(data.map(s => mapSeriesItem(s, sec)), sec.catMap));
  }
  // The per-category quick cache is superseded by the full list.
  delete sec.quick;
  delete sec.quickLoading;
  // Keep lazily loaded sections across reloads too. Deferred: cloning a large
  // catalogue into IndexedDB blocks the main thread, and the list should paint
  // first.
  if (sec.loaded) setTimeout(saveCache, 0);
  return sec;
}

// Some panels answer a list request with an object (an error payload, or the
// user_info block) instead of an array - usually "no VOD on this account" or a
// rate limit. Say so rather than showing an empty grid.
function providerListError(data) {
  const msg = data && (data.error || data.message || data.user_info?.message);
  return msg ? String(msg).slice(0, 200)
    : 'The provider did not return a list (the account may have no access to this section).';
}

// ── M3U mode ─────────────────────────────────────────────────────────────────
function buildM3uSections(items) {
  const buckets = { live: [], movies: [], series: [], radio: [] };
  for (const it of items) buckets[Playlist.classify(it)].push(it);

  state.sections = {};
  if (buckets.live.length) state.sections.live = makeSection(buckets.live, null);
  if (buckets.radio.length) state.sections.radio = makeSection(buckets.radio, null);
  if (buckets.movies.length) state.sections.movies = makeSection(buckets.movies, null);
  if (buckets.series.length) {
    const { grouped, singles } = Playlist.groupSeries(buckets.series);
    const seriesItems = [
      ...grouped.map(s => ({ id: s.id, kind: 'series', name: s.name, logo: s.logo, group: s.group, local: s, meta: {} })),
      ...singles.map(it => ({ ...it, kind: 'single' })),
    ];
    state.sections.series = makeSection(seriesItems, null);
  }
}

// ── Dashboard ────────────────────────────────────────────────────────────────
function enterDashboard() {
  const parts = ['Playlist loaded'];
  const total = Object.values(state.sections).reduce((n, s) => n + (s.items ? s.items.length : 0), 0);
  if (total) parts.push(fmt(total) + ' items');
  const exp = Number(state.account?.exp_date || 0);
  if (exp > 0) parts.push('valid until ' + new Date(exp * 1000).toLocaleDateString());
  const maxC = Number(state.account?.max_connections || 0);
  if (maxC > 0) parts.push(maxC + ' connection' + (maxC > 1 ? 's' : '') + ' allowed');
  $('dashInfo').textContent = parts.join('  ·  ');

  const tiles = $('dashTiles');
  tiles.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const key of SECTION_ORDER) {
    const sec = state.sections[key];
    if (!sec) continue;
    const def = SECTION_DEFS[key];
    const tile = document.createElement('button');
    tile.className = 'dash-tile';
    const ic = document.createElement('div'); ic.className = 'tile-icon'; ic.textContent = def.icon;
    const lb = document.createElement('div'); lb.className = 'tile-label'; lb.textContent = def.label;
    const sub = document.createElement('div'); sub.className = 'tile-sub';
    sub.textContent = sec.items ? fmt(sec.items.length) + ' items' : fmt(sec.catCount) + ' categories';
    tile.append(ic, lb, sub);
    tile.onclick = () => openSection(key);
    frag.appendChild(tile);
  }
  tiles.appendChild(frag);

  const refreshRow = $('dashRefresh');
  refreshRow.innerHTML = '';
  if (state.mode === 'xtream' || state.mode === 'm3u') {
    if (state.dataUpdatedAt) {
      const when = document.createElement('span');
      when.className = 'muted';
      when.textContent = 'Data updated ' + new Date(state.dataUpdatedAt).toLocaleString() + '  ';
      refreshRow.appendChild(when);
    }
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.textContent = '⟳ Update playlist data';
    btn.onclick = () => {
      showScreen('screen-connect');
      connect(savedUrl() || $('urlInput').value);
    };
    refreshRow.appendChild(btn);
  }

  showScreen('screen-dashboard');
  prefetchHeavySections();
  Player.warmup(); // playback engine + ffmpeg assets, so first Play is fast
}

// ── Section navigation ───────────────────────────────────────────────────────
// Returns a progress callback that reports how much has arrived so far, so a
// slow multi-megabyte catalogue visibly moves instead of looking frozen.
function showLoadingIn(el, label) {
  el.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'empty';
  const spin = document.createElement('span');
  spin.className = 'spinner';
  const text = document.createElement('span');
  text.textContent = 'Loading ' + label + '… this can take a while for large catalogues.';
  d.append(spin, text);
  el.appendChild(d);
  let last = 0;
  return {
    bytes: (n) => {
      // Repaint at most every 256 KB - progress text is not worth layout churn.
      if (n - last < 262144) return;
      last = n;
      text.textContent = 'Loading ' + label + '… ' + (n / 1048576).toFixed(1) + ' MB received.';
    },
    status: (msg) => { text.textContent = msg; },
  };
}

function showSectionError(el, key, err) {
  el.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'empty';
  const reason = (err && err.message) ? String(err.message) : 'The provider did not respond.';
  d.textContent = SECTION_DEFS[key].label + ' could not be loaded. ' + reason + ' ';
  const retry = document.createElement('button');
  retry.className = 'btn small';
  retry.textContent = 'Retry';
  retry.onclick = () => openSection(key);
  d.append(document.createElement('br'), retry);
  el.appendChild(d);
}

async function openSection(key) {
  let sec = state.sections[key];
  if (!sec) return;

  state.section = key;
  state.category = 'all';
  state.search = '';
  $('searchInput').value = '';
  const isBrowse = key === 'live' || key === 'radio';

  if (!sec.loaded) {
    // Navigate immediately with a visible loading state; fetch in background.
    let report;
    if (isBrowse) {
      $('browseCats').innerHTML = '';
      $('browseMeta').textContent = '';
      report = showLoadingIn($('browseList'), SECTION_DEFS[key].label);
      resetLiveInfo();
      setMobileStep('items');
      showScreen('screen-browse');
    } else {
      // The category names are already known (fetched at connect): show them
      // right away so a single category can be browsed instantly while the
      // full multi-megabyte list downloads.
      renderPendingCats($('gridCats'), key);
      report = showLoadingIn($('gridItems'), SECTION_DEFS[key].label);
      report.status('Loading ' + SECTION_DEFS[key].label +
        '… meanwhile you can open any category on the left right away.');
      showScreen('screen-grid');
    }
    sectionReporters.set(key, report);
    let err = null;
    try {
      sec = await ensureSection(key);
    } catch (e) {
      err = e;
      sec = null;
    }
    if (state.section !== key) return; // user navigated away meanwhile
    if (!sec || !sec.loaded || !sec.items) {
      // A quick category view may be on screen - replace only the loading state.
      if (isBrowse || state.category === 'all') {
        showSectionError(isBrowse ? $('browseList') : $('gridItems'), key, err);
      } else {
        toast('The full ' + SECTION_DEFS[key].label +
          ' list could not be loaded - categories still open one by one.', 'error', 6000);
      }
      return;
    }
  }

  if (isBrowse) {
    renderCats($('browseCats'));
    renderBrowseItems();
    resetLiveInfo();
    setMobileStep('cats');
    showScreen('screen-browse');
  } else {
    renderCats($('gridCats'));
    renderGridItems();
    showScreen('screen-grid');
  }
}

function filteredItems() {
  const sec = state.sections[state.section];
  // The section may still be loading (e.g. typing in search before the
  // category fetch finishes) - render an empty list rather than crashing.
  let list = (sec && sec.items) || [];
  if (state.category !== 'all') {
    const g = state.category.slice(2);
    list = list.filter(i => i.group === g);
  }
  const q = state.search.toLowerCase();
  if (q) list = list.filter(i => i.name.toLowerCase().includes(q) || i.group.toLowerCase().includes(q));
  return list;
}

// ── Category pane (shared by browse & grid screens) ──────────────────────────
function renderCats(container) {
  const sec = state.sections[state.section];
  container.innerHTML = '';
  const frag = document.createDocumentFragment();

  const mk = (id, name, count) => {
    const b = document.createElement('button');
    b.className = 'cat' + (state.category === id ? ' active' : '');
    const n = document.createElement('span'); n.className = 'cat-name'; n.textContent = name;
    const c = document.createElement('span'); c.className = 'cat-count'; c.textContent = fmt(count);
    b.append(n, c);
    b.onclick = () => {
      state.category = id;
      container.querySelectorAll('.cat').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const cs = container.querySelector('.cat-select');
      if (cs) cs.value = id;
      if (state.screen === 'screen-browse') {
        renderBrowseItems();
        setMobileStep('items');
      } else {
        renderGridItems();
      }
    };
    frag.appendChild(b);
  };

  const allLabel = state.section === 'live' ? 'All Channels'
    : state.section === 'radio' ? 'All Stations'
    : state.section === 'movies' ? 'All Movies' : 'All Series';
  mk('all', allLabel, sec.items.length);
  sec.cats.forEach(c => mk('g:' + c.name, c.name, c.count));
  container.appendChild(frag);

  // On phones the grid's category strip becomes an endless horizontal scroll
  // with real providers (hundreds of categories) - offer a dropdown instead.
  // CSS shows the select and hides the buttons below 800px, and vice versa.
  if (container.id === 'gridCats') {
    const sel = document.createElement('select');
    sel.className = 'cat-select';
    const opt = (id, name, count) => {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = name + ' (' + fmt(count) + ')';
      sel.appendChild(o);
    };
    opt('all', allLabel, sec.items.length);
    sec.cats.forEach(c => opt('g:' + c.name, c.name, c.count));
    sel.value = state.category;
    sel.onchange = () => {
      state.category = sel.value;
      container.querySelectorAll('.cat').forEach(x =>
        x.classList.toggle('active', false));
      renderGridItems();
    };
    container.prepend(sel);
  }
}

// ── Paged list rendering (large-playlist friendly) ───────────────────────────
function pagedRender(container, items, makeEl, pageSize) {
  container.scrollTop = 0;
  container.innerHTML = '';
  let shown = 0;

  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'Nothing here matches.';
    container.appendChild(d);
    container.onscroll = null;
    return;
  }

  const append = () => {
    const old = container.querySelector('.load-more');
    if (old) old.remove();
    const frag = document.createDocumentFragment();
    const slice = items.slice(shown, shown + pageSize);
    slice.forEach((it, i) => frag.appendChild(makeEl(it, shown + i)));
    shown += slice.length;
    container.appendChild(frag);
    if (shown < items.length) {
      const more = document.createElement('button');
      more.className = 'load-more';
      more.textContent = 'Show more (' + fmt(items.length - shown) + ' remaining)';
      more.onclick = append;
      container.appendChild(more);
    }
  };
  append();

  container.onscroll = () => {
    if ((container.scrollTop + container.clientHeight) / container.scrollHeight > 0.85) {
      const btn = container.querySelector('.load-more');
      if (btn) btn.click();
    }
  };
}

// Lazy-loading logo/poster with graceful fallback when the image is broken.
function imageEl(src, className, fallbackIcon) {
  const wrap = document.createElement('div');
  wrap.className = className;
  const ph = document.createElement('span');
  ph.className = 'img-fallback';
  ph.textContent = fallbackIcon;
  wrap.appendChild(ph);
  if (src && Playlist.isSafeHttpUrl(src)) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = src;
    img.onload = () => { ph.remove(); };
    img.onerror = () => { img.remove(); };
    wrap.appendChild(img);
  }
  return wrap;
}

// ── Browse screen (Live TV / Radio) ──────────────────────────────────────────
function renderBrowseItems() {
  const items = filteredItems();
  const sec = state.sections[state.section];
  const total = (sec && sec.items) ? sec.items.length : 0;
  $('browseMeta').textContent = fmt(items.length) + ' of ' + fmt(total) +
    (state.section === 'radio' ? ' stations' : ' channels');
  pagedRender($('browseList'), items, channelRow, PAGE_SIZE);
}

function channelRow(it, idx) {
  const div = document.createElement('div');
  div.className = 'ch' + (state.activeId === it.id ? ' active' : '');
  div.dataset.id = it.id;

  const num = document.createElement('span');
  num.className = 'ch-num';
  num.textContent = idx + 1;
  div.appendChild(num);

  div.appendChild(imageEl(it.logo, 'ch-logo', state.section === 'radio' ? '📻' : '📺'));

  const info = document.createElement('div');
  info.className = 'ch-info';
  const nm = document.createElement('div'); nm.className = 'ch-name'; nm.textContent = it.name;
  const gp = document.createElement('div'); gp.className = 'ch-group'; gp.textContent = it.group;
  info.append(nm, gp);
  div.appendChild(info);

  div.onclick = () => playInBrowse(it);
  return div;
}

// Audio/subtitle track pickers: shown only when the playing HLS stream
// declares alternate tracks (plain files cannot expose them to browsers).
function bindTrackControls(audioSelId, subSelId) {
  const aSel = $(audioSelId);
  const sSel = $(subSelId);
  Player.setTrackListener(({ audio, subs, audioId, subId }) => {
    aSel.hidden = audio.length < 2;
    if (!aSel.hidden) {
      aSel.innerHTML = '';
      for (const t of audio) {
        const o = document.createElement('option');
        o.value = String(t.id);
        o.textContent = '🔊 ' + t.name;
        aSel.appendChild(o);
      }
      aSel.value = String(audioId);
      aSel.onchange = () => Player.setAudioTrack(Number(aSel.value));
    }
    sSel.hidden = subs.length < 1;
    if (!sSel.hidden) {
      sSel.innerHTML = '';
      const off = document.createElement('option');
      off.value = '-1';
      off.textContent = '💬 Subtitles off';
      sSel.appendChild(off);
      for (const t of subs) {
        const o = document.createElement('option');
        o.value = String(t.id);
        o.textContent = '💬 ' + t.name;
        sSel.appendChild(o);
      }
      sSel.value = String(subId >= 0 ? subId : -1);
      sSel.onchange = () => Player.setSubtitleTrack(Number(sSel.value));
    }
  });
}

// Zapping protection: when clicking through channels quickly, only the one
// the user settles on opens a provider connection. This matters because most
// accounts allow a single simultaneous connection and the provider keeps each
// aborted stream counted for a short while.
let zapTimer = 0;
function playInBrowse(it) {
  state.activeId = it.id;
  $('browseList').querySelectorAll('.ch').forEach(el =>
    el.classList.toggle('active', el.dataset.id === it.id));
  renderLiveInfo(it);
  if (isMobile()) setMobileStep('player');
  clearTimeout(zapTimer);
  zapTimer = setTimeout(() => {
    if (state.activeId !== it.id) return;
    bindTrackControls('liveAudioSel', 'liveSubSel');
    Player.play($('liveVideo'), $('liveStatus'), it.url);
  }, 350);
}

function resetLiveInfo() {
  const box = $('liveInfo');
  box.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = state.section === 'radio'
    ? 'Select a station to start listening.'
    : 'Select a channel to start playback.';
  box.appendChild(p);
}

// Info panel under the player - kept as a dedicated container so an EPG can
// plug in here later without layout changes.
function renderLiveInfo(it) {
  const box = $('liveInfo');
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'info-head';
  head.appendChild(imageEl(it.logo, 'info-logo', state.section === 'radio' ? '📻' : '📺'));
  const txt = document.createElement('div');
  const nm = document.createElement('div'); nm.className = 'info-name'; nm.textContent = it.name;
  const gp = document.createElement('div'); gp.className = 'info-group muted'; gp.textContent = it.group;
  txt.append(nm, gp);
  head.appendChild(txt);
  box.appendChild(head);
  const note = document.createElement('p');
  note.className = 'muted info-note';
  note.textContent = state.section === 'radio' ? 'Now playing' : 'No program guide available.';
  box.appendChild(note);
}

// Sequential views on mobile: categories → items → player.
function setMobileStep(step) {
  $('screen-browse').dataset.step = step;
}

// ── Instant category browsing while the full list downloads ─────────────────
// Movies/Series category names arrive at connect time, so the rail renders
// before the multi-megabyte item list exists. Clicking a category fetches
// just that category (a small, fast request) and shows it immediately; the
// full list keeps downloading in the background and takes over when ready.
function renderPendingCats(container, key) {
  const sec = state.sections[key];
  container.innerHTML = '';
  const idsByName = new Map(); // display name -> [category ids]
  for (const [id, name] of sec.catMap) {
    if (!idsByName.has(name)) idsByName.set(name, []);
    idsByName.get(name).push(id);
  }

  const allLabel = key === 'movies' ? 'All Movies' : 'All Series';
  const pick = (id) => {
    state.category = id;
    if (id === 'all') renderGridItems(); // reattaches the download progress
    else quickOpenCategory(key, id.slice(2), idsByName.get(id.slice(2)) || []);
  };
  const activate = (btn) => {
    container.querySelectorAll('.cat').forEach(x => x.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const cs = container.querySelector('.cat-select');
    if (cs) cs.value = state.category;
  };

  const frag = document.createDocumentFragment();
  const mk = (id, name) => {
    const b = document.createElement('button');
    b.className = 'cat' + (state.category === id ? ' active' : '');
    const n = document.createElement('span'); n.className = 'cat-name'; n.textContent = name;
    const c = document.createElement('span'); c.className = 'cat-count'; c.textContent = '…';
    b.append(n, c);
    b.onclick = () => { pick(id); activate(b); };
    frag.appendChild(b);
  };
  mk('all', allLabel);
  for (const name of idsByName.keys()) mk('g:' + name, name);
  container.appendChild(frag);

  // Same phone-friendly dropdown as the loaded rail.
  const sel = document.createElement('select');
  sel.className = 'cat-select';
  const opt = (id, name) => {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = name;
    sel.appendChild(o);
  };
  opt('all', allLabel);
  for (const name of idsByName.keys()) opt('g:' + name, name);
  sel.value = state.category;
  sel.onchange = () => { pick(sel.value); activate(null); };
  container.prepend(sel);
}

async function quickOpenCategory(key, name, catIds) {
  const sec = state.sections[key];
  if (!sec || sec.loaded) { renderGridItems(); return; }
  sec.quick = sec.quick || new Map();
  if (sec.quick.has(name)) { renderGridItems(); return; }
  sec.quickLoading = sec.quickLoading || new Set();
  if (sec.quickLoading.has(name)) return; // in flight - renders on arrival
  sec.quickLoading.add(name);

  const grid = $('gridItems');
  grid.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'empty';
  const spin = document.createElement('span');
  spin.className = 'spinner';
  d.append(spin, 'Loading ' + name + '…');
  grid.appendChild(d);

  const action = key === 'movies' ? 'get_vod_streams' : 'get_series';
  const rows = [];
  let err = null;
  try {
    for (const id of catIds) {
      const part = await Xtream.call(state.creds, action, { category_id: id });
      if (Array.isArray(part)) {
        // Some panels omit category_id in per-category responses.
        for (const s of part) rows.push(s.category_id ? s : { ...s, category_id: id });
      }
    }
  } catch (e) {
    err = e;
  } finally {
    sec.quickLoading.delete(name);
  }

  if (rows.length || !err) {
    sec.quick.set(name, rows.map(s => key === 'movies' ? mapMovieItem(s, sec) : mapSeriesItem(s, sec)));
  }
  if (state.section !== key || state.category !== 'g:' + name) return;
  if (!sec.loaded && err && !rows.length) {
    grid.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'empty';
    box.textContent = 'This category could not be loaded. ' + (err.message || '') + ' ';
    const retry = document.createElement('button');
    retry.className = 'btn small';
    retry.textContent = 'Retry';
    retry.onclick = () => quickOpenCategory(key, name, catIds);
    box.append(document.createElement('br'), retry);
    grid.appendChild(box);
    return;
  }
  renderGridItems();
}

// ── Grid screen (Movies / Series) ────────────────────────────────────────────
function renderGridItems() {
  const sec = state.sections[state.section];
  if (sec && !sec.loaded) {
    // Full list still downloading. "All" has nothing to show yet - keep the
    // download progress on screen; a category renders from the quick cache.
    if (!state.category.startsWith('g:')) {
      sectionReporters.set(state.section,
        showLoadingIn($('gridItems'), SECTION_DEFS[state.section].label));
      return;
    }
    const name = state.category.slice(2);
    let list = (sec.quick && sec.quick.get(name)) || [];
    const q = state.search.toLowerCase();
    if (q) list = list.filter(i => i.name.toLowerCase().includes(q) || i.group.toLowerCase().includes(q));
    pagedRender($('gridItems'), list, gridCard, GRID_PAGE_SIZE);
    return;
  }
  const items = filteredItems();
  pagedRender($('gridItems'), items, gridCard, GRID_PAGE_SIZE);
}

function gridCard(it) {
  const b = document.createElement('button');
  b.className = 'card';
  b.appendChild(imageEl(it.logo, 'card-poster', state.section === 'movies' ? '🎬' : '🎞'));
  const t = document.createElement('div');
  t.className = 'card-title';
  t.textContent = it.name;
  b.appendChild(t);
  if (it.kind === 'series' && it.local) {
    const sub = document.createElement('div');
    sub.className = 'card-sub';
    sub.textContent = fmt(it.local.episodeCount) + ' episodes';
    b.appendChild(sub);
  }
  b.onclick = () => {
    if (it.kind === 'series') openSeriesDetail(it);
    else if (it.kind === 'single') openVod(it.name, it.group, it.url, 'screen-grid');
    else openMovieDetail(it);
  };
  return b;
}

// ── Detail screen ────────────────────────────────────────────────────────────
function detailHeader(it) {
  const head = document.createElement('div');
  head.className = 'detail-head';
  head.appendChild(imageEl(it.logo, 'detail-poster', state.section === 'movies' ? '🎬' : '🎞'));
  const info = document.createElement('div');
  info.className = 'detail-info';
  const h = document.createElement('h2'); h.textContent = it.name;
  const g = document.createElement('p'); g.className = 'muted'; g.textContent = it.group;
  info.append(h, g);
  const metaBits = [];
  if (it.meta?.year) metaBits.push(String(it.meta.year));
  if (it.meta?.rating) metaBits.push('★ ' + it.meta.rating);
  if (metaBits.length) {
    const m = document.createElement('p');
    m.className = 'muted';
    m.textContent = metaBits.join('  ·  ');
    info.appendChild(m);
  }
  head.appendChild(info);
  return { head, info };
}

// Description block (plot, genre, cast, …) from provider metadata. Filled in
// asynchronously on the detail screens; plain M3U playlists carry none.
function renderExtraInfo(container, info, fallbackPlot) {
  container.innerHTML = '';
  const plot = String(info.plot || info.description || fallbackPlot || '').trim();
  if (plot) {
    const p = document.createElement('p');
    p.className = 'detail-plot';
    p.textContent = plot;
    container.appendChild(p);
  }
  const rows = [
    ['Genre', info.genre],
    ['Director', info.director],
    ['Cast', info.cast || info.actors],
    ['Duration', info.duration],
    ['Released', info.releasedate || info.release_date || info.releaseDate],
  ].filter(([, v]) => v && String(v).trim());
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'fact-row';
    const l = document.createElement('span');
    l.className = 'fact-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'fact-value';
    v.textContent = String(value);
    row.append(l, v);
    container.appendChild(row);
  }
  if (!plot && !rows.length) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.textContent = state.mode === 'xtream'
      ? 'No description provided by the provider for this title.'
      : 'No description available - plain M3U playlists do not carry title details.';
    container.appendChild(none);
  }
}

async function openMovieDetail(it) {
  Player.warmup(); // no-op if already warmed
  state.detail = it;
  const body = $('detailBody');
  body.innerHTML = '';
  const { head, info } = detailHeader(it);
  const play = document.createElement('button');
  play.className = 'btn accent big-btn';
  play.textContent = '▶ Play';
  play.onclick = () => openVod(it.name, it.group, it.url, 'screen-detail');
  info.appendChild(play);
  body.appendChild(head);

  const extra = document.createElement('div');
  extra.className = 'detail-extra';
  body.appendChild(extra);
  showScreen('screen-detail');

  if (state.mode === 'xtream' && it.streamId) {
    const loading = document.createElement('p');
    loading.className = 'muted';
    loading.textContent = 'Loading details…';
    extra.appendChild(loading);
    let details = {};
    try {
      const data = await Xtream.call(state.creds, 'get_vod_info', { vod_id: it.streamId });
      details = data && data.info ? data.info : {};
    } catch { /* provider offers no details */ }
    if (state.detail !== it) return;
    renderExtraInfo(extra, details, it.meta?.plot);
  } else {
    renderExtraInfo(extra, {}, it.meta?.plot);
  }
}

async function openSeriesDetail(it) {
  state.detail = it;
  const body = $('detailBody');
  body.innerHTML = '';
  const { head } = detailHeader(it);
  body.appendChild(head);

  const extra = document.createElement('div');
  extra.className = 'detail-extra';
  body.appendChild(extra);

  const list = document.createElement('div');
  list.className = 'seasons';
  body.appendChild(list);
  showScreen('screen-detail');
  if (it.local) renderExtraInfo(extra, {}, it.meta?.plot);

  let seasons; // [{ season, episodes: [{ label, url }] }]
  if (it.local) {
    seasons = [...it.local.seasons.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([season, eps]) => ({
        season,
        episodes: eps.map(ep => ({ label: 'E' + ep.episode + ' · ' + ep.name, url: ep.url })),
      }));
  } else {
    const loading = document.createElement('p');
    loading.className = 'muted';
    loading.textContent = 'Loading episodes…';
    list.appendChild(loading);
    let data = null;
    try {
      data = await Xtream.call(state.creds, 'get_series_info', { series_id: it.seriesId });
      const eps = data && data.episodes ? data.episodes : {};
      seasons = Object.keys(eps)
        .sort((a, b) => Number(a) - Number(b))
        .map(s => ({
          season: Number(s),
          episodes: (Array.isArray(eps[s]) ? eps[s] : []).map(ep => ({
            label: 'E' + (ep.episode_num ?? '?') + (ep.title ? ' · ' + ep.title : ''),
            url: Xtream.episodeUrl(state.creds, ep.id, ep.container_extension),
            vodTitle: it.name + ' - S' + s + 'E' + (ep.episode_num ?? '?'),
          })),
        }));
    } catch (e) {
      if (state.detail !== it) return;
      list.innerHTML = '';
      const err = document.createElement('p');
      err.className = 'muted';
      err.textContent = 'Episodes could not be loaded. ' +
        (e && e.message ? e.message : 'The provider did not respond.');
      const retry = document.createElement('button');
      retry.className = 'btn small';
      retry.textContent = 'Retry';
      retry.onclick = () => openSeriesDetail(it);
      list.append(err, retry);
      return;
    }
    if (state.detail !== it) return; // user navigated away meanwhile
    list.innerHTML = '';
    renderExtraInfo(extra, data && data.info ? data.info : {}, it.meta?.plot);
  }

  if (!seasons.length) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.textContent = 'No episodes available.';
    list.appendChild(none);
    return;
  }

  const episodeBtn = (ep) => {
    const row = document.createElement('button');
    row.className = 'episode';
    row.textContent = ep.label;
    row.onclick = () => openVod(ep.vodTitle || ep.label, it.name, ep.url, 'screen-detail');
    return row;
  };

  if (seasons.length > 1) {
    // Many seasons: pick the season from a dropdown, list its episodes below.
    const sel = document.createElement('select');
    sel.className = 'season-select';
    seasons.forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = (s.season > 0 ? 'Season ' + s.season : 'Episodes') +
        ' (' + s.episodes.length + ')';
      sel.appendChild(opt);
    });
    const epBox = document.createElement('div');
    const renderSeason = (i) => {
      epBox.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (const ep of seasons[i].episodes) frag.appendChild(episodeBtn(ep));
      epBox.appendChild(frag);
    };
    sel.onchange = () => renderSeason(Number(sel.value));
    list.append(sel, epBox);
    renderSeason(0);
  } else {
    const s = seasons[0];
    const h = document.createElement('div');
    h.className = 'season-title';
    h.textContent = s.season > 0 ? 'Season ' + s.season : 'Episodes';
    const frag = document.createDocumentFragment();
    frag.appendChild(h);
    for (const ep of s.episodes) frag.appendChild(episodeBtn(ep));
    list.appendChild(frag);
  }
}

// ── VOD / direct player screen ───────────────────────────────────────────────
function openVod(title, sub, url, backScreen) {
  state.playerBack = backScreen;
  $('vodTitle').textContent = title || '';
  $('vodSub').textContent = sub || '';
  showScreen('screen-player');
  bindTrackControls('vodAudioSel', 'vodSubSel');
  Player.play($('vodVideo'), $('vodStatus'), url);
}

function enterDirect(url) {
  state.mode = 'direct';
  state.playerBack = null;
  let title = 'Direct stream';
  try {
    const last = new URL(url).pathname.split('/').pop();
    if (last) title = decodeURIComponent(last);
  } catch { /* keep default */ }
  $('vodTitle').textContent = title;
  $('vodSub').textContent = 'Playing a direct stream URL';
  showScreen('screen-player');
  bindTrackControls('vodAudioSel', 'vodSubSel');
  Player.play($('vodVideo'), $('vodStatus'), url);
}

// ── Navigation actions ───────────────────────────────────────────────────────
function goHome() {
  if (state.mode === 'direct') return;
  Player.stop();
  state.activeId = null;
  showScreen('screen-dashboard');
}

function goBack() {
  switch (state.screen) {
    case 'screen-browse':
      if (isMobile()) {
        const step = $('screen-browse').dataset.step;
        if (step === 'player') { setMobileStep('items'); return; }
        if (step === 'items') { setMobileStep('cats'); return; }
      }
      goHome();
      return;
    case 'screen-grid':
      goHome();
      return;
    case 'screen-detail':
      showScreen('screen-grid');
      return;
    case 'screen-player':
      Player.stop();
      if (state.playerBack) showScreen(state.playerBack);
      else goHome();
      return;
    default:
      goHome();
  }
}

// Stops playback and wipes every playlist/provider object from memory,
// then returns to the connection screen. No page reload needed.
function changePlaylist() {
  clearSavedUrl();
  Player.clearPanelStrict();
  DB.del('cache').catch(() => { /* cache unavailable */ });
  Player.stop();
  state.mode = null;
  state.creds = null;
  state.account = null;
  state.sections = {};
  state.section = null;
  state.category = 'all';
  state.search = '';
  state.activeId = null;
  state.detail = null;
  state.playerBack = null;

  for (const id of ['browseCats', 'browseList', 'gridCats', 'gridItems', 'detailBody', 'dashTiles', 'liveInfo']) {
    $(id).innerHTML = '';
  }
  $('browseMeta').textContent = '';
  $('vodTitle').textContent = '';
  $('vodSub').textContent = '';
  $('dashInfo').textContent = '';
  $('urlInput').value = '';
  $('searchInput').value = '';
  $('connectStatus').hidden = true;

  showScreen('screen-connect');
  $('urlInput').focus();
}

// ── Event wiring ─────────────────────────────────────────────────────────────
function init() {
  $('connectForm').onsubmit = (e) => {
    e.preventDefault();
    connect($('urlInput').value);
  };
  $('btnHome').onclick = goHome;
  $('btnBack').onclick = goBack;
  $('btnChange').onclick = changePlaylist;
  $('btnLiveRestart').onclick = () => { if (!Player.restart()) toast('Nothing is playing yet.'); };
  $('btnVodRestart').onclick = () => { if (!Player.restart()) toast('Nothing is playing yet.'); };
  const stopPlayback = () => { Player.stop(); toast('Playback stopped.'); };
  $('btnLiveStop').onclick = stopPlayback;
  $('btnVodStop').onclick = stopPlayback;

  // While waiting for a busy connection slot, the player polls the provider's
  // API (which costs no stream slot) and reconnects the moment it frees up.
  Player.setSlotChecker(async () => {
    if (state.mode !== 'xtream' || !state.creds) return null;
    const ui = await Xtream.authenticate(state.creds);
    state.account = ui;
    const active = Number(ui.active_cons);
    const max = Number(ui.max_connections);
    return (Number.isFinite(active) && Number.isFinite(max) && max > 0) ? { active, max } : null;
  });

  // When the provider refuses a stream, ask its API who is using the
  // connections so the busy message shows facts instead of guesses.
  Player.setBusyInfoProvider(async () => {
    if (state.mode !== 'xtream' || !state.creds) return '';
    try {
      const ui = await Xtream.authenticate(state.creds);
      state.account = ui;
      const act = Number(ui.active_cons);
      const max = Number(ui.max_connections);
      if (Number.isFinite(act) && Number.isFinite(max) && max > 0) {
        return `Provider reports ${act} of ${max} allowed connection(s) in use` +
          (act >= max
            ? ' - this can be another device/app, or the provider still counting a previous attempt from this app; it usually clears within a minute.'
            : '.');
      }
    } catch { /* best-effort info only */ }
    return '';
  });
  const copyStreamLink = async () => {
    const url = Player.currentUrl();
    if (!url) { toast('Nothing is playing yet.'); return; }
    try {
      await navigator.clipboard.writeText(url);
      toast('Stream link copied - in VLC/IINA use File > Open Network and paste it.');
    } catch {
      toast('Could not copy automatically. The link is in the browser dev tools network tab.', 'error');
    }
  };
  $('btnLiveCopy').onclick = copyStreamLink;
  $('btnVodCopy').onclick = copyStreamLink;

  let searchTimer = 0;
  $('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value.trim();
      if (state.screen === 'screen-browse') renderBrowseItems();
      else if (state.screen === 'screen-grid') renderGridItems();
    }, 150);
  });

  // Multi-tab detection: two open copies of the app fight over the IPTV
  // account's connection limit, so warn when another tab is detected.
  if ('BroadcastChannel' in window) {
    const bc = new BroadcastChannel('browplayer-tabs');
    let warned = false;
    const warn = () => {
      if (warned) return;
      warned = true;
      toast('This player is open in another tab. Close the other tab - your IPTV account allows only limited simultaneous connections, so a second tab causes "stream busy" errors.', 'error', 12000);
      setTimeout(() => { warned = false; }, 60000);
    };
    bc.onmessage = (e) => {
      if (e.data === 'hello') { bc.postMessage('alive'); warn(); }
      else if (e.data === 'alive') warn();
    };
    bc.postMessage('hello');
  }

  // Opened via file:// - fetch and origin behavior differ; recommend a server.
  if (location.protocol === 'file:') {
    const hint = document.querySelector('#screen-connect .hint');
    if (hint) {
      const warn = document.createElement('p');
      warn.className = 'hint muted';
      warn.style.color = 'var(--danger)';
      warn.textContent = 'You opened this app as a local file. Prefer running it from a local server (e.g. "python3 -m http.server 8080", then open http://localhost:8080) - and use only ONE tab at a time.';
      hint.after(warn);
    }
  }

  // On the plain-HTTP edition the "you will be switched" wording makes no
  // sense - say instead why this edition exists.
  if (location.host === new URL(HTTP_MIRROR).host) {
    const h = $('httpHint');
    if (h) h.replaceChildren(
      document.createTextNode('You are on the HTTP edition - it exists so http:// providers can play. Same app, nothing else changes.'),
      document.createElement('br'));
  }

  // Keyboard shortcuts for the visible player.
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const v = state.screen === 'screen-player' ? $('vodVideo')
      : state.screen === 'screen-browse' ? $('liveVideo') : null;
    if (!v) return;
    switch (e.key) {
      case ' ': e.preventDefault(); v.paused ? v.play().catch(() => {}) : v.pause(); break;
      case 'f': case 'F': (v.requestFullscreen || (() => {})).call(v); break;
      case 'm': case 'M': v.muted = !v.muted; break;
      case 'ArrowUp': e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); break;
      case 'ArrowDown': e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); break;
    }
  });

  showScreen('screen-connect');
  restoreSession();
}

// On startup: restore the cached playlist instantly when possible; refetch
// from the provider only when there is no usable cache or it is over a day old.
// Handoff from the HTTPS edition: the playlist URL arrives in the #fragment
// (never sent over the network). Connect immediately and scrub it from the
// address bar and history. Also bound to hashchange, because a browser that
// rewrites the hop's scheme can turn it into a same-document navigation.
function consumeHandoffHash() {
  const m = location.hash.match(/^#u=(.+)$/);
  if (!m) return false;
  let handoff = '';
  try { handoff = decodeURIComponent(m[1]); } catch { /* malformed */ }
  history.replaceState(null, '', location.pathname + location.search);
  if (handoff && /^https?:\/\//i.test(handoff)) {
    $('urlInput').value = handoff;
    connect(handoff);
    if (location.protocol === 'http:') {
      toast('You are now on the HTTP edition (' + location.host + ') - the same app, needed for http:// providers. Nothing else changes.', 'info', 8000);
    }
    return true;
  }
  return false;
}
window.addEventListener('hashchange', consumeHandoffHash);

async function restoreSession() {
  if (consumeHandoffHash()) return;

  const remembered = savedUrl();
  if (!remembered) return;
  $('urlInput').value = remembered;

  let cache = null;
  try { cache = await DB.get('cache'); } catch { /* cache unavailable */ }

  // An http-only provider cannot work from an https page - let connect()
  // run its https-upgrade / http-edition-hop logic.
  if (Bridge.needed(remembered) && !Bridge.isActive()) {
    connect(remembered);
    return;
  }

  const usable = cache && cache.url === remembered && cache.sections &&
    Object.keys(cache.sections).length && (Date.now() - cache.savedAt) < CACHE_MAX_AGE_MS;
  if (usable) {
    state.mode = cache.mode;
    state.creds = cache.creds;
    state.account = cache.account;
    state.sections = cache.sections;
    state.dataUpdatedAt = cache.savedAt;
    enterDashboard();
    return;
  }
  connect(remembered);
}

document.addEventListener('DOMContentLoaded', init);

})();
