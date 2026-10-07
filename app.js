'use strict';

const API = 'https://api-management-discovery-production.azure-api.net/api/datasets/stibmivb';
// Azure API Management's standard subscription header. Change here if the portal shows another name.
const KEY_HEADER = 'Ocp-Apim-Subscription-Key';
const REFRESH_MS = 60_000;
const STORAGE_KEY = 'leaveNow.config';

const METRO = new Set(['1', '2', '5', '6']);
const TRAM = new Set(['3', '4', '7', '8', '9', '10', '18', '19', '25', '35', '39', '51', '55', '62', '81', '82', '92', '93', '97']);
const modeOf = (line) => (METRO.has(line) ? 'metro' : TRAM.has(line) ? 'tram' : 'bus');

// The live feed uses platform ids without the letter suffix that StopDetails carries (6463F -> 6463).
const normId = (id) => String(id).replace(/[A-Z]+$/i, '');

const $ = (id) => document.getElementById(id);

// Global settings + a list of favourites. Each favourite is a stop, the lines/directions you take
// there and your walk time to it; buffer, line map and API key are shared.
const defaults = { favorites: [], activeId: null, buffer: 5, apiKey: '', showMap: true };
const NO_FAV = Object.freeze({ id: null, name: '', stopName: '', targets: [], walk: 5, mapView: '' });
const CACHE_MS = 60_000; // reuse a favourite's live data this long when switching back to it

let config = loadConfig();
let departures = [];
let lastFetch = 0;
let lastError = '';
const liveCache = new Map(); // favourite id -> { at, mine, error }

function uid() { return Math.random().toString(36).slice(2, 10); }
function fav() { return config.favorites.find((f) => f.id === config.activeId) || config.favorites[0] || NO_FAV; }
function favLabel(f) { return f.name || titleCase(f.stopName || 'New'); }

function loadConfig() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { /* blocked */ }
  const cfg = { ...defaults, ...raw };
  // Migrate the single-stop config from before favourites existed.
  if (!raw.favorites && raw.targets?.length) {
    const id = uid();
    cfg.favorites = [{ id, name: '', stopName: raw.stopName, targets: raw.targets, walk: raw.walk ?? 5, mapView: raw.mapView || '' }];
    cfg.activeId = id;
  }
  for (const k of ['stopName', 'targets', 'walk', 'mapView']) delete cfg[k];
  if (!raw.favorites && cfg.favorites.length) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch { /* blocked */ }
  }
  return cfg;
}
function saveConfig() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* private mode */ }
}

async function api(path, where, limit = 100, params = {}) {
  const url = new URL(`${API}/${path}`);
  if (where) url.searchParams.set('where', where);
  url.searchParams.set('limit', String(limit));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const headers = config.apiKey ? { [KEY_HEADER]: config.apiKey } : {};
  const res = await fetch(url, { headers, cache: 'no-store' });
  if (res.status === 429) throw new Error('Rate limit reached — add an API key in settings');
  if (!res.ok) throw new Error(`STIB API error ${res.status}`);
  return (await res.json()).results || [];
}

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const quote = (s) => `"${String(s).replace(/"/g, '')}"`;
const pointWhere = (ids) => [...new Set(ids)].map((id) => `pointid=${quote(id)}`).join(' or ');

