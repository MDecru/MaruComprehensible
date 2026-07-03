// Immersion stats — full page (opened from the popup's Timer tab)

function _applyTheme(light) {
  document.body.classList.toggle('light-theme', !!light);
}
chrome.storage.local.get('light_theme', ({ light_theme }) => _applyTheme(light_theme));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.light_theme) _applyTheme(changes.light_theme.newValue);
});

const TIMER_DEFAULT_RESET_HOUR = 4;
const TIMER_CAP_SEC = 120 * 60; // ring visually "fills" at 2h
const CHART_DAYS = 60;
let _chartMode = 'day';

function _lightenHex(hex, amount) {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((num >> 16) & 0xff) + amount);
  const g = Math.min(255, ((num >> 8) & 0xff) + amount);
  const b = Math.min(255, (num & 0xff) + amount);
  return `rgb(${r},${g},${b})`;
}

const SITE_META = {
  yt:      { label: 'YouTube',              color: '#f87070' },
  cij:     { label: 'CIJ',                  color: '#66AAE8' },
  local:   { label: 'Local NAS (CIJ)',      color: '#2DD4BF' },
  njk:     { label: 'Nihongo-Jikan',         color: '#FDC281' },
  player:  { label: 'Local player',          color: '#9E8CF8' },
  manual:  { label: 'Manual / focus timer',  color: '#8890aa' },
  unknown: { label: 'Unknown source',        color: '#4a5068' },
};

