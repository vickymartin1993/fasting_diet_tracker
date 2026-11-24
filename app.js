'use strict';
const FILE = 'meal-data.json';
const KEY = 'mt2-data', DIRTY = 'mt2-dirty';
const $ = id => document.getElementById(id);
const DEFAULTS = { target: 80, base: 12, goodMin: 14, goodMax: 16, dinnerGoal: 18, dinnerMax: 19 };

// ---------- model ----------
// data = { version:2, settings:{...,updated}, days:{ 'YYYY-MM-DD': {breakfast,lunch,dinner,extra,acv,weight,energy,hunger,sleep,notes,updated,deleted?} } }
function emptyData() { return { version: 2, settings: { ...DEFAULTS, updated: 0 }, days: {} }; }
function normalize(d) {
  if (!d || typeof d !== 'object') return emptyData();
  if (!d.days) { const days = {}; for (const k in d) if (/^\d{4}-\d\d-\d\d$/.test(k)) days[k] = { ...d[k], updated: d[k].updated || 1 }; d = { days }; }
  return { version: 2, settings: { ...DEFAULTS, updated: 0, ...(d.settings || {}) }, days: d.days || {} };
}
function loadLocal() {
  try { return normalize(JSON.parse(localStorage.getItem(KEY) || localStorage.getItem('mt-data') || 'null')); }
  catch (e) { return emptyData(); }
}
let data = loadLocal();
let rangeDays = +(localStorage.getItem('mt2-range') || 30);
const S = () => data.settings;

function merge(a, b) {
  const out = emptyData();
  out.settings = (b.settings.updated || 0) > (a.settings.updated || 0) ? { ...b.settings } : { ...a.settings };
  for (const src of [a, b]) for (const d in src.days) {
    const cur = out.days[d];
    if (!cur || (src.days[d].updated || 0) > (cur.updated || 0)) out.days[d] = src.days[d];
  }
  return out;
}
// true if `a` holds anything `b` lacks (so b needs updating)
function newerThan(a, b) {
  if ((a.settings.updated || 0) > (b.settings.updated || 0)) return true;
  for (const d in a.days) if (!b.days[d] || (a.days[d].updated || 0) > (b.days[d].updated || 0)) return true;
  return false;
}
const live = () => Object.keys(data.days).filter(d => !data.days[d].deleted).sort();
const entry = d => (data.days[d] && !data.days[d].deleted) ? data.days[d] : null;

// ---------- time helpers ----------
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const at = (date, t) => new Date(`${date}T${t}:00`);
const hm = t => { const [h, m] = t.split(':').map(Number); return h + m / 60; };
const lastMeal = e => [e.extra, e.dinner, e.lunch, e.breakfast].filter(Boolean).sort().pop();
const fmtHM = h => `${Math.floor(h)}h ${pad(Math.round((h % 1) * 60) % 60)}m`;
const fmtClock = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDur = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };

function fastingHours(date) {
  const prev = entry(addDays(date, -1)), cur = entry(date);
  if (!prev || !cur || !cur.breakfast) return null;
  const lm = lastMeal(prev);
  if (!lm) return null;
  const h = (at(date, cur.breakfast) - at(addDays(date, -1), lm)) / 36e5;
  return h > 0 ? h : null;
}
function zone(h) {
  const s = S();
  if (h < s.base) return { c: '#ef4444', t: 'Too short', msg: 'Below baseline – try to push the fast longer.' };
  if (h < s.goodMin) return { c: '#f59e0b', t: 'Baseline', msg: 'Baseline reached – keep going to the sweet spot.' };
  if (h <= s.goodMax) return { c: '#22c55e', t: 'Sweet spot', msg: 'Right where you want to be. 🎯' };
  return { c: '#7c3aed', t: 'Riskier', msg: 'Above the recommended range – consider breaking your fast.' };
}
const allFasts = () => live().map(d => ({ d, h: fastingHours(d) })).filter(x => x.h !== null);