// Returns flat departures: { pointId, line, dest, at: Date }
async function fetchWaiting(pointIds) {
  const rows = await api('rt/WaitingTimes', pointWhere(pointIds));
  const out = [];
  for (const row of rows) {
    for (const p of parse(row.passingtimes) || []) {
      if (!p.expectedArrivalTime) continue; // service messages carry no time
      out.push({
        pointId: row.pointid,
        line: String(p.lineId || row.lineid),
        dest: p.destination ? (p.destination.fr || p.destination.nl || '') : '',
        at: new Date(p.expectedArrivalTime),
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// The live feed only holds the next 2 arrivals per line (often < 10 min ahead), which is
// shorter than walk + buffer. Project later departures from the observed gap between them.
const HORIZON_MIN = 60;
const MIN_HEADWAY = { metro: 4, tram: 6, bus: 8 };
function extrapolate(deps) {
  const groups = new Map();
  for (const d of deps) {
    const k = `${d.pointId}|${d.line}|${d.dest}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  const out = [...deps];
  const until = Date.now() + HORIZON_MIN * 60_000;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const last = list[list.length - 1];
    // Vehicles often bunch, so never assume a tighter gap than the mode's typical headway.
    const floor = MIN_HEADWAY[modeOf(last.line)];
    const gap = Math.min(30, Math.max(floor, (last.at - list[list.length - 2].at) / 60_000)) * 60_000;
    for (let t = last.at.getTime() + gap; t <= until; t += gap) {
      out.push({ ...last, at: new Date(t), est: true });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function applyCache(f) {
  const c = liveCache.get(f.id);
  departures = c ? extrapolate(c.mine) : [];
  lastFetch = c ? c.at : 0;
  lastError = c?.error || '';
}

async function refresh() {
  const f = fav();
  if (!f.targets.length) return render();
  $('status').textContent = 'Updating…';
  $('refresh').classList.add('spinning');
  let mine = null;
  try {
    const live = await fetchWaiting(f.targets.map((t) => t.pointId));
    mine = live.filter((d) => f.targets.some((t) => t.pointId === d.pointId && (!t.line || t.line === d.line)));
    liveCache.set(f.id, { at: Date.now(), mine });
  } catch (err) {
    liveCache.set(f.id, { ...(liveCache.get(f.id) || { at: 0, mine: [] }), error: err.message || 'Network error' });
  }
  // Only touch the screen if the user is still looking at this favourite.
  if (fav().id === f.id) {
    applyCache(f);
    render();
    if (mine) await refreshLineMap(mine).catch(() => {});
  }
  $('refresh').classList.remove('spinning');
  render();
}

const fmtTime = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-'/(])\p{L}/gu, (m) => m.toUpperCase());

// The core calculation: leave home at (arrival − buffer − walk).
function plan(dep, now, walk = fav().walk) {
  const leaveAt = new Date(dep.at - (walk + config.buffer) * 60_000);
  const leaveIn = (leaveAt - now) / 60_000;
  const etaMin = (dep.at - now) / 60_000;
  // Missed the buffer but could still make it by walking straight there.
  const hurry = leaveIn < 0 && etaMin >= walk;
  return { leaveAt, leaveIn, etaMin, hurry, missed: etaMin < walk };
}

// Minutes until you need to leave for a favourite, from its cached data (null if unknown/stale).
function nextLeaveIn(f, now) {
  const c = liveCache.get(f.id);
  if (!c || Date.now() - c.at > 5 * 60_000) return null;
  const p = extrapolate(c.mine).map((d) => plan(d, now, f.walk)).find((x) => x.leaveIn >= 0);
  return p ? Math.floor(p.leaveIn) : null;
}

function renderFavs(now) {
  const box = $('favs');
  $('favsRow').hidden = false; // the + must always be reachable
  $('addFav').classList.toggle('labelled', !config.favorites.length);
  const active = fav();
  const sig = config.favorites.map((f) => `${f.id}:${favLabel(f)}:${f.targets.length}:${f.id === active.id}`).join('|');
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.innerHTML = config.favorites.map((f) => {
      const lines = [...new Set(f.targets.map((t) => t.line).filter(Boolean))].slice(0, 3);
      return `<button type="button" class="fav" data-id="${esc(f.id)}" aria-pressed="${f.id === active.id}">
        <span class="fav-lines">${lines.map((l) => `<i style="--lc:${lineColor(l)}">${esc(l)}</i>`).join('') || '<i>All</i>'}</span>
        <span class="fav-name">${esc(favLabel(f))}</span>
        <span class="fav-eta" data-eta></span>
      </button>`;
    }).join('');
    box.querySelectorAll('.fav[data-id]').forEach((b) => (b.onclick = () => switchTo(b.dataset.id)));
    const cur = box.querySelector('[aria-pressed="true"]');
    if (cur) box.scrollTo({ left: cur.offsetLeft - (box.clientWidth - cur.offsetWidth) / 2, behavior: 'smooth' });
  }
  // Live glance on each chip.
  for (const f of config.favorites) {
    const el = box.querySelector(`.fav[data-id="${CSS.escape(f.id)}"] [data-eta]`);
    if (!el) continue;
    const m = nextLeaveIn(f, now);
    el.textContent = m === null ? '' : m < 1 ? 'now' : `${m} min`;
    el.dataset.level = m === null ? '' : m < 1 ? 'now' : m <= 3 ? 'soon' : 'go';
  }
}

/* ---------- Switching between favourites ---------- */

function switchTo(id, dir = 0) {
  if (!id || id === fav().id) return;
  const from = config.favorites.findIndex((f) => f.id === fav().id);
  const to = config.favorites.findIndex((f) => f.id === id);
  config.activeId = id;
  saveConfig();
  applyCache(fav());
  render();
  const area = $('swipeArea');
  area.classList.remove('slide-left', 'slide-right');
  void area.offsetWidth; // restart the animation
  area.classList.add((dir || to - from) > 0 ? 'slide-left' : 'slide-right');
  const c = liveCache.get(id);
  if (!c || Date.now() - c.at > CACHE_MS) refresh();
  else refreshLineMap(c.mine).catch(() => {});
}

function step(delta) {
  const list = config.favorites;
  if (list.length < 2) return;
  const i = list.findIndex((f) => f.id === fav().id);
  switchTo(list[(i + delta + list.length) % list.length].id, delta);
}

const RING_MIN = 15; // the ring is full when you have this many minutes or more
const RING_LEN = 2 * Math.PI * 52;
const badge = (line) => `<span class="badge ${modeOf(line)}" style="--lc:${lineColor(line)}">${esc(line)}</span>`;

function setHero(state, { big = '—', unit = '', label = '', title = '', detail = '', ring = 0 }) {
  document.body.dataset.state = state;
  $('heroBig').textContent = big;
  $('heroUnit').textContent = unit;
  $('heroLabel').textContent = label;
  $('heroTitle').textContent = title;
  $('heroDetail').innerHTML = detail;
  $('ringFg').style.strokeDasharray = RING_LEN;
  $('ringFg').style.strokeDashoffset = RING_LEN * (1 - Math.max(0, Math.min(1, ring)));
}

function render() {
  const now = new Date();
  const f = fav();
  renderFavs(now);
  $('stopName').textContent = f.stopName ? favLabel(f) : 'No stop set';
  $('subline').innerHTML = f.targets.length
    ? `${f.name ? `<span class="pill">📍 ${esc(titleCase(f.stopName))}</span>` : ''}<span class="pill">🚶 ${f.walk} min walk</span><span class="pill">⏱ ${config.buffer} min early</span>`
    : '';

  const list = $('deps');
  list.innerHTML = '';
  $('toMap').hidden = !config.showMap || !f.targets.length;
  document.body.toggleAttribute('data-empty', !f.targets.length);

  if (!f.targets.length) {
    setHero('', { label: 'Get started', title: 'Choose your stop', detail: '<button type="button" class="hero-cta" data-action="add">+ Add your first stop</button>' });
    setStatus('', 'Not set up');
    return;
  }

  const all = departures.map((d) => ({ d, p: plan(d, now) })).filter(({ p }) => p.etaMin > -1);
  // Keep the last 2 past-deadline ones for context, then everything you can still make with the buffer.
  const planned = [...all.filter(({ p }) => p.leaveIn < 0).slice(-2), ...all.filter(({ p }) => p.leaveIn >= 0)];
  const next = planned.find(({ p }) => p.leaveIn >= 0);

  if (next) {
    const { d, p } = next;
    const mins = Math.floor(p.leaveIn);
    setHero(mins < 1 ? 'now' : mins <= 3 ? 'soon' : 'go', {
      big: mins < 1 ? 'Go' : String(mins),
      unit: mins < 1 ? 'now' : 'min',
      label: mins < 1 ? 'Time to leave' : 'Leave home in',
      title: `Leave at ${fmtTime(p.leaveAt)}`,
      detail: `${badge(d.line)}<span class="hero-dest">${esc(titleCase(d.dest))}</span><span class="hero-arr">${d.est ? 'Est. arrival ~' : 'Arrives '}${fmtTime(d.at)}</span>`,
      ring: p.leaveIn / RING_MIN,
    });
  } else {
    setHero('', { label: 'No upcoming departure', title: 'Nothing to catch', detail: esc(lastError || 'No live data for this stop right now') });
  }

  for (const { d, p } of planned.slice(0, 8)) {
    const li = document.createElement('li');
    li.className = 'dep' + (p.missed ? ' missed' : '') + (d.est ? ' est' : '');
    let leaveText, leaveCls = '';
    if (p.missed) leaveText = 'Too late';
    else if (p.hurry) { leaveText = 'Run — no buffer'; leaveCls = 'now'; }
    else if (p.leaveIn < 1) { leaveText = `Leave now`; leaveCls = 'now'; }
    else { leaveText = `Leave ${fmtTime(p.leaveAt)} · in ${Math.floor(p.leaveIn)} min`; if (p.leaveIn <= 3) leaveCls = 'soon'; }
    const eta = Math.max(0, Math.floor(p.etaMin));
    li.innerHTML = `
      ${badge(d.line)}
      <div class="dep-main">
        <div class="dep-dest">${esc(titleCase(d.dest))}</div>
        <div class="dep-leave ${leaveCls}">${esc(leaveText)}</div>
      </div>
      <div class="dep-eta"><b>${eta < 1 ? 'now' : `${d.est ? '~' : ''}${eta}<i>min</i>`}</b><small>${d.est ? 'estimated' : '<span class="live-mini"></span>live'} · ${fmtTime(d.at)}</small></div>`;
    list.appendChild(li);
  }
  if (!planned.length) list.innerHTML = '<li class="empty">No departures in the live feed</li>';

  const age = lastFetch ? Math.round((Date.now() - lastFetch) / 1000) : null;
  if (lastError) setStatus('error', lastError);
  else if (age === null) setStatus('', 'Connecting…');
  else setStatus('live', `Live · ${age < 5 ? 'just now' : age + 's ago'}`);
}

function setStatus(kind, text) {
  $('liveDot').dataset.kind = kind;
  $('status').textContent = text;
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Settings ---------- */

let draftTargets = [];
let draftStopName = '';
let draftStopIds = [];
let editingNew = false;
let pickToken = 0; // ignores slow line lookups for a stop the user already moved away from

function openSettings(asNew = false) {
  editingNew = asNew === true || !config.favorites.length;
  const f = editingNew ? NO_FAV : fav();
  draftTargets = f.targets.map((t) => ({ ...t }));
  draftStopName = f.stopName;
  draftStopIds = [...(f.stopIds || [])];
  $('settingsTitle').textContent = editingNew ? 'New line setup' : 'Edit line setup';
  $('newFromSheet').hidden = editingNew;
  $('favName').value = f.name;
  disarmDelete();
  $('deleteFav').hidden = editingNew;
  $('walk').value = f.walk;
  $('buffer').value = config.buffer;
  $('apiKey').value = config.apiKey;
  $('showMap').checked = config.showMap;
  $('stopQuery').value = '';
  $('stopResults').innerHTML = '';
  $('platforms').innerHTML = '';
  pickToken++; // drop any line lookup still running for the previous contents
  if ($('settings').open) $('settings').querySelector('form').scrollTop = 0;
  else $('settings').showModal();
  $('settings').scrollTop = 0;
  loadStopIndex().catch(() => {}); // ready by the time the user starts typing
  if (!editingNew && f.stopName) showCurrentStop(f);
}

// Editing an existing favourite: show its stop as picked and its lines with the saved ones ticked.
async function showCurrentStop(f) {
  $('stopQuery').value = titleCase(f.stopName);
  let ids = f.stopIds;
  if (!ids?.length) {
    // Favourites saved before stop ids were stored: look the stop's platforms up once.
    $('platforms').innerHTML = '<div class="hint">Loading your lines…</div>';
    try {
      const name = normalizeStopQuery(f.stopName);
      const rows = await api('static/StopDetails', `name like "%${name}%"`, 100);
      ids = rows.filter((r) => { const n = parse(r.name); return n.fr === f.stopName || n.nl === f.stopName; }).map((r) => normId(r.id));
    } catch { ids = []; }
    ids = [...new Set([...ids, ...f.targets.map((t) => t.pointId)])];
    f.stopIds = ids;
    saveConfig();
  }
  pickStop(f.stopName, ids, f.targets);
}

// STIB stop names are upper-case without accents ("TRINITE", "GARE DE L'OUEST", "UZ-VUB"), and the
// API can't match apostrophes. Keep only letters/digits and let anything in between be a wildcard,
// so "Trinité", "gare de l’ouest" or "uz vub" all match. This also leaves nothing that could alter the query.
function normalizeStopQuery(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, '%').replace(/^%+|%+$/g, '');
}

async function searchStops() {
  const q = normalizeStopQuery($('stopQuery').value);
  if (q.replace(/%/g, '').length < 2) return;
  const box = $('stopResults');
  box.innerHTML = '<span class="hint">Searching…</span>';
  try {
    const rows = await api('static/StopDetails', `name like "%${q}%"`, 100);
    const byName = new Map();
    for (const r of rows) {
      const name = parse(r.name);
      const key = name.fr || name.nl;
      if (!byName.has(key)) byName.set(key, { label: name.fr === name.nl ? name.fr : `${name.fr} / ${name.nl}`, ids: [] });
      byName.get(key).ids.push(normId(r.id));
    }
    box.innerHTML = '';
    if (!byName.size) box.innerHTML = '<span class="hint">No stop found</span>';
    for (const [key, s] of byName) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = titleCase(s.label);
      b.onclick = () => {
        $('stopQuery').value = titleCase(key);
        box.innerHTML = '';
        pickStop(key, [...new Set(s.ids)], []);
      };
      box.appendChild(b);
    }
  } catch (err) {
    box.innerHTML = `<span class="hint">${esc(err.message)}</span>`;
  }
}

async function pickStop(name, ids, selected = []) {
  const token = ++pickToken;
  draftStopName = name;
  draftStopIds = ids;
  draftTargets = selected.map((t) => ({ ...t }));
  const isOn = (pointId, line) => draftTargets.some((t) => t.pointId === pointId && t.line === line);
  const box = $('platforms');
  box.innerHTML = '<div class="hint">Loading lines…</div>';
  let deps = [];
  let failed = '';
  try { deps = await fetchWaiting(ids); } catch (err) { failed = err.message; }
  if (token !== pickToken) return;

  // One option per (platform, line), labelled with its destination = direction of travel.
  const opts = new Map();
  for (const d of deps) {
    const k = `${d.pointId}|${d.line}`;
    if (!opts.has(k)) opts.set(k, { pointId: d.pointId, line: d.line, dest: d.dest });
  }
  // Every line and direction serving this stop (route index), so you can pick them even at night.
  // Skip a route's last stop: you can't board towards a terminus you're already at.
  if (stopIndex) {
    for (const id of ids) {
      for (const [line, dest] of stopIndex.served.get(id) || []) {
        const k = `${id}|${line}`;
        if (!opts.has(k)) opts.set(k, { pointId: id, line, dest, idle: !failed });
      }
    }
  }
  // Saved choices stay visible even when that line isn't running right now.
  for (const t of draftTargets) {
    const k = `${t.pointId}|${t.line}`;
    if (t.line && !opts.has(k)) opts.set(k, { pointId: t.pointId, line: t.line, dest: t.dest || '', idle: true });
  }

  if (!opts.size) {
    if (failed) { box.innerHTML = `<div class="hint">${esc(failed)}</div>`; return; }
    // Nothing running right now (e.g. at night): fall back to all lines on every platform.
    draftTargets = ids.map((id) => ({ pointId: id, line: '' }));
    box.innerHTML = '<div class="hint">No live departures right now — all lines at this stop will be shown.</div>';
    return;
  }

  const byLine = (a, b) => a.line.localeCompare(b.line, undefined, { numeric: true }) || a.dest.localeCompare(b.dest);
  const list = [...opts.values()].sort((a, b) => (isOn(b.pointId, b.line) - isOn(a.pointId, a.line)) || byLine(a, b));
  const chosen = draftTargets.filter((t) => t.line).length;
  box.innerHTML = `<div class="hint">${chosen ? `${chosen} selected · tap to change` : 'Pick the line(s) and direction(s) you take:'}</div>`;
  for (const o of list) {
    const label = document.createElement('label');
    label.className = 'opt';
    label.innerHTML = `<input type="checkbox"${isOn(o.pointId, o.line) ? ' checked' : ''}>${badge(o.line)}`
      + `<span class="dest">${o.dest ? `→ ${esc(titleCase(o.dest))}` : 'Direction saved earlier'}</span>`
      + `${o.idle ? '<span class="opt-note">not running now</span>' : ''}`;
    label.querySelector('input').onchange = (e) => {
      draftTargets = draftTargets.filter((t) => t.line && !(t.pointId === o.pointId && t.line === o.line));
      if (e.target.checked) draftTargets.push({ pointId: o.pointId, line: o.line, dest: o.dest });
      const n = draftTargets.length;
      box.querySelector('.hint').textContent = n ? `${n} selected · tap to change` : 'Pick the line(s) and direction(s) you take:';
    };
    box.appendChild(label);
  }
  // When editing, keep the sheet short: show your lines, tuck the rest behind a toggle.
  const others = [...box.querySelectorAll('.opt')].filter((l) => !l.querySelector('input').checked);
  if (chosen && others.length) {
    others.forEach((l) => (l.hidden = true));
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'lm-more';
    more.textContent = `Show all ${list.length} lines at this stop`;
    more.onclick = () => { others.forEach((l) => (l.hidden = false)); more.remove(); };
    box.appendChild(more);
  }
  if (failed) box.insertAdjacentHTML('beforeend', `<div class="hint">Couldn't load live lines: ${esc(failed)}</div>`);
}

/* ---------- Delete the favourite being edited (tap twice to confirm) ---------- */

let deleteTimer = null;
function disarmDelete() {
  clearTimeout(deleteTimer);
  $('deleteFav').classList.remove('armed');
  $('deleteFav').textContent = 'Delete this line setup';
}
function deleteActive() {
  const id = fav().id;
  config.favorites = config.favorites.filter((f) => f.id !== id);
  config.activeId = config.favorites[0]?.id ?? null;
  liveCache.delete(id);
  saveConfig();
  closeSheet();
  applyCache(fav());
  render();
  if (fav().targets.length) refresh();
  else setTimeout(() => openSettings(true), 300);
}
$('deleteFav').onclick = () => {
  const btn = $('deleteFav');
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = `Tap again to delete “${favLabel(fav())}”`;
    deleteTimer = setTimeout(disarmDelete, 3500);
    return;
  }
  disarmDelete();
  deleteActive();
};

$('openSettings').onclick = () => openSettings(false);
$('addFav').onclick = () => openSettings(true);
$('newFromSheet').onclick = () => openSettings(true); // re-open the same sheet in "new" mode
$('stopQuery').addEventListener('input', renderSuggestions);
$('stopQuery').addEventListener('focus', (e) => e.target.select());
$('stopQuery').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (stopIndex) { const first = suggestStops(e.target.value)[0]; if (first) chooseStop(first); }
  else searchStops(); // stop list unavailable: search online instead
});
$('stopQuery').addEventListener('blur', () => setTimeout(() => {
  // Leaving the field without choosing: put the chosen stop's name back.
  if (document.activeElement === $('stopQuery') || !draftStopName) return;
  $('stopQuery').value = titleCase(draftStopName);
  $('stopResults').innerHTML = '';
}, 150));
// Tapping a suggestion mustn't blur the field first (that would clear the list before the tap lands).
$('stopResults').addEventListener('mousedown', (e) => { if (e.target.closest('.suggestion')) e.preventDefault(); });
$('swipeArea').addEventListener('click', (e) => { if (e.target.closest('[data-action="add"]')) openSettings(true); });
$('refresh').onclick = refresh;
$('toMap').onclick = () => $('lineMap').scrollIntoView({ behavior: 'smooth', block: 'start' });

/* ---------- Liquid Glass: specular highlight follows the pointer/finger ---------- */

document.addEventListener('pointermove', (e) => {
  const el = e.target.closest?.('.lit');
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
  el.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
}, { passive: true });

// Real refraction (SVG displacement inside backdrop-filter) only renders in Chromium; elsewhere it's plain frosted glass.
if (navigator.userAgentData?.brands?.some((b) => /Chromium/.test(b.brand))) {
  document.documentElement.classList.add('refract');
}

// Pressing Go/return on the keyboard must never close the sheet (it used to trigger Cancel).
$('settingsForm').addEventListener('submit', (e) => e.preventDefault());
$('settingsForm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input:not(#stopQuery)')) { e.preventDefault(); e.target.blur(); }
});
$('cancelBtn').onclick = closeSheet;
$('saveBtn').onclick = saveSettings;