function timerLogicalDay(ts, resetHour) {
  const d = new Date(ts - resetHour * 3600000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function timerParseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function timerKeyOffset(baseKey, offsetDays) {
  const dt = timerParseKey(baseKey);
  dt.setDate(dt.getDate() + offsetDays);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function timerFormatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}
function timerFmtChartDate(key) {
  return timerParseKey(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function timerFmtLogDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function timerGetResetHour() {
  const { mc_timer_settings = {} } = await chrome.storage.local.get('mc_timer_settings');
  return mc_timer_settings.resetHour ?? TIMER_DEFAULT_RESET_HOUR;
}

function timerComputeStreaks(daysMap, todayKey) {
  const keys = Object.keys(daysMap).filter(k => daysMap[k] > 0).sort();
  if (!keys.length) return { current: 0, longest: 0 };
  const set = new Set(keys);

  let longest = 0, run = 0, prev = null;
  for (const k of keys) {
    run = (prev && timerKeyOffset(prev, 1) === k) ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = k;
  }

  let cursor = set.has(todayKey) ? todayKey : timerKeyOffset(todayKey, -1);
  let current = 0;
  while (set.has(cursor)) { current++; cursor = timerKeyOffset(cursor, -1); }
  return { current, longest };
}

async function renderHero() {
  const [resetHour, { mc_timer_days = {} }] = await Promise.all([
    timerGetResetHour(),
    chrome.storage.local.get('mc_timer_days'),
  ]);
  const todayKey = timerLogicalDay(Date.now(), resetHour);
  const todaySec = mc_timer_days[todayKey] || 0;

  const CIRC = 2 * Math.PI * 52;
  const frac = Math.min(1, todaySec / TIMER_CAP_SEC);
  document.getElementById('arc').setAttribute('stroke-dasharray', `${(frac * CIRC).toFixed(1)} ${CIRC.toFixed(1)}`);
  document.getElementById('today-val').textContent = timerFormatDuration(todaySec);

  const allTimeSec = Object.values(mc_timer_days).reduce((a, b) => a + b, 0);
  const activeDays = Object.values(mc_timer_days).filter(s => s > 0).length;
  document.getElementById('alltime').textContent = timerFormatDuration(allTimeSec);
  document.getElementById('active-days').textContent = String(activeDays);

  const { current, longest } = timerComputeStreaks(mc_timer_days, todayKey);
  document.getElementById('cur-streak').textContent = `${current}d`;
  document.getElementById('long-streak').textContent = `${longest}d`;
}

async function renderBreakdown() {
  const el = document.getElementById('breakdown-list');
  const barEl = document.getElementById('breakdown-bar');
  const { mc_timer_site_totals = {}, mc_timer_days = {} } =
    await chrome.storage.local.get(['mc_timer_site_totals', 'mc_timer_days']);

  const entries = Object.entries(mc_timer_site_totals).filter(([, sec]) => sec > 0);
  const siteSum = entries.reduce((sum, [, sec]) => sum + sec, 0);
  const allTimeSec = Object.values(mc_timer_days).reduce((a, b) => a + b, 0);
  // Time tracked into the daily totals before per-source attribution existed
  // (or from any other gap between the two) shows up here instead of just
  // silently not adding up, so it's visible and can be resolved rather than
  // sitting there unexplained.
  const unknownSec = Math.max(0, allTimeSec - siteSum);
  // Ignore sub-minute discrepancies — these are just rounding/floating-point
  // noise from the 1-second accumulation interval, not real missing immersion.
  if (unknownSec > 60) entries.push(['unknown', unknownSec]);
  entries.sort((a, b) => b[1] - a[1]);

  if (!entries.length) {
    el.innerHTML = '<div class="bd-empty">No breakdown yet — data collects as you watch or log time.</div>';
    barEl.style.display = 'none';
    barEl.innerHTML = '';
    return;
  }
  const total = entries.reduce((sum, [, sec]) => sum + sec, 0);
  el.innerHTML = entries.map(([site, sec]) => {
    const meta = SITE_META[site] || { label: site, color: '#8890aa' };
    const pct = total > 0 ? Math.round(100 * sec / total) : 0;
    return `
      <div class="bd-row">
        <span class="bd-label"><span class="bd-dot" style="background:${meta.color}"></span>${meta.label}</span>
        <div class="bd-track"><div class="bd-fill" style="width:${pct}%;background:linear-gradient(to right,${meta.color},${_lightenHex(meta.color,80)})"></div></div>
        <span class="bd-val">${timerFormatDuration(sec)}<span class="pct">${pct}%</span></span>
        <button class="bd-clear" data-site="${site}" data-sec="${sec}" data-label="${meta.label.replace(/"/g, '&quot;')}" title="Clear ${meta.label} total">&#10005;</button>
      </div>`;
  }).join('');

  // Unrounded widths here (unlike the list above) so segments tile edge-to-edge
  // without visible gaps or overlap from independently-rounded percentages.
  barEl.style.display = 'flex';
  barEl.innerHTML = entries.map(([site, sec]) => {
    const meta = SITE_META[site] || { label: site, color: '#8890aa' };
    const pct = total > 0 ? (100 * sec / total) : 0;
    return `<div class="bd-bar-seg" style="width:${pct}%;background:${meta.color}" title="${meta.label} · ${timerFormatDuration(sec)}"></div>`;
  }).join('');
}

// Lets the user correct/remove passively auto-tracked time — manual log
// entries already have their own delete button, but automatic video-watch
// time has no per-session log, so editing is done at the day/source level.
async function editDayTime(dayKey, currentSec) {
  const currentMin = Math.round(currentSec / 60);
  const input = prompt(`Edit tracked time for ${dayKey}\n\nEnter new total in minutes (0 to clear):`, String(currentMin));
  if (input === null) return;
  const minutes = parseFloat(input);
  if (isNaN(minutes) || minutes < 0) { alert('Enter a number 0 or greater.'); return; }
  const { mc_timer_days = {} } = await chrome.storage.local.get('mc_timer_days');
  const newSec = Math.round(minutes * 60);
  if (newSec <= 0) delete mc_timer_days[dayKey];
  else mc_timer_days[dayKey] = newSec;
  await chrome.storage.local.set({ mc_timer_days });
}

async function clearSiteTotal(site, label) {
  if (!confirm(`Clear all tracked time for ${label}? This also removes that time from your daily totals and can't be undone.`)) return;
  const { mc_timer_site_totals = {}, mc_timer_days = {} } =
    await chrome.storage.local.get(['mc_timer_site_totals', 'mc_timer_days']);
  // Also remove the same amount from the daily totals (recent days first) —
  // otherwise the gap between daily totals and per-source totals instantly
  // reappears as an "Unknown source" row for the exact amount just deleted.
  let remaining = mc_timer_site_totals[site] || 0;
  delete mc_timer_site_totals[site];
  for (const day of Object.keys(mc_timer_days).sort().reverse()) {
    if (remaining <= 0) break;
    const take = Math.min(mc_timer_days[day], remaining);
    mc_timer_days[day] -= take;
    if (mc_timer_days[day] <= 0) delete mc_timer_days[day];
    remaining -= take;
  }
  await chrome.storage.local.set({ mc_timer_site_totals, mc_timer_days });
}

// "Unknown" isn't a real stored bucket — it's the gap between the daily
// totals and the sum of per-source totals. Clearing it removes that amount
// from the most recent days' totals (oldest-first isn't knowable — we don't
// track which day contributed the unattributed time) so the two stay
// consistent, rather than just deleting a number that doesn't exist anywhere.
async function clearUnknownTime(unknownSec) {
  if (unknownSec <= 0) return;
  if (!confirm(`Remove ${timerFormatDuration(unknownSec)} of unattributed tracked time? This reduces your most recent daily totals to close the gap and can't be undone.`)) return;
  const { mc_timer_days = {} } = await chrome.storage.local.get('mc_timer_days');
  let remaining = unknownSec;
  for (const day of Object.keys(mc_timer_days).sort().reverse()) {
    if (remaining <= 0) break;
    const cur = mc_timer_days[day];
    const take = Math.min(cur, remaining);
    mc_timer_days[day] = cur - take;
    if (mc_timer_days[day] <= 0) delete mc_timer_days[day];
    remaining -= take;
  }
  await chrome.storage.local.set({ mc_timer_days });
}

let _chartData = [];
let _chartStackData = []; // [{day, totalMin, segments: [{source, min}]}]
async function renderChart() {
  const svg = document.getElementById('chart');
  const [resetHour, { mc_timer_days = {}, mc_timer_source_days = {} }] = await Promise.all([
    timerGetResetHour(),
    chrome.storage.local.get(['mc_timer_days', 'mc_timer_source_days']),
  ]);
  const todayKey = timerLogicalDay(Date.now(), resetHour);
  const days = [];
  for (let i = CHART_DAYS - 1; i >= 0; i--) days.push(timerKeyOffset(todayKey, -i));
  const perDayMin = days.map(d => (mc_timer_days[d] || 0) / 60);
  let cum = 0;
  const cumMin = perDayMin.map(v => (cum += v));
  _chartData = days.map((d, i) => ({ day: d, perDay: perDayMin[i], cum: cumMin[i] }));

  // Build stacked data per day from mc_timer_source_days
  const sourceOrder = ['yt', 'cij', 'local', 'njk', 'player', 'manual'];
  _chartStackData = days.map(d => {
    const segments = [];
    let totalMin = 0;
    for (const src of sourceOrder) {
      const min = ((mc_timer_source_days[src] || {})[d] || 0) / 60;
      if (min > 0) { segments.push({ source: src, min }); totalMin += min; }
    }
    return { day: d, totalMin, segments };
  });

  const W = 640, H = 160, PAD = 8;
  let html = '';

  if (_chartMode === 'day') {
    // ── Stacked bar chart ──
    const barW = Math.max(2, (W - PAD * 2) / CHART_DAYS - 2);
    const gap = (W - PAD * 2) / CHART_DAYS;
    const maxTotal = Math.max(1, ..._chartStackData.map(d => d.totalMin));
    for (let i = 0; i < _chartStackData.length; i++) {
      const d = _chartStackData[i];
      const x = PAD + i * gap;
      let y = H - PAD;
      const totalH = (d.totalMin / maxTotal) * (H - PAD * 2);
      if (d.totalMin > 0 && d.segments.length === 1) {
        // Single source — simple bar
        const meta = SITE_META[d.segments[0].source] || { color: '#66AAE8' };
        html += `<rect x="${x.toFixed(1)}" y="${(y - totalH).toFixed(1)}" width="${barW.toFixed(1)}" height="${totalH.toFixed(1)}" fill="${meta.color}" rx="2"/>`;
      } else if (d.totalMin > 0) {
        // Multiple sources — stacked segments
        let segY = y;
        for (let s = d.segments.length - 1; s >= 0; s--) {
          const seg = d.segments[s];
          const meta = SITE_META[seg.source] || { color: '#66AAE8' };
          const segH = (seg.min / maxTotal) * (H - PAD * 2);
          segY -= segH;
          html += `<rect x="${x.toFixed(1)}" y="${segY.toFixed(1)}" width="${barW.toFixed(1)}" height="${(segH + 0.5).toFixed(1)}" fill="${meta.color}"/>`;
        }
      }
    }
  } else {
    // ── Cumulative line ──
    const values = cumMin;
    const maxV = Math.max(1, ...values);
    const stepX = (W - PAD * 2) / (CHART_DAYS - 1);
    const pts = values.map((v, i) => [
      PAD + i * stepX,
      H - PAD - (v / maxV) * (H - PAD * 2),
    ]);
    const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const areaD = `${pathD} L${pts[pts.length - 1][0].toFixed(1)},${H - PAD} L${pts[0][0].toFixed(1)},${H - PAD} Z`;
    html += '<defs><linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#66AAE8"/><stop offset="100%" stop-color="#a0d4f4"/></linearGradient></defs>';
    html += `<path d="${areaD}" fill="rgba(102,170,232,.14)" stroke="none"></path>`;
    html += `<path d="${pathD}" fill="none" stroke="url(#lineGrad)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="8 4"></path>`;
  }

  svg.innerHTML = html;
  // Store hit-test points for tooltip
  if (_chartMode === 'day') {
    const gap = (W - PAD * 2) / CHART_DAYS;
    const barW = Math.max(2, gap - 2);
    const maxTotal = Math.max(1, ..._chartStackData.map(d => d.totalMin));
    const pts = _chartStackData.map((d, i) => {
      const x = PAD + i * gap + barW / 2;
      const totalH = (d.totalMin / maxTotal) * (H - PAD * 2);
      return [x, H - PAD - totalH];
    });
    svg.dataset.pts = JSON.stringify(pts);
  } else {
    const values = cumMin;
    const maxV = Math.max(1, ...values);
    const stepX = (W - PAD * 2) / (CHART_DAYS - 1);
    const pts = values.map((v, i) => [PAD + i * stepX, H - PAD - (v / maxV) * (H - PAD * 2)]);
    svg.dataset.pts = JSON.stringify(pts);
  }
}

async function renderGrid() {
  const container = document.getElementById('grid');
  const [resetHour, { mc_timer_days = {} }] = await Promise.all([
    timerGetResetHour(),
    chrome.storage.local.get('mc_timer_days'),
  ]);
  const todayKey = timerLogicalDay(Date.now(), resetHour);
  const todayDow = timerParseKey(todayKey).getDay();

  const cellSize = 11, gap = 3;
  const availWidth = container.parentElement.clientWidth || 620;
  const cols = Math.max(20, Math.floor((availWidth + gap) / (cellSize + gap)));

  const endSunday = timerKeyOffset(todayKey, -todayDow);
  const startSunday = timerKeyOffset(endSunday, -(cols - 1) * 7);

  const frag = document.createDocumentFragment();
  for (let col = 0; col < cols; col++) {
    const weekStart = timerKeyOffset(startSunday, col * 7);
    for (let row = 0; row < 7; row++) {
      const dayKey = timerKeyOffset(weekStart, row);
      const cell = document.createElement('div');
      if (dayKey > todayKey) {
        cell.className = 'cell blank';
      } else {
        const sec = mc_timer_days[dayKey] || 0;
        const tier = sec <= 0 ? 0 : sec < 600 ? 1 : sec < 1800 ? 2 : sec < 3600 ? 3 : 4;
        cell.className = `cell${tier ? ` t${tier}` : ''}`;
        if (sec > 0) {
          cell.classList.add('editable');
          cell.title = `${dayKey} · ${timerFormatDuration(sec)} — click to edit`;
          cell.addEventListener('click', () => editDayTime(dayKey, sec));
        } else {
          cell.title = dayKey;
        }
      }
      frag.appendChild(cell);
    }
  }
  container.innerHTML = '';
  container.appendChild(frag);
}

function renderLog(log) {
  const el = document.getElementById('log-list');
  if (!log.length) { el.innerHTML = '<div class="log-empty">No manual entries yet</div>'; return; }
  el.innerHTML = log.slice(0, 20).map(e => `
    <div class="log-row">
      <span class="log-src">${(e.source || 'Manual').replace(/</g, '&lt;')}</span>
      <span class="log-date">${timerFmtLogDate(e.ts)}</span>
      <span class="log-min">${e.minutes}m</span>
      <button class="log-del" data-id="${e.id}" title="Remove">&#10005;</button>
    </div>`).join('');
}

async function addEntry(source, minutes) {
  const [resetHour, { mc_timer_days = {}, mc_timer_log = [], mc_timer_site_totals = {}, mc_timer_source_days = {} }] = await Promise.all([
    timerGetResetHour(),
    chrome.storage.local.get(['mc_timer_days', 'mc_timer_log', 'mc_timer_site_totals', 'mc_timer_source_days']),
  ]);
  const now = Date.now();
  const day = timerLogicalDay(now, resetHour);
  const sec = Math.round(minutes * 60);
  mc_timer_days[day] = (mc_timer_days[day] || 0) + sec;
  mc_timer_site_totals.manual = (mc_timer_site_totals.manual || 0) + sec;
  mc_timer_source_days.manual = mc_timer_source_days.manual || {};
  mc_timer_source_days.manual[day] = (mc_timer_source_days.manual[day] || 0) + sec;
  const entry = { id: `${now}_${Math.random().toString(36).slice(2, 7)}`, ts: now, day, source, minutes };
  const log = [entry, ...mc_timer_log].slice(0, 60);
  await chrome.storage.local.set({ mc_timer_days, mc_timer_log: log, mc_timer_site_totals, mc_timer_source_days });
}

async function removeEntry(id) {
  const { mc_timer_days = {}, mc_timer_log = [], mc_timer_site_totals = {}, mc_timer_source_days = {} } =
    await chrome.storage.local.get(['mc_timer_days', 'mc_timer_log', 'mc_timer_site_totals', 'mc_timer_source_days']);
  const entry = mc_timer_log.find(e => e.id === id);
  if (!entry) return;
  const remaining = mc_timer_log.filter(e => e.id !== id);
  const secToRemove = Math.round(entry.minutes * 60);
  mc_timer_days[entry.day] = Math.max(0, (mc_timer_days[entry.day] || 0) - secToRemove);
  if (mc_timer_days[entry.day] === 0) delete mc_timer_days[entry.day];
  mc_timer_site_totals.manual = Math.max(0, (mc_timer_site_totals.manual || 0) - secToRemove);
  if (mc_timer_source_days.manual?.[entry.day]) {
    mc_timer_source_days.manual[entry.day] = Math.max(0, mc_timer_source_days.manual[entry.day] - secToRemove);
    if (mc_timer_source_days.manual[entry.day] === 0) delete mc_timer_source_days.manual[entry.day];
  }
  await chrome.storage.local.set({ mc_timer_days, mc_timer_log: remaining, mc_timer_site_totals, mc_timer_source_days });
}

const TIMER_HEARTBEAT_STALE_MS = 5000;
async function refreshTrackDot() {
  const dot = document.getElementById('track-dot');
  const { mc_timer_last_active = 0 } = await chrome.storage.local.get('mc_timer_last_active');
  dot.classList.toggle('on', Date.now() - mc_timer_last_active < TIMER_HEARTBEAT_STALE_MS);
}

async function init() {
  const { mc_timer_log = [] } = await chrome.storage.local.get('mc_timer_log');

  renderLog(mc_timer_log);
  await renderHero();
  await renderBreakdown();
  await renderChart();
  await renderGrid();
  refreshTrackDot();
  setInterval(refreshTrackDot, 2000);

  const srcInput = document.getElementById('src-input');
  const minInput = document.getElementById('min-input');
  document.getElementById('add-btn').addEventListener('click', async () => {
    const minutes = parseFloat(minInput.value);
    if (!minutes || minutes <= 0) return;
    const source = srcInput.value.trim() || 'Manual';
    await addEntry(source, minutes);
    srcInput.value = ''; minInput.value = '';
  });

  document.getElementById('log-list').addEventListener('click', async e => {
    const btn = e.target.closest('.log-del');
    if (!btn) return;
    await removeEntry(btn.dataset.id);
  });

  document.getElementById('breakdown-list').addEventListener('click', async e => {
    const btn = e.target.closest('.bd-clear');
    if (!btn) return;
    if (btn.dataset.site === 'unknown') {
      await clearUnknownTime(parseInt(btn.dataset.sec, 10) || 0);
    } else {
      await clearSiteTotal(btn.dataset.site, btn.dataset.label);
    }
  });

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _chartMode = btn.dataset.mode;
      renderChart();
    });
  });

  const chartWrap = document.querySelector('.chart-wrap');
  const chartSvg = document.getElementById('chart');
  const tooltip = document.getElementById('tooltip');
  chartWrap.addEventListener('mousemove', e => {
    const pts = JSON.parse(chartSvg.dataset.pts || '[]');
    if (!pts.length) return;
    const rect = chartSvg.getBoundingClientRect();
    const xIn = (e.clientX - rect.left) * (640 / rect.width);
    let idx = 0, best = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(p[0] - xIn); if (d < best) { best = d; idx = i; } });
    const d = _chartData[idx];
    if (!d) return;
    const val = _chartMode === 'day' ? d.perDay : d.cum;
    let tipText = `${timerFmtChartDate(d.day)} · ${timerFormatDuration(val * 60)}`;
    if (_chartMode === 'day' && _chartStackData[idx]?.segments.length) {
      tipText += ' — ' + _chartStackData[idx].segments.map(s => {
        const meta = SITE_META[s.source] || { label: s.source, color: '#888' };
        return `${meta.label}: ${timerFormatDuration(s.min * 60)}`;
      }).join(', ');
    }
    tooltip.textContent = tipText;
    tooltip.style.left = `${pts[idx][0] * (rect.width / 640)}px`;
    tooltip.style.top = `${pts[idx][1] * (rect.height / 160)}px`;
    tooltip.style.opacity = '1';
  });
  chartWrap.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; });

  window.addEventListener('resize', renderGrid);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.mc_timer_days || changes.mc_timer_settings) {
      renderHero();
      renderChart();
      renderGrid();
    }
    if (changes.mc_timer_log) renderLog(changes.mc_timer_log.newValue || []);
    // "Unknown" is derived from both keys, so either changing means it may need to update.
    if (changes.mc_timer_site_totals || changes.mc_timer_days) renderBreakdown();
    if (changes.mc_timer_last_active) refreshTrackDot();
  });
}

document.addEventListener('DOMContentLoaded', init);
