'use strict';
/*
 * Line map: a metro-style strip of the line you take, from its terminus down to your stop,
 * with live vehicle positions, service gaps, held vehicles and STIB disruption notices.
 *
 * STIB open data has no timetable deviation, so "lateness" is inferred:
 *  - held:  a vehicle that has not moved for >= 2 polls (~2+ min) away from a terminus
 *  - gap:   spacing between consecutive vehicles much larger than the line's median spacing
 *  - bunch: two vehicles less than a stop apart (the one behind is usually late)
 * Uses helpers defined in app.js (api, parse, quote, normId, modeOf, esc, titleCase, fmtTime, config).
 */


const ROUTE_TTL = 7 * 24 * 3600_000;
const NOTICE_TTL = 10 * 60_000;
const ROW = 34; // px per stop
const WINDOW_STOPS = 10; // stops shown before yours when collapsed

const lm = {
  view: null,      // { line, pointId }
  route: null,
  vehicles: [],
  live: [],        // live departures at your stop for this line
  seen: new Map(), // position key -> first time seen, for held detection
  notices: [], noticesKey: '', noticesAt: 0,
  expanded: false,
  error: '',
  loading: false,
};

/* ---------- views: one per (line, your platform) you selected ---------- */

function lineViews(liveDeps) {
  const views = new Map();
  for (const t of fav().targets) {
    const lines = t.line ? [t.line] : [...new Set(liveDeps.filter((d) => d.pointId === t.pointId).map((d) => d.line))];
    for (const line of lines) views.set(`${line}|${t.pointId}`, { line, pointId: t.pointId });
  }
  return [...views.values()];
}

/* ---------- static route (cached) ---------- */

function cacheGet(key, ttl) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v && Date.now() - v.at < ttl ? v.data : null;
  } catch { return null; }
}
function cacheSet(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch { /* full or blocked */ }
}