function saveSettings() {
  if (!draftStopName || !draftTargets.length) {
    $('platforms').querySelector('.hint-error')?.remove();
    $('platforms').insertAdjacentHTML('afterbegin', `<div class="hint hint-error">${draftStopName ? 'Select at least one line.' : 'Search for your stop and pick it first.'}</div>`);
    ($('stopResults').firstChild ? $('platforms') : $('stopQuery')).scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const num = (id, fallback) => { const v = parseInt($(id).value, 10); return Number.isFinite(v) && v >= 0 ? v : fallback; };
  const data = { name: $('favName').value.trim(), stopName: draftStopName, stopIds: draftStopIds, targets: draftTargets, walk: num('walk', NO_FAV.walk) };
  if (editingNew) {
    const f = { id: uid(), mapView: '', ...data };
    config.favorites.push(f);
    config.activeId = f.id;
  } else {
    const f = fav();
    const key = (ts) => ts.map((t) => `${t.pointId}|${t.line}`).sort().join(',');
    if (f.stopName !== data.stopName || key(f.targets) !== key(data.targets)) {
      liveCache.delete(f.id);
      f.mapView = '';
    }
    Object.assign(f, data);
  }
  config.buffer = num('buffer', defaults.buffer);
  config.apiKey = $('apiKey').value.trim();
  config.showMap = $('showMap').checked;
  saveConfig();
  closeSheet();
  applyCache(fav());
  refresh();
}

/* ---------- Stop index: every stop + the lines serving it, downloaded once a week ----------
   Autocomplete runs against this local copy, so typing costs no API requests (the anonymous
   limit is ~100/day). 3 pages of StopDetails + 1 of stopsByLine ≈ 250 KB, stored compactly. */

const STOP_INDEX_KEY = 'leaveNow.stopIndex.v1';
const STOP_INDEX_TTL = 7 * 24 * 3600_000;
let stopIndex = null; // { stops: [{ fr, nl, ids, lines, frKey, nlKey, words }], served: Map(pointId -> [[line, dest]]) }
let stopIndexLoading = null;

// Upper-case, no accents, punctuation as spaces: "Gare de l’Ouest" -> "GARE DE L OUEST".
const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

function buildStopIndex(raw) {
  const served = new Map(Object.entries(raw.served));
  const byNum = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const stops = raw.stops.map((s) => {
    const lines = [...new Set(s.ids.flatMap((id) => (served.get(id) || []).map(([line]) => line)))].sort(byNum);
    const frKey = fold(s.fr), nlKey = fold(s.nl);
    return { ...s, lines, frKey, nlKey, words: [...new Set(`${frKey} ${nlKey}`.split(' '))] };
  });
  return { stops, served };
}

async function downloadStopIndex() {
  const rows = [];
  for (let offset = 0; offset < 10_000; offset += 1000) {
    const page = await api('static/StopDetails', '', 1000, { offset });
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const byName = new Map();
  for (const r of rows) {
    const n = parse(r.name) || {};
    const key = n.fr || n.nl;
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, { fr: key, nl: n.nl && n.nl !== key ? n.nl : '', ids: [] });
    const id = normId(r.id);
    if (!byName.get(key).ids.includes(id)) byName.get(key).ids.push(id);
  }
  const served = {};
  for (const v of await api('static/stopsByLine', '', 1000)) {
    const dest = (parse(v.destination) || {}).fr || '';
    const ids = (parse(v.points) || []).sort((a, b) => a.order - b.order).map((p) => normId(p.id));
    ids.slice(0, -1).forEach((id) => {
      const list = (served[id] ||= []);
      if (!list.some(([l]) => l === v.lineid)) list.push([String(v.lineid), dest]);
    });
  }
  return { stops: [...byName.values()], served };
}

function loadStopIndex() {
  if (stopIndex) return Promise.resolve(stopIndex);
  stopIndexLoading ||= (async () => {
    let raw = cacheGet(STOP_INDEX_KEY, STOP_INDEX_TTL);
    if (!raw) { raw = await downloadStopIndex(); cacheSet(STOP_INDEX_KEY, raw); }
    return (stopIndex = buildStopIndex(raw));
  })().catch((err) => { stopIndexLoading = null; throw err; });
  return stopIndexLoading;
}

// Every typed word must start a word of the stop's FR or NL name; names starting with the query rank first.
function suggestStops(text, max = 8) {
  const q = fold(text);
  if (!stopIndex || q.replace(/ /g, '').length < 2) return [];
  const tokens = q.split(' ');
  const hits = [];
  for (const s of stopIndex.stops) {
    let score;
    if (tokens.every((t) => s.words.some((w) => w.startsWith(t)))) {
      score = s.frKey.startsWith(q) ? 0 : s.nlKey.startsWith(q) ? 1 : 2;
    } else if (s.frKey.includes(q) || s.nlKey.includes(q)) {
      score = 3;
    } else continue;
    hits.push([score, s.frKey.length, s]);
  }
  return hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, max).map((h) => h[2]);
}