// ---------- sync (gist) ----------
const token = () => localStorage.getItem('mt-token');
const gistId = () => localStorage.getItem('mt-gist');
const isDirty = () => localStorage.getItem(DIRTY) === '1';
let chain = Promise.resolve(), syncState = { ok: null, msg: '' };

async function gh(path, opts = {}) {
  const r = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token(), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }
  });
  if (!r.ok) { const e = new Error(`GitHub ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}
async function findGist() {
  for (let p = 1; p <= 10; p++) {
    const list = await gh(`/gists?per_page=100&page=${p}`);
    const hit = list.find(g => g.files && g.files[FILE]);
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  return null;
}
async function readRemote(id) {
  const g = await gh('/gists/' + id);
  const f = g.files[FILE];
  if (!f) return emptyData();
  const raw = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
  return normalize(JSON.parse(raw)); // throws on bad JSON -> we abort instead of overwriting
}
const writeRemote = (id, d) => gh('/gists/' + id, { method: 'PATCH', body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(d, null, 1) } } }) });

function persist() { localStorage.setItem(KEY, JSON.stringify(data)); }
function sync() {
  chain = chain.then(doSync).catch(() => {});
  return chain;
}
async function doSync() {
  if (!token()) { syncState = { ok: false, msg: 'No token – data is only on this device.' }; return renderStatus(); }
  try {
    let id = gistId();
    if (!id) {
      id = await findGist();
      if (!id) {
        const g = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: 'Meal tracker data', public: false, files: { [FILE]: { content: JSON.stringify(data, null, 1) } } }) });
        id = g.id;
      }
      localStorage.setItem('mt-gist', id); $('gistId').value = id;
    }
    const remote = await readRemote(id);
    const merged = merge(data, remote);
    const changedLocal = newerThan(merged, data);
    data = merged; persist();
    if (newerThan(merged, remote)) await writeRemote(id, merged);
    localStorage.setItem(DIRTY, '0');
    syncState = { ok: true, msg: 'Synced ' + new Date().toLocaleTimeString() };
    if (changedLocal) { render(); fillForm(); }
  } catch (e) {
    const why = e.status === 401 ? 'token invalid/expired' : e.status === 404 ? 'gist not found (check Gist ID)' : e.message;
    syncState = { ok: false, msg: 'Sync failed: ' + why + '. Data is safe on this device and will retry.' };
  }
  renderStatus();
}
function renderStatus() {
  $('status').textContent = syncState.msg;
  const b = $('banner');
  if (!token()) { b.className = ''; b.style.display = 'block'; b.textContent = '⚠️ Backup is OFF. Add a GitHub token in "Backup & sync" so your data survives a phone reset or cleared browser.'; }
  else if (syncState.ok === false) { b.className = 'err'; b.style.display = 'block'; b.textContent = '⚠️ ' + syncState.msg; }
  else if (isDirty()) { b.className = ''; b.style.display = 'block'; b.textContent = 'Changes not yet backed up – syncing…'; }
  else b.style.display = 'none';
}

// ---------- hero ----------
function hero() {
  const el = $('hero'), now = new Date(), today = ymd(now), te = entry(today);
  const s = S();
  // latest logged intake that is not in the future
  let last = null;
  for (const d of live().reverse()) {
    const lm = lastMeal(data.days[d]); if (!lm) continue;
    const t = at(d, lm);
    if (t <= now) { last = t; break; }
  }
  const dinnerDone = te && te.dinner && at(today, te.dinner) <= now;
  const fasting = last && ((!(te && te.breakfast) && now.getHours() < 12) || dinnerDone);
  const fasts = allFasts();
  const best = fasts.reduce((m, x) => (!m || x.h > m.h ? x : m), null);
  const pills = [];
  if (best) pills.push(`🏆 Best: ${fmtHM(best.h)} (${best.d})`);

  if (fasting) {
    const h = (now - last) / 36e5, z = zone(h);
    const next = h < s.goodMin ? s.goodMin : h < s.goodMax ? s.goodMax : null;
    const prog = Math.min(100, (h / s.goodMin) * 100);
    el.style.background = z.c;
    el.innerHTML = `<div class="sub">Fasting since ${fmtClock(last)}</div><div class="big">${fmtDur(now - last)}</div>
      <div class="sub">${z.t} · ${z.msg}</div><div class="bar"><i style="width:${prog}%"></i></div>
      <div class="sub">${next ? `${fmtHM(next - h)} to ${next}h (at ${fmtClock(new Date(last.getTime() + next * 36e5))})` : 'Past your upper limit of ' + s.goodMax + 'h'}</div>
      <div class="pills">${pills.map(p => `<span>${p}</span>`).join('')}</div>`;
  } else {
    const y = fasts.length ? (fastingHours(today) !== null ? { d: today, h: fastingHours(today) } : fasts[fasts.length - 1]) : null;
    if (!y) { el.style.background = '#475569'; el.innerHTML = `<div class="big">🍽️</div><div class="sub">Log your meals to start tracking fasts.</div>`; return; }
    const z = zone(y.h);
    const l7 = fasts.slice(-7), avg = l7.reduce((a, x) => a + x.h, 0) / l7.length;
    el.style.background = z.c;
    el.innerHTML = `<div class="sub">${y.d === today ? "Last night's fast" : 'Last fast (' + y.d + ')'}</div><div class="big">${fmtHM(y.h)}</div>
      <div class="sub">${z.t} · ${z.msg}</div>
      <div class="pills">${pills.concat([`7-day avg: ${fmtHM(avg)}`]).map(p => `<span>${p}</span>`).join('')}</div>`;
  }
}

// ---------- charts ----------
let charts = {};
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function rangeDates() {
  const d = live(); if (!d.length) return [];
  const end = ymd(new Date()), first = d[0];
  let start = rangeDays ? addDays(end, -(rangeDays - 1)) : first;
  if (start < first && rangeDays) start = first < start ? start : first;
  const out = []; for (let x = start; x <= end; x = addDays(x, 1)) out.push(x);
  return out;
}
function draw(id, cfg) {
  charts[id] && charts[id].destroy();
  cfg.options = { responsive: true, maintainAspectRatio: false, ...cfg.options };
  charts[id] = new Chart($(id), cfg);
}
const line = (label, v, color, dash) => ({ type: 'line', label, data: v, borderColor: color, borderDash: dash, pointRadius: 0, borderWidth: 1.5, fill: false });

function renderCharts(dates) {
  Chart.defaults.color = css('--muted'); Chart.defaults.borderColor = css('--line');
  const s = S();
  const fh = dates.map(d => fastingHours(d));
  const fill = v => dates.map(() => v);
  draw('fastChart', { type: 'bar', data: { labels: dates, datasets: [
    { label: 'Fasting hours', data: fh.map(h => h === null ? null : +h.toFixed(2)), backgroundColor: fh.map(h => h === null ? '#0000' : zone(h).c), order: 2 },
    line(s.goodMin + 'h', fill(s.goodMin), '#22c55e', [5, 4]), line(s.goodMax + 'h', fill(s.goodMax), '#7c3aed', [5, 4])] },
    options: { scales: { y: { beginAtZero: true, suggestedMax: 18 } }, plugins: { legend: { display: false } } } });

  const wt = dates.map(d => entry(d)?.weight ?? null);
  const ma = dates.map((d, i) => { const w = wt.slice(Math.max(0, i - 6), i + 1).filter(x => x !== null); return w.length ? +(w.reduce((a, b) => a + b, 0) / w.length).toFixed(2) : null; });
  draw('weightChart', { type: 'line', data: { labels: dates, datasets: [
    { label: 'Weight', data: wt, borderColor: '#2563eb', backgroundColor: '#2563eb', spanGaps: true, tension: .2, pointRadius: 3 },
    line('7-day avg', ma, '#f59e0b'), line('Target ' + s.target, fill(s.target), '#22c55e', [6, 4])] },
    options: { plugins: { legend: { display: true } } } });
  charts.weightChart.data.datasets[1].spanGaps = true;

  const dn = dates.map(d => { const e = entry(d); return e && e.dinner ? hm(e.dinner) : null; });
  const fmtH = v => `${Math.floor(v)}:${pad(Math.round((v % 1) * 60))}`;
  draw('dinnerChart', { type: 'line', data: { labels: dates, datasets: [
    { label: 'Dinner', data: dn, borderColor: '#64748b', showLine: false, pointRadius: 5, pointBackgroundColor: dn.map(v => v === null ? '#0000' : v > s.dinnerMax ? '#ef4444' : v > s.dinnerGoal ? '#f59e0b' : '#22c55e') },
    line('Goal', fill(s.dinnerGoal), '#22c55e', [5, 4]), line('Limit', fill(s.dinnerMax), '#ef4444', [5, 4])] },
    options: { scales: { y: { suggestedMin: 15, suggestedMax: 21, ticks: { callback: fmtH } } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmtH(c.parsed.y) } } } } });
}

function renderCards(dates) {
  const s = S(), all = live();
  const fs = dates.map(d => ({ d, h: fastingHours(d) })).filter(x => x.h !== null);
  const avg = fs.length ? fs.reduce((a, x) => a + x.h, 0) / fs.length : null;
  const good = fs.length ? Math.round(100 * fs.filter(x => x.h >= s.goodMin && x.h <= s.goodMax).length / fs.length) : null;
  const best = allFasts().reduce((m, x) => (!m || x.h > m ? x.h : m), null);
  let streak = 0;
  for (let d = ymd(new Date()); ; d = addDays(d, -1)) {
    const e = entry(d);
    if (!e || !e.dinner) { if (d === ymd(new Date())) continue; break; }
    if (hm(e.dinner) <= s.dinnerGoal) streak++; else break;
  }
  const inR = dates.map(entry).filter(e => e && e.breakfast);
  const acv = inR.length ? Math.round(100 * inR.filter(e => e.acv).length / inR.length) : null;
  const w = all.filter(d => data.days[d].weight);
  const cur = w.length ? data.days[w[w.length - 1]].weight : null, first = w.length ? data.days[w[0]].weight : null;
  const c = [
    ['Avg fast', avg === null ? '–' : fmtHM(avg), `${rangeDays ? rangeDays + 'd' : 'all'}`],
    ['In ' + s.goodMin + '–' + s.goodMax + 'h zone', good === null ? '–' : good + '%', 'of fasts'],
    ['Best fast', best === null ? '–' : fmtHM(best), 'all time'],
    ['Dinner ≤ ' + fmtClockH(s.dinnerGoal) + ' streak', streak + ' d', 'in a row'],
    ['ACV taken', acv === null ? '–' : acv + '%', 'of breakfasts'],
    ['Weight', cur === null ? '–' : cur + ' kg', cur === null ? '' : (cur - first >= 0 ? '+' : '') + (cur - first).toFixed(1) + ' since start'],
    ['To target', cur === null ? '–' : (cur - s.target).toFixed(1) + ' kg', 'target ' + s.target]
  ];
  $('cards').innerHTML = c.map(x => `<div class="card"><small>${x[0]}</small><b>${x[1]}</b><small>${x[2]}</small></div>`).join('');
  const L = [['#ef4444', `<${s.base}h`], ['#f59e0b', `${s.base}–${s.goodMin}h baseline`], ['#22c55e', `${s.goodMin}–${s.goodMax}h good`], ['#7c3aed', `>${s.goodMax}h riskier`]];
  $('legend').innerHTML = L.map(l => `<span><i class="dot" style="background:${l[0]}"></i>${l[1]}</span>`).join('');
}
const fmtClockH = v => `${Math.floor(v) % 12 || 12}${v % 1 ? ':' + pad(Math.round((v % 1) * 60)) : ''} ${v >= 12 ? 'pm' : 'am'}`;

function renderHistory() {
  const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  $('hist').innerHTML = '<tr><th>Date</th><th>Bkfst</th><th>ACV</th><th>Lunch</th><th>Dinner</th><th>Snack</th><th>Kg</th><th>Fast</th><th>E/H</th></tr>' +
    live().reverse().map(d => { const e = data.days[d], h = fastingHours(d);
      return `<tr class="clk" data-d="${d}"><td>${d}</td><td>${e.breakfast || ''}</td><td>${e.acv ? '✅' : ''}</td><td>${e.lunch || ''}</td><td>${e.dinner || ''}</td><td>${e.extra || ''}</td><td>${e.weight ?? ''}</td>
      <td style="color:${h === null ? 'inherit' : zone(h).c};font-weight:600">${h === null ? '' : h.toFixed(1)}</td><td title="${esc(e.notes || '')}">${e.energy || '·'}/${e.hunger || '·'}${e.notes ? ' 📝' : ''}</td></tr>`; }).join('');
  document.querySelectorAll('#hist tr.clk').forEach(tr => tr.onclick = () => { $('date').value = tr.dataset.d; fillForm(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
}

function render() {
  const dates = rangeDates();
  document.querySelectorAll('#ranges button').forEach(b => b.classList.toggle('on', +b.dataset.r === rangeDays));
  renderCards(dates); renderCharts(dates); renderHistory(); hero(); renderStatus();
}

// ---------- form ----------
const TIMES = ['breakfast', 'lunch', 'dinner', 'extra'];
function fillForm() {
  const e = entry($('date').value) || {};
  TIMES.forEach(k => $(k).value = e[k] || '');
  $('acv').checked = !!e.acv; $('weight').value = e.weight ?? '';
  $('energy').value = e.energy ?? ''; $('hunger').value = e.hunger ?? ''; $('sleep').value = e.sleep ?? ''; $('notes').value = e.notes || '';
  checkDinner(); $('saveMsg').textContent = '';
}
function checkDinner() {
  const v = $('dinner').value, m = $('dinnerMsg'), s = S();
  m.className = ''; m.textContent = '';
  if (!v) return;
  if (hm(v) > s.dinnerMax) { m.className = 'bad'; m.textContent = `After ${fmtClockH(s.dinnerMax)} – too late!`; }
  else if (hm(v) > s.dinnerGoal) { m.className = 'warn'; m.textContent = `After ${fmtClockH(s.dinnerGoal)} – try earlier.`; }
}
function commit() { persist(); localStorage.setItem(DIRTY, '1'); render(); sync(); }

$('save').onclick = () => {
  const d = $('date').value; if (!d) return;
  const e = {};
  TIMES.forEach(k => { if ($(k).value) e[k] = $(k).value; });
  if ($('acv').checked) e.acv = true;
  if ($('weight').value) e.weight = parseFloat($('weight').value);
  if ($('energy').value) e.energy = +$('energy').value;
  if ($('hunger').value) e.hunger = +$('hunger').value;
  if ($('sleep').value) e.sleep = parseFloat($('sleep').value);
  if ($('notes').value.trim()) e.notes = $('notes').value.trim();
  if (!Object.keys(e).length) { $('saveMsg').textContent = 'Nothing to save.'; return; }
  e.updated = Date.now();
  data.days[d] = e; commit();
  $('saveMsg').textContent = 'Saved ✔';
};
$('del').onclick = () => {
  const d = $('date').value;
  if (entry(d) && confirm('Delete ' + d + '?')) { data.days[d] = { deleted: true, updated: Date.now() }; fillForm(); commit(); }
};
$('date').onchange = fillForm;
$('dinner').oninput = checkDinner;
$('prev').onclick = () => { $('date').value = addDays($('date').value, -1); fillForm(); };
$('next').onclick = () => { $('date').value = addDays($('date').value, 1); fillForm(); };
$('todayBtn').onclick = () => { $('date').value = ymd(new Date()); fillForm(); };
document.querySelectorAll('[data-now]').forEach(b => b.onclick = () => { const n = new Date(); $(b.dataset.now).value = `${pad(n.getHours())}:${pad(n.getMinutes())}`; checkDinner(); });
document.querySelectorAll('#ranges button').forEach(b => b.onclick = () => { rangeDays = +b.dataset.r; localStorage.setItem('mt2-range', rangeDays); render(); });

// ---------- settings / backup ----------
function fillSettings() {
  const s = S();
  $('s_target').value = s.target; $('s_base').value = s.base; $('s_goodMin').value = s.goodMin; $('s_goodMax').value = s.goodMax;
  $('s_dinnerGoal').value = s.dinnerGoal; $('s_dinnerMax').value = s.dinnerMax;
}
$('saveTargets').onclick = () => {
  const v = id => parseFloat($(id).value);
  const n = { target: v('s_target'), base: v('s_base'), goodMin: v('s_goodMin'), goodMax: v('s_goodMax'), dinnerGoal: v('s_dinnerGoal'), dinnerMax: v('s_dinnerMax') };
  if (Object.values(n).some(isNaN)) return alert('Fill all target fields.');
  data.settings = { ...n, updated: Date.now() }; commit(); fillForm();
};
$('saveSettings').onclick = () => {
  localStorage.setItem('mt-token', $('token').value.trim());
  localStorage.setItem('mt-gist', $('gistId').value.trim());
  syncState = { ok: null, msg: 'Syncing…' }; renderStatus(); sync();
};
$('syncNow').onclick = () => { syncState = { ok: null, msg: 'Syncing…' }; renderStatus(); sync(); };
$('forget').onclick = () => {
  if (confirm('Remove the token from this browser? Data stays in the gist and on this device.')) { localStorage.removeItem('mt-token'); $('token').value = ''; syncState = { ok: false, msg: 'Token removed.' }; renderStatus(); }
};
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
}
$('expJson').onclick = () => download(`meal-tracker-${ymd(new Date())}.json`, JSON.stringify(data, null, 1), 'application/json');
$('expCsv').onclick = () => {
  const cols = ['date', 'breakfast', 'acv', 'lunch', 'dinner', 'extra', 'weight', 'fasting_hours', 'energy', 'hunger', 'sleep', 'notes'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = live().map(d => { const e = data.days[d], h = fastingHours(d); return [d, e.breakfast, e.acv ? 1 : 0, e.lunch, e.dinner, e.extra, e.weight, h === null ? '' : h.toFixed(2), e.energy, e.hunger, e.sleep, e.notes].map(q).join(','); });
  download(`meal-tracker-${ymd(new Date())}.csv`, [cols.join(','), ...rows].join('\n'), 'text/csv');
};
$('imp').onchange = async ev => {
  try {
    const inc = normalize(JSON.parse(await ev.target.files[0].text()));
    data = merge(data, inc); commit(); fillSettings(); fillForm(); alert('Imported and merged.');
  } catch (e) { alert('Invalid backup file.'); }
  ev.target.value = '';
};

// ---------- theme / pwa / boot ----------
function setTheme(t) { document.documentElement.dataset.theme = t; localStorage.setItem('mt2-theme', t); }
setTheme(localStorage.getItem('mt2-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('theme').onclick = () => { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); render(); };

$('date').value = ymd(new Date());
$('token').value = token() || ''; $('gistId').value = gistId() || '';
fillSettings(); render(); fillForm();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js');
setInterval(hero, 1000);
setInterval(sync, 5 * 60 * 1000);
addEventListener('online', sync);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { hero(); sync(); } });
sync();