function metersBetween(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return 0;
  const R = 6371e3, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function loadRoute(line, pointId) {
  const key = `leaveNow.route.${line}.${pointId}`;
  const cached = cacheGet(key, ROUTE_TTL);
  if (cached) return cached;

  const variants = await api('static/stopsByLine', `lineid=${quote(line)}`, 20);
  const parsed = variants.map((v) => ({
    dest: parse(v.destination),
    ids: parse(v.points).sort((a, b) => a.order - b.order).map((p) => normId(p.id)),
  }));
  const mine = parsed.find((v) => v.ids.includes(pointId));
  if (!mine) throw new Error(`Your stop isn't on line ${line}'s published route (diversion?)`);

  // StopDetails ids may carry a letter suffix, hence the prefix match.
  const rows = await api('static/StopDetails', mine.ids.map((id) => `id like "${id}%"`).join(' or '), 200);
  const info = new Map();
  for (const r of rows) {
    const id = normId(r.id);
    if (info.has(id)) continue;
    const name = parse(r.name), gps = parse(r.gpscoordinates) || {};
    info.set(id, { name: name.fr || name.nl, lat: gps.latitude, lon: gps.longitude });
  }
  const points = mine.ids.map((id) => ({ id, ...(info.get(id) || { name: id }) }));
  const route = {
    line,
    dest: mine.dest.fr || mine.dest.nl,
    points,
    seg: points.map((p, i) => metersBetween(p, points[i + 1])),
    myIndex: mine.ids.indexOf(pointId),
  };
  cacheSet(key, route);
  return route;
}

/* ---------- live data ---------- */

async function loadVehicles(route) {
  const rows = await api('rt/VehiclePositions', `lineid=${quote(route.line)}`, 5);
  const index = new Map(route.points.map((p, i) => [p.id, i]));
  const first = route.points[0].id;
  const out = [];
  for (const row of rows) {
    for (const v of parse(row.vehiclepositions) || []) {
      const id = normId(v.pointId);
      const i = index.get(id);
      if (i === undefined) continue; // other direction (platforms differ per direction)
      // The start terminus is the other direction's end: skip vehicles finishing their run there.
      if (i === 0 && normId(v.directionId) === first) continue;
      const dist = Number(v.distanceFromPoint) || 0;
      const frac = route.seg[i] ? Math.min(0.9, dist / route.seg[i]) : 0;
      out.push({ index: i, pos: i + frac, key: `${id}|${dist}` });
    }
  }
  return out.sort((a, b) => a.pos - b.pos);
}

function markHeld(vehicles) {
  const now = Date.now();
  const next = new Map();
  for (const v of vehicles) {
    const since = lm.seen.get(v.key) ?? now;
    next.set(v.key, since);
    v.heldMin = (now - since) / 60_000;
    // Ignore termini (layovers are normal) and the first sighting.
    v.held = v.index > 0 && v.index < lm.route.points.length - 1 && v.heldMin >= 1.5;
  }
  lm.seen = next;
}

function findGaps(vehicles) {
  const gaps = [];
  gaps.median = 0;
  const spans = [];
  for (let i = 1; i < vehicles.length; i++) spans.push({ from: vehicles[i - 1].pos, to: vehicles[i].pos, d: vehicles[i].pos - vehicles[i - 1].pos });
  if (spans.length < 2) return gaps;
  const sorted = spans.map((s) => s.d).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  gaps.median = median;
  for (const s of spans) {
    if (s.d >= Math.max(4, median * 2, median + 3)) gaps.push({ ...s, kind: 'gap' });
    else if (s.d < 0.6 && s.from >= 1) gaps.push({ ...s, kind: 'bunch' });
  }
  return gaps;
}

async function loadNotices(route) {
  const key = `${route.line}|${route.points[route.myIndex].id}`;
  if (lm.noticesKey === key && Date.now() - lm.noticesAt < NOTICE_TTL) return;
  // The API can't match a whole line id inside the JSON field, so filter loosely then exactly.
  const rows = await api('rt/TravellersInformation', `lines like "%${route.line}%"`, 400);
  const upstream = new Set(route.points.slice(0, route.myIndex + 1).map((p) => p.id));
  const myStop = route.points[route.myIndex].id;
  const seen = new Set();
  const list = [];
  for (const r of rows) {
    if (!(parse(r.lines) || []).some((l) => String(l.id) === route.line)) continue;
    const t = parse(r.content)?.[0]?.text?.[0] || {};
    const text = t.en || t.fr || t.nl;
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const pts = (parse(r.points) || []).map((p) => normId(p.id));
    list.push({ text, mine: pts.includes(myStop), onRoute: pts.some((id) => upstream.has(id)), priority: r.priority });
  }
  list.sort((a, b) => (b.mine - a.mine) || (b.onRoute - a.onRoute) || (a.priority - b.priority));
  lm.notices = list;
  lm.noticesKey = key;
  lm.noticesAt = Date.now();
}

/* ---------- entry point, called from app.js refresh() ---------- */

async function refreshLineMap(liveDeps) {
  const box = $('lineMap');
  if (!config.showMap || !fav().targets.length) { box.hidden = true; return; }
  box.hidden = false;
  const favId = fav().id;

  const views = lineViews(liveDeps);
  if (!views.length) { lm.error = 'No line selected'; return renderLineMap(views); }
  const view = views.find((v) => `${v.line}|${v.pointId}` === fav().mapView) || views[0];
  if (!lm.view || lm.view.line !== view.line || lm.view.pointId !== view.pointId) {
    lm.view = view;
    lm.route = null;
    lm.vehicles = [];
    lm.seen = new Map();
    lm.expanded = false;
  }
  lm.live = liveDeps.filter((d) => d.pointId === view.pointId && d.line === view.line);

  try {
    lm.loading = !lm.route;
    if (lm.loading) renderLineMap(views);
    const route = lm.route || (await loadRoute(view.line, view.pointId));
    const [vehicles] = await Promise.all([loadVehicles(route), loadNotices(route).catch(() => {})]);
    // The user may have switched favourite or line while this was loading.
    if (fav().id !== favId || lm.view !== view) return;
    lm.route = route;
    lm.vehicles = vehicles;
    markHeld(vehicles);
    lm.error = '';
  } catch (err) {
    lm.error = err.message || 'Could not load the line';
  }
  lm.loading = false;
  renderLineMap(views);
}

/* ---------- rendering ---------- */

function lineColor(line) {
  return `var(--${modeOf(line)})`;
}

function healthOf(route, vehicles, gaps) {
  const my = route.myIndex;
  const upstream = vehicles.filter((v) => v.pos < my);
  const held = upstream.filter((v) => v.held);
  if (held.length) {
    const v = held[held.length - 1];
    return { level: 'bad', text: `Delay: a vehicle has been stopped at ${titleCase(route.points[v.index].name)} for ${Math.round(v.heldMin)} min` };
  }
  if (!vehicles.length) return { level: 'warn', text: 'No vehicles running in this direction right now' };
  if (!upstream.length) return { level: 'warn', text: `No ${modeOf(route.line)} on its way to your stop yet` };
  // Only what is still coming to you matters: gaps behind vehicles that already passed are ignored.
  const nearest = upstream[upstream.length - 1];
  const away = my - nearest.pos;
  if (gaps.median && away >= Math.max(4, gaps.median * 2)) {
    return { level: 'warn', text: `Next ${modeOf(route.line)} is ${Math.round(away)} stops away — longer wait than usual` };
  }
  const gap = gaps.find((g) => g.kind === 'gap' && g.to <= my);
  if (gap) return { level: 'warn', text: `Irregular service: ${Math.round(gap.d)}-stop gap between the ${modeOf(route.line)}s coming your way` };
  const bunch = gaps.find((g) => g.kind === 'bunch' && g.to <= my);
  if (bunch) return { level: 'warn', text: 'Vehicles bunched together: the second one is likely running late' };
  return { level: 'ok', text: 'Running normally' };
}

function renderLineMap(views) {
  const box = $('lineMap');
  const tabs = views.map((v) => {
    const active = lm.view && v.line === lm.view.line && v.pointId === lm.view.pointId;
    return `<button type="button" class="chip" data-view="${esc(v.line)}|${esc(v.pointId)}" aria-pressed="${active}">
      <span class="dotline" style="background:${lineColor(v.line)}"></span>${esc(cap(modeOf(v.line)))} ${esc(v.line)}</button>`;
  }).join('');

  let body = '';
  const route = lm.route;
  if (lm.loading) body = '<div class="empty">Loading line…</div>';
  else if (lm.error && !route) body = `<div class="empty">${esc(lm.error)}</div>`;
  else if (route) body = renderStrip(route);

  box.innerHTML = `
    <div class="lm-head">
      <h2>Line map</h2>
      <div class="lm-tabs">${views.length > 1 ? tabs : ''}</div>
    </div>
    ${body}`;

  box.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => {
      fav().mapView = b.dataset.view;
      saveConfig();
      refreshLineMap(departures.filter((d) => !d.est));
    };
  });
  const more = box.querySelector('.lm-more');
  if (more) more.onclick = () => { lm.expanded = !lm.expanded; renderLineMap(views); };
}