function renderSuggestions() {
  const box = $('stopResults');
  const text = $('stopQuery').value;
  if (fold(text).replace(/ /g, '').length < 2) { box.innerHTML = ''; return; }
  if (!stopIndex) {
    box.innerHTML = '<span class="hint">Loading the stop list…</span>';
    loadStopIndex().then(renderSuggestions).catch((err) => {
      box.innerHTML = `<span class="hint">${esc(err.message)} — press return to search online.</span>`;
    });
    return;
  }
  const list = suggestStops(text);
  if (!list.length) { box.innerHTML = `<span class="hint">No stop matches “${esc(text.trim())}”</span>`; return; }
  box.innerHTML = list.map((s, i) => `
    <button type="button" class="suggestion" role="option" data-i="${i}">
      <span class="sg-name">${esc(titleCase(s.fr))}${s.nl ? `<small>${esc(titleCase(s.nl))}</small>` : ''}</span>
      <span class="sg-lines">${s.lines.slice(0, 5).map(badge).join('')}${s.lines.length > 5 ? `<i class="sg-more">+${s.lines.length - 5}</i>` : ''}</span>
    </button>`).join('');
  box.querySelectorAll('.suggestion').forEach((b) => (b.onclick = () => chooseStop(list[+b.dataset.i])));
}