function renderStrip(route) {
  const vehicles = lm.vehicles;
  const gaps = findGaps(vehicles);
  const health = healthOf(route, vehicles, gaps);
  const my = route.myIndex;
  const color = lineColor(route.line);

  const start = lm.expanded ? 0 : Math.max(0, my - WINDOW_STOPS);
  const end = Math.min(route.points.length - 1, my + 2);
  const y = (pos) => (pos - start) * ROW + ROW / 2;
  const height = (end - start + 1) * ROW;

  // Match live arrival times to vehicles: closest vehicle upstream gets the first arrival.
  // A vehicle standing at your stop is boarding/leaving and is no longer in the arrivals feed.
  const upstream = vehicles.filter((v) => v.pos < my).sort((a, b) => b.pos - a.pos);
  const eta = new Map(upstream.map((v, i) => [v, lm.live[i]]));

  const hiddenVeh = vehicles.filter((v) => v.pos < start).length;
  const moreRow = start > 0
    ? `<button type="button" class="lm-more">▲ ${start} earlier stop${start > 1 ? 's' : ''}${hiddenVeh ? ` · ${hiddenVeh} vehicle${hiddenVeh > 1 ? 's' : ''}` : ''}</button>`
    : lm.expanded ? '<button type="button" class="lm-more">▼ Collapse</button>' : '';

  const stops = route.points.slice(start, end + 1).map((p, k) => {
    const i = start + k;
    const cls = ['lm-stop', i === my && 'mine', i > my && 'after', (i === 0 || i === route.points.length - 1) && 'term'].filter(Boolean).join(' ');
    return `<div class="${cls}" style="top:${y(i) - ROW / 2}px"><span class="lm-dot"></span><span class="lm-name">${esc(titleCase(p.name))}${i === my ? ' <b>· you</b>' : ''}</span></div>`;
  }).join('');

  const clip = (a, b) => [Math.max(a, start), Math.min(b, end)];
  const gapEls = gaps.filter((g) => g.to <= my).map((g) => {
    const [a, b] = clip(g.from, g.to);
    if (b <= a) return '';
    return `<div class="lm-${g.kind}" style="top:${y(a)}px;height:${(b - a) * ROW}px" title="${g.kind === 'gap' ? 'Gap in service' : 'Bunched'}"></div>`;
  }).join('');

  const vehEls = vehicles.filter((v) => v.pos >= start && v.pos <= end).map((v) => {
    const d = eta.get(v);
    const tags = [];
    if (v.held) tags.push(`<span class="bad">held ${Math.round(v.heldMin)} min</span>`);
    if (d) tags.push(`${fmtTime(d.at)} at your stop`);
    else if (v.pos === my) tags.push('<span class="bad">at your stop now</span>');
    else if (v.pos > my) tags.push('<span class="muted">passed</span>');
    return `<div class="lm-veh${v.held ? ' held' : ''}${v.pos > my ? ' past' : ''}" style="top:${y(v.pos)}px">${modeOf(route.line)[0].toUpperCase()}</div>
      ${tags.length ? `<div class="lm-tag" style="top:${y(v.pos)}px">${tags.join(' · ')}</div>` : ''}`;
  }).join('');

  const relevant = lm.notices.filter((n) => n.mine || n.onRoute);
  const notices = lm.notices.length ? `
    <details class="lm-notices"${relevant.some((n) => n.mine) ? ' open' : ''}>
      <summary>⚠ ${lm.notices.length} STIB notice${lm.notices.length > 1 ? 's' : ''} on line ${esc(route.line)}${relevant.length ? ` · ${relevant.length} on your route` : ''}</summary>
      <ul>${lm.notices.slice(0, 8).map((n) => `<li class="${n.mine ? 'mine' : n.onRoute ? 'route' : ''}">${n.mine ? '<b>Your stop:</b> ' : ''}${esc(n.text)}</li>`).join('')}</ul>
    </details>` : '';

  return `
    <div class="lm-health ${health.level}">${esc(health.text)}</div>
    ${notices}
    <div class="lm-dir">→ ${esc(titleCase(route.dest))} · ${vehicles.length} vehicle${vehicles.length === 1 ? '' : 's'} in this direction</div>
    ${moreRow}
    <div class="lm" style="--lc:${color};height:${height}px">
      <div class="lm-track"></div>
      ${gapEls}${stops}${vehEls}
    </div>
    ${lm.error ? `<div class="lm-err">⚠ ${esc(lm.error)}</div>` : ''}`;
}