// Picking a suggestion goes straight to the line selector.
function chooseStop(s) {
  $('stopQuery').value = titleCase(s.fr);
  $('stopResults').innerHTML = '';
  $('stopQuery').blur();
  pickStop(s.fr, s.ids, []);
  setTimeout(() => $('platforms').scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
}

/* ---------- Settings sheet: tap outside, drag the handle down, or Esc to close ---------- */

const sheet = $('settings');
function closeSheet() {
  if (!sheet.open || sheet.classList.contains('closing')) return;
  sheet.classList.remove('dragging');
  sheet.classList.add('closing');
  sheet.style.transform = `translateY(${sheet.offsetHeight + 40}px)`;
  setTimeout(() => {
    sheet.close();
    sheet.classList.remove('closing');
    sheet.style.transform = '';
  }, 260);
}
sheet.addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(); }); // Esc key
sheet.addEventListener('click', (e) => {
  // Clicks on the dimmed backdrop are reported on the <dialog> itself, outside its box.
  if (e.target !== sheet) return;
  const r = sheet.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeSheet();
});

let sheetDrag = null;
const grab = $('sheetGrab');
grab.addEventListener('pointerdown', (e) => {
  sheetDrag = { y: e.clientY, t: performance.now(), dy: 0 };
  grab.setPointerCapture(e.pointerId);
  sheet.classList.add('dragging');
});
grab.addEventListener('pointermove', (e) => {
  if (!sheetDrag) return;
  sheetDrag.dy = Math.max(0, e.clientY - sheetDrag.y); // follows the finger downwards only
  sheet.style.transform = `translateY(${sheetDrag.dy}px)`;
});
function endSheetDrag() {
  if (!sheetDrag) return;
  const { dy, t } = sheetDrag;
  sheetDrag = null;
  sheet.classList.remove('dragging');
  const speed = dy / Math.max(1, performance.now() - t); // px per ms
  if (dy > 110 || (dy > 30 && speed > 0.5)) closeSheet(); // far enough, or a quick flick
  else sheet.style.transform = ''; // spring back
}
grab.addEventListener('pointerup', endSheetDrag);
grab.addEventListener('pointercancel', endSheetDrag);

/* ---------- No zoom: the layout is built for the phone's width ----------
   iOS Safari ignores user-scalable=no, so block its pinch gestures directly. */
for (const type of ['gesturestart', 'gesturechange']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

/* ---------- Swipe / arrow keys to move between favourites ---------- */

let swipe = null;
$('swipeArea').addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || e.target.closest('.favs, button, a, input, .lm')) return;
  swipe = { x: e.clientX, y: e.clientY };
}, { passive: true });
$('swipeArea').addEventListener('pointerup', (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
});
$('swipeArea').addEventListener('pointercancel', () => (swipe = null));
document.addEventListener('keydown', (e) => {
  if ($('settings').open || e.target.closest?.('input')) return;
  if (e.key === 'ArrowRight') step(1);
  if (e.key === 'ArrowLeft') step(-1);
});

/* ---------- Loop: fetch every minute while visible, re-render every second ---------- */

let timer = null;
function start() {
  if (timer) return;
  if (Date.now() - lastFetch > 30_000) refresh();
  timer = setInterval(() => {
    if (Date.now() - lastFetch >= REFRESH_MS) refresh();
    else render();
  }, 1000);
}
function stop() { clearInterval(timer); timer = null; }
document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

render();
start();
if (!config.favorites.length) openSettings(true);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
