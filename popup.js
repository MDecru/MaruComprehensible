const MM_BASE = 'https://public-api.marumori.io';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchItems(path, token) {
  const r = await fetch(`${MM_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return (d.items || []).map(x => typeof x === 'string' ? { item: x } : x);
}

async function fetchAllVocab(token) {
  // 2 sequential requests (MM rate-limits aggressively)
  // with-status=true returns real levels + a status field per item
  // instead of the old sentinel level=9001 for known items.
  const kanjiItems = await fetchItems('/known/kanji?with-status=true', token);      await sleep(1100);
  const vocabItems = await fetchItems('/known/vocabulary?with-status=true', token);

  // Deduplicate by item name, keeping the full {item, level, status} objects.
  const seenK = new Map(); for (const k of kanjiItems) seenK.set(k.item, k);
  const seenV = new Map(); for (const v of vocabItems) seenV.set(v.item, v);
  const kanji = [...seenK.values()];
  const vocab = [...seenV.values()];
  return { kanji, vocab };
}

let _scoreColorsEnabled = false;
let _lastScoreArgs = null;

function _scoreColor(pct) {
  if (pct == null) return null;
  if (pct < 50)  return '#ED7989'; // red
  if (pct < 70)  return '#FDC281'; // amber
  if (pct < 95)  return '#72CE9D'; // green
  return '#7E69F0';                 // purple
}

function setStatus(text, color) {
  const el = document.getElementById('connect-status') || document.getElementById('status');
  if (el) { el.textContent = text; el.style.color = color || '#666'; }
}

function setScore(pct, freqKnown, freqTotal, uniqueKnown, uniqueTotal, kanjiKnown, kanjiTotal) {
  _lastScoreArgs = [pct, freqKnown, freqTotal, uniqueKnown, uniqueTotal, kanjiKnown, kanjiTotal];
  const stat = document.getElementById('status');
  const CIRC = 2 * Math.PI * 30;

  function _ring(arcId, pctId, countId, value, known, total, fixedColor) {
    const arc = document.getElementById(arcId);
    const pctEl = document.getElementById(pctId);
    const countEl = document.getElementById(countId);
    if (!arc || !pctEl) return;
    if (value == null) {
      arc.setAttribute('stroke-dasharray', `0 ${CIRC.toFixed(1)}`);
      arc.setAttribute('stroke', fixedColor);
      pctEl.textContent = '—'; pctEl.className = 'ring-pct empty';
      if (countEl) countEl.textContent = '';
      return;
    }
    arc.setAttribute('stroke-dasharray', `${((value / 100) * CIRC).toFixed(1)} ${CIRC.toFixed(1)}`);
    arc.setAttribute('stroke', _scoreColorsEnabled ? (_scoreColor(value) ?? fixedColor) : fixedColor);
    pctEl.textContent = `${value}%`; pctEl.className = 'ring-pct';
    if (countEl) countEl.textContent = total > 0 ? `${known} / ${total}` : '';
  }

  if (pct == null) {
    _ring('unique-arc', 'unique-pct', 'unique-ct', null, 0, 0, '#72CE9D');
    _ring('freq-arc',   'freq-pct',   'freq-ct',   null, 0, 0, '#66AAE8');
    _ring('kanji-arc',  'kanji-pct',  'kanji-ct',  null, 0, 0, '#FDC281');
    if (stat) { stat.textContent = 'Click to score'; stat.style.color = ''; }
    return;
  }

  const uPct = uniqueTotal > 0 ? Math.round(100 * uniqueKnown / uniqueTotal) : null;
  const kPct = kanjiTotal  > 0 ? Math.round(100 * kanjiKnown  / kanjiTotal)  : null;

  _ring('unique-arc', 'unique-pct', 'unique-ct', uPct, uniqueKnown, uniqueTotal, '#72CE9D');
  _ring('freq-arc',   'freq-pct',   'freq-ct',   pct,  freqKnown,   freqTotal,   '#66AAE8');
  _ring('kanji-arc',  'kanji-pct',  'kanji-ct',  kPct, kanjiKnown,  kanjiTotal,  '#FDC281');

  if (stat) stat.textContent = '';
}

function setStats(vocab, kanji) {
  document.getElementById('vocab-count').textContent = vocab.toLocaleString();
  document.getElementById('kanji-count').textContent = kanji.toLocaleString();
}

function _mergedCounts(mmVocab, mmKanji, extraVocab, extraKanji) {
  const vSet = new Set((extraVocab || []).map(x => typeof x === 'string' ? x : x.item));
  for (const v of (mmVocab || [])) vSet.add(typeof v === 'string' ? v : v.item);
  const kSet = new Set((extraKanji || []).map(x => typeof x === 'string' ? x : x.item));
  for (const k of (mmKanji || [])) kSet.add(typeof k === 'string' ? k : k.item);
  return { vocab: vSet.size, kanji: kSet.size };
}

function setTokStatus(text, color) {
  const el = document.getElementById('tok-status');
  if (el) { el.textContent = `Tokenizer: ${text}`; el.style.color = color || '#444'; }
}

async function injectBase(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['dict_xhr_patch.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/kuromoji.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['common.js'] });
}

async function preloadInTab(tabId) {
  // Try messaging existing content script first
  try {
    const r = await chrome.tabs.sendMessage(tabId, { action: 'preload' });
    if (r?.ok) return;
  } catch {}
  // Inject and preload directly
  await injectBase(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => { if (typeof getTokenizer === 'function') getTokenizer(); },
  });
}

function setExtraStatus(extraVocab, extraKanji) {
  const el = document.getElementById('extra-status');
  if (!extraVocab?.length && !extraKanji?.length) {
    el.textContent = '';
  } else {
    el.textContent = `+${(extraVocab||[]).length} vocab · +${(extraKanji||[]).length} kanji loaded`;
    el.style.color = '#81c784';
  }
}

// ── Focus timer (stopwatch) ─────────────────────────────────────────────────

let _swTickTimer = null;

function swFmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const SW_DEFAULT = {
  durationSec: 1200, remainingSec: 1200, running: false, paused: false, endsAt: null,
  autoAddImmersion: true, notifySound: true, notifyEffect: false,
};

async function swGetState() {
  const { mc_stopwatch } = await chrome.storage.local.get('mc_stopwatch');
  return { ...SW_DEFAULT, ...(mc_stopwatch || {}) };
}

function swRenderState(rawState) {
  const state = { ...SW_DEFAULT, ...(rawState || {}) };
  const badge = document.getElementById('sw-status-badge');
  const timeEl = document.getElementById('sw-time');
  const fill = document.getElementById('sw-bar-fill');
  const startBtn = document.getElementById('sw-start-btn');
  const durInput = document.getElementById('sw-duration-input');
  if (!badge) return;

  let remaining;
  if (state.running && state.endsAt) remaining = Math.max(0, (state.endsAt - Date.now()) / 1000);
  else if (state.paused) remaining = state.remainingSec;
  else remaining = state.durationSec;

  timeEl.textContent = swFmtTime(remaining);
  const pct = state.durationSec > 0 ? Math.max(0, Math.min(100, 100 - (remaining / state.durationSec) * 100)) : 0;
  fill.style.width = `${pct}%`;

  const card = document.querySelector('.sw-card');
  badge.classList.remove('running', 'paused');
  card?.classList.remove('running', 'paused');
  if (state.running) { badge.textContent = 'Running'; badge.classList.add('running'); card?.classList.add('running'); }
  else if (state.paused) { badge.textContent = 'Paused'; badge.classList.add('paused'); card?.classList.add('paused'); }
  else { badge.textContent = 'Ready'; }

  startBtn.innerHTML = state.running ? '&#10074;&#10074; Pause' : (state.paused ? '&#9654; Resume' : '&#9654; Start');
  durInput.disabled = state.running || state.paused;
  // Don't clobber an in-progress edit — only sync the field from stored state
  // when the user isn't actively typing in it.
  if (!state.running && !state.paused && document.activeElement !== durInput) {
    durInput.value = Math.max(1, Math.round(state.durationSec / 60));
  }

  document.getElementById('sw-autoadd-toggle').checked = state.autoAddImmersion !== false;
  document.getElementById('sw-sound-toggle').checked = state.notifySound !== false;
  document.getElementById('sw-effect-toggle').checked = !!state.notifyEffect;
}

async function swTick() { swRenderState(await swGetState()); }

async function initStopwatch() {
  swRenderState(await swGetState());
  if (!_swTickTimer) _swTickTimer = setInterval(swTick, 1000);

  document.getElementById('sw-start-btn').addEventListener('click', async () => {
    const cur = await swGetState();
    if (cur.running) {
      const remainingSec = Math.max(0, (cur.endsAt - Date.now()) / 1000);
      await chrome.storage.local.set({ mc_stopwatch: { ...cur, running: false, paused: true, remainingSec, endsAt: null } });
    } else {
      const durationSec = cur.paused ? cur.durationSec : Math.max(60, Math.round((parseFloat(document.getElementById('sw-duration-input').value) || 20) * 60));
      const remainingSec = cur.paused ? cur.remainingSec : durationSec;
      await chrome.storage.local.set({ mc_stopwatch: {
        ...cur, durationSec, running: true, paused: false, endsAt: Date.now() + remainingSec * 1000,
        autoAddImmersion: document.getElementById('sw-autoadd-toggle').checked,
        notifySound: document.getElementById('sw-sound-toggle').checked,
        notifyEffect: document.getElementById('sw-effect-toggle').checked,
      } });
    }
    swTick();
  });

  document.getElementById('sw-reset-btn').addEventListener('click', async () => {
    const cur = await swGetState();
    const durationSec = Math.max(60, Math.round((parseFloat(document.getElementById('sw-duration-input').value) || 20) * 60));
    await chrome.storage.local.set({ mc_stopwatch: { ...cur, durationSec, running: false, paused: false, remainingSec: durationSec, endsAt: null } });
    swTick();
  });

  for (const id of ['sw-autoadd-toggle', 'sw-sound-toggle', 'sw-effect-toggle']) {
    document.getElementById(id).addEventListener('change', async () => {
      const cur = await swGetState();
      await chrome.storage.local.set({ mc_stopwatch: {
        ...cur,
        autoAddImmersion: document.getElementById('sw-autoadd-toggle').checked,
        notifySound: document.getElementById('sw-sound-toggle').checked,
        notifyEffect: document.getElementById('sw-effect-toggle').checked,
      } });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.mc_stopwatch) swRenderState(changes.mc_stopwatch.newValue);
  });
}

// ── Timer tab ────────────────────────────────────────────────────────────────
// Full immersion stats (ring, chart, streak grid, log, reset-hour setting)
// live on the dedicated timer_stats.html page — this tab just shows an
// at-a-glance summary plus quick-add, so the popup doesn't turn into a
// long scrolling list.

const TIMER_DEFAULT_RESET_HOUR = 4;

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

async function renderTimerSummary() {
  const [resetHour, { mc_timer_days = {} }] = await Promise.all([
    timerGetResetHour(),
    chrome.storage.local.get('mc_timer_days'),
  ]);
  const todayKey = timerLogicalDay(Date.now(), resetHour);
  const todaySec = mc_timer_days[todayKey] || 0;

  const valEl = document.getElementById('timer-today-val');
  if (valEl) valEl.textContent = timerFormatDuration(todaySec);

  const { current } = timerComputeStreaks(mc_timer_days, todayKey);
  const csEl = document.getElementById('timer-cur-streak');
  if (csEl) csEl.textContent = `${current}d`;
}

async function timerAddEntry(source, minutes) {
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

function timerFmtHour(h) {
  const period = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return `${h12}:00 ${period}`;
}

// Lives on the Settings tab — controls when the Timer tab's daily immersion
// totals/streaks roll over to the next day.
async function initTimerResetHourSelect() {
  const sel = document.getElementById('timer-reset-hour');
  if (!sel) return;
  const resetHour = await timerGetResetHour();
  sel.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('option');
    opt.value = h; opt.textContent = timerFmtHour(h);
    if (h === resetHour) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', async e => {
    await chrome.storage.local.set({ mc_timer_settings: { resetHour: parseInt(e.target.value, 10) } });
  });
}

// Lives on the Settings tab — master switch for the automatic per-video
// immersion tracking (manual "Add time" and the focus timer are unaffected).
async function initTimerTrackingToggle() {
  const toggle = document.getElementById('timer-tracking-toggle');
  if (!toggle) return;
  const { mc_timer_tracking_enabled } = await chrome.storage.local.get('mc_timer_tracking_enabled');
  toggle.checked = mc_timer_tracking_enabled !== false;
  toggle.addEventListener('change', () => {
    chrome.storage.local.set({ mc_timer_tracking_enabled: toggle.checked });
  });
  // Stay in sync when toggled elsewhere (Timer tab switch, on-video dot)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.mc_timer_tracking_enabled) {
      toggle.checked = changes.mc_timer_tracking_enabled.newValue !== false;
    }
  });
}

// Settings tab — corner for the on-video control bars (YT/CIJ/NJK/local player)
async function initBarPositionSelect() {
  const sel = document.getElementById('bar-position-select');
  if (!sel) return;
  const { mc_bar_position } = await chrome.storage.local.get('mc_bar_position');
  sel.value = ['tl', 'tr', 'bl', 'br'].includes(mc_bar_position) ? mc_bar_position : 'tl';
  sel.addEventListener('change', () => {
    chrome.storage.local.set({ mc_bar_position: sel.value });
  });
}

const TIMER_HEARTBEAT_STALE_MS = 5000;
async function timerRefreshTrackDot() {
  const dot = document.getElementById('timer-track-dot');
  if (!dot) return;
  const { mc_timer_last_active = 0 } = await chrome.storage.local.get('mc_timer_last_active');
  dot.classList.toggle('on', Date.now() - mc_timer_last_active < TIMER_HEARTBEAT_STALE_MS);
}

const DETECTED_SOURCE_LABELS = {
  'cijapanese.com':                    'CIJ',
  'www.cijapanese.com':                'CIJ',
  'nihongo-jikan.com':                 'Nihongo-Jikan',
  'www.nihongo-jikan.com':             'Nihongo-Jikan',
  'www.youtube.com':                   'YouTube',
  'mdnas.local':                       'Local NAS (CIJ)',
  'cij.punchyface.synology.me':        'Local NAS (CIJ)',
};

async function initTimerTab() {
  await renderTimerSummary();
  timerRefreshTrackDot();
  setInterval(timerRefreshTrackDot, 2000);

  // Auto-detect toggle — mirrors mc_timer_tracking_enabled from Settings
  const autoToggle = document.getElementById('timer-autotrack-toggle');
  const detectBtn = document.getElementById('timer-detect-btn');
  const detectStatus = document.getElementById('timer-detect-status');

  function _applyAutoTrackState(enabled) {
    autoToggle.checked = enabled;
    detectBtn.style.display = enabled ? 'none' : '';
    if (enabled) detectStatus.textContent = '';
  }

  const { mc_timer_tracking_enabled } = await chrome.storage.local.get('mc_timer_tracking_enabled');
  _applyAutoTrackState(mc_timer_tracking_enabled !== false);

  autoToggle.addEventListener('change', () => {
    chrome.storage.local.set({ mc_timer_tracking_enabled: autoToggle.checked });
    _applyAutoTrackState(autoToggle.checked);
  });

  // "Detect current tab" — identifies source from the active tab's URL,
  // pre-fills the source field so the user just needs to enter minutes.
  detectBtn.addEventListener('click', async () => {
    detectStatus.textContent = '';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) { detectStatus.textContent = 'No active tab found.'; return; }
      let hostname = '';
      try { hostname = new URL(tab.url).hostname; } catch {}
      const label = DETECTED_SOURCE_LABELS[hostname];
      if (!label) {
        detectStatus.textContent = 'This page is not a recognised immersion source.';
        detectStatus.style.color = 'var(--dim)';
        return;
      }
      const srcInput = document.getElementById('timer-source-input');
      const minInput = document.getElementById('timer-minutes-input');
      srcInput.value = label;
      minInput.value = '';
      minInput.focus();
      detectStatus.textContent = `Detected: ${label} — enter minutes and click Add time.`;
      detectStatus.style.color = '#72CE9D';
    } catch (e) {
      detectStatus.textContent = `Error: ${e.message}`;
      detectStatus.style.color = '#f44336';
    }
  });

  const srcInput = document.getElementById('timer-source-input');
  const minInput = document.getElementById('timer-minutes-input');
  document.getElementById('timer-add-btn').addEventListener('click', async () => {
    const minutes = parseFloat(minInput.value);
    if (!minutes || minutes <= 0) return;
    const source = srcInput.value.trim() || 'Manual';
    await timerAddEntry(source, minutes);
    srcInput.value = ''; minInput.value = '';
    detectStatus.textContent = '';
  });

  document.getElementById('timer-stats-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('timer_stats.html') });
    window.close();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.mc_timer_days || changes.mc_timer_settings) renderTimerSummary();
    if (changes.mc_timer_last_active) timerRefreshTrackDot();
    if (changes.mc_timer_tracking_enabled) {
      _applyAutoTrackState(changes.mc_timer_tracking_enabled.newValue !== false);
    }
  });
}

async function init() {
  const { mm_token, mm_vocab, mm_kanji, mm_extra_vocab, mm_extra_kanji } =
    await chrome.storage.local.get(['mm_token', 'mm_vocab', 'mm_kanji', 'mm_extra_vocab', 'mm_extra_kanji']);

  if (mm_token) {
    document.getElementById('token').value = mm_token;
    const { vocab: vc, kanji: kc } = _mergedCounts(mm_vocab, mm_kanji, mm_extra_vocab, mm_extra_kanji);
    setStats(vc, kc);
    const apprInit = (mm_vocab || []).filter(v => typeof v === 'object' && v.status === 0).length
                   + (mm_kanji || []).filter(k => typeof k === 'object' && k.status === 0).length;
    setStatus(`✓ Connected — ${mm_vocab?.length || 0} vocab, ${mm_kanji?.length || 0} kanji` + (apprInit > 0 ? ` · ${apprInit} in pipeline` : ''), '#72CE9D');
  }
  setExtraStatus(mm_extra_vocab, mm_extra_kanji);

  document.getElementById('connect-btn').addEventListener('click', async () => {
    const token = document.getElementById('token').value.trim();
    if (!token) return;
    const btn = document.getElementById('connect-btn');
    btn.disabled = true;
    setStatus('Fetching vocab… (takes ~3 seconds)', '#888');
    try {
      const { kanji, vocab } = await fetchAllVocab(token);
      await chrome.storage.local.set({ mm_token: token, mm_vocab: vocab, mm_kanji: kanji });
      const { mm_extra_vocab: ev = [], mm_extra_kanji: ek = [] } = await chrome.storage.local.get(['mm_extra_vocab', 'mm_extra_kanji']);
      const { vocab: vc, kanji: kc } = _mergedCounts(vocab, kanji, ev, ek);
      setStats(vc, kc);
      const appr = vocab.filter(v => typeof v === 'object' && v.status === 0).length
                + kanji.filter(k => typeof k === 'object' && k.status === 0).length;
      setStatus(`✓ Connected — ${vocab.length} vocab, ${kanji.length} kanji` + (appr > 0 ? ` · ${appr} in pipeline` : ''), '#72CE9D');
    } catch (e) {
      const msg = e.message === 'HTTP 401' || e.message === 'HTTP 403'
        ? 'Invalid token — check your MaruMori API token'
        : e.message === 'HTTP 429'
          ? 'Rate limited — wait 30s and try again'
          : `Error: ${e.message}`;
      setStatus(msg, '#f44336');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('refresh-btn').addEventListener('click', async () => {
    const { mm_token } = await chrome.storage.local.get('mm_token');
    if (!mm_token) { setStatus('Connect first', '#f44336'); return; }
    setStatus('Refreshing…', '#888');
    try {
      const { kanji, vocab } = await fetchAllVocab(mm_token);
      await chrome.storage.local.set({ mm_vocab: vocab, mm_kanji: kanji });
      const { mm_extra_vocab: ev = [], mm_extra_kanji: ek = [] } = await chrome.storage.local.get(['mm_extra_vocab', 'mm_extra_kanji']);
      const { vocab: vc, kanji: kc } = _mergedCounts(vocab, kanji, ev, ek);
      setStats(vc, kc);
      const appr = vocab.filter(v => typeof v === 'object' && v.status === 0).length
                  + kanji.filter(k => typeof k === 'object' && k.status === 0).length;
      setStatus(`✓ Refreshed — ${vocab.length} vocab, ${kanji.length} kanji` + (appr > 0 ? ` · ${appr} in pipeline` : ''), '#72CE9D');
    } catch (e) {
      setStatus(`Error: ${e.message}`, '#f44336');
    }
  });

  document.getElementById('disconnect-btn').addEventListener('click', async () => {
    await chrome.storage.local.remove(['mm_token', 'mm_vocab', 'mm_kanji']);
    document.getElementById('token').value = '';
    setStats(0, 0);
    setScore(null);
    setStatus('Disconnected — vocab and kanji cleared', '#888');
  });

  // Check tokenizer status and auto-score on open
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { action: 'tokStatus' })
      .then(r => {
        if (r?.ready) { setTokStatus('✓ Ready', '#72CE9D'); return; }
        if (r?.loading) {
          setTokStatus('loading…', '#888');
          // Poll until the in-progress load finishes
          const poll = setInterval(() => {
            chrome.tabs.sendMessage(tab.id, { action: 'tokStatus' })
              .then(s => {
                if (s?.ready) { setTokStatus('✓ Ready', '#72CE9D'); clearInterval(poll); }
                else if (!s?.loading) { setTokStatus('not loaded — click to load', '#666'); clearInterval(poll); }
              })
              .catch(() => clearInterval(poll));
          }, 800);
        } else {
          setTokStatus('not loaded — click to load', '#666');
        }
      })
      .catch(() => setTokStatus('not loaded — click to load', '#666'));

    doScore(tab, { silent: true });
  }

  async function _doPreload() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    setTokStatus('loading…', '#888');
    try {
      await preloadInTab(tab.id);
      let ready = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const r = await chrome.tabs.sendMessage(tab.id, { action: 'tokStatus' });
          if (r?.ready) { setTokStatus('✓ Ready', '#72CE9D'); ready = true; break; }
        } catch {}
      }
      if (!ready) setTokStatus('timeout — reload extension + tab, then retry', '#f44336');
    } catch (e) {
      setTokStatus(`error: ${e.message}`, '#f44336');
    }
  }

  document.getElementById('tok-status').addEventListener('click', () => {
    const el = document.getElementById('tok-status');
    if (el.textContent.includes('✓')) return;
    _doPreload();
  });

  const SUPPORTED_HOSTS = ['cijapanese.com', 'nihongo-jikan.com', 'www.nihongo-jikan.com', 'www.youtube.com', 'mdnas.local', 'cij.punchyface.synology.me'];

  async function doScore(tab, { silent = false } = {}) {
    const card = document.getElementById('score-block');
    const statusEl = document.getElementById('status');
    if (card) card.classList.add('scoring');

    // Try messaging an already-running content script (YT / NJK / CIJ)
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { action: 'rescore' });
      if (resp?.score != null) {
        setScore(resp.score, resp.freqKnown, resp.freqTotal, resp.uniqueKnown, resp.uniqueTotal, resp.kanjiKnown, resp.kanjiTotal);
      } else if (!silent) {
        if (resp?.error) {
          if (statusEl) { statusEl.textContent = resp.error; statusEl.style.color = '#f87171'; }
        } else {
          if (statusEl) { statusEl.textContent = 'No Japanese subtitles found'; }
        }
      }
      if (card) card.classList.remove('scoring');
      return;
    } catch {}

    // Fallback injection — only on known sites to avoid holding other pages hostage
    let tabHost = '';
    try { tabHost = new URL(tab.url || '').hostname; } catch {}
    if (!SUPPORTED_HOSTS.includes(tabHost)) {
      if (!silent && statusEl) { statusEl.textContent = 'Not supported on this page'; statusEl.style.color = '#9aa0b4'; }
      if (card) card.classList.remove('scoring');
      return;
    }

    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['dict_xhr_patch.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/kuromoji.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['common.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['hover.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['sidebar.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_cij.js'] });
      if (!silent && statusEl) { statusEl.textContent = 'Done — check page for badge'; statusEl.style.color = '#4ade80'; }
    } catch (e) {
      if (!silent && statusEl) { statusEl.textContent = `Could not inject: ${e.message}`; statusEl.style.color = '#f87171'; }
    }
    if (card) card.classList.remove('scoring');
  }

  document.getElementById('score-block').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await doScore(tab);
  });

  document.getElementById('extra-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const el = document.getElementById('extra-status');
    try {
      const data = JSON.parse(await file.text());
      const rawKanji = Array.isArray(data.kanji) ? data.kanji : [];
      const rawVocab = Array.isArray(data.vocab) ? data.vocab : [];
      const validKanji = rawKanji.filter(k => typeof k === 'string' && /^[一-鿿]$/.test(k));
      const validVocab = rawVocab.filter(v => typeof v === 'string' && v.trim());

      // Merge with any existing extras
      const { mm_extra_vocab: ev = [], mm_extra_kanji: ek = [] } =
        await chrome.storage.local.get(['mm_extra_vocab', 'mm_extra_kanji']);
      const mergedVocab = [...new Set([...ev, ...validVocab.map(v => v.trim())])];
      const mergedKanji = [...new Set([...ek, ...validKanji])];

      await chrome.storage.local.set({ mm_extra_vocab: mergedVocab, mm_extra_kanji: mergedKanji });
      setExtraStatus(mergedVocab, mergedKanji);
    } catch (err) {
      el.textContent = `Error: ${err.message}`;
      el.style.color = '#f44336';
    }
    e.target.value = '';
  });

  // Hover toggle
  const hoverToggle = document.getElementById('hover-toggle');
  chrome.storage.local.get('mc_hover_enabled', ({ mc_hover_enabled }) => {
    hoverToggle.checked = !!mc_hover_enabled;
  });
  hoverToggle.addEventListener('change', async () => {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) { hoverToggle.checked = !hoverToggle.checked; return; }
    if (!hoverToggle.checked) {
      await chrome.tabs.sendMessage(activeTab.id, { action: 'disableHover' }).catch(() => {});
      chrome.storage.local.set({ mc_hover_enabled: false });
    } else {
      hoverToggle.disabled = true;
      try {
        const r = await chrome.tabs.sendMessage(activeTab.id, { action: 'enableHover' });
        if (!r?.ok) {
          setStatus(r?.error || 'Hover failed', '#f44336');
          hoverToggle.checked = false;
          chrome.storage.local.set({ mc_hover_enabled: false });
        } else {
          chrome.storage.local.set({ mc_hover_enabled: true });
        }
      } catch (e) {
        setStatus(`Hover error: ${e.message}`, '#f44336');
        hoverToggle.checked = false;
        chrome.storage.local.set({ mc_hover_enabled: false });
      }
      hoverToggle.disabled = false;
    }
  });

  // Video subtitle tool toggle
  const videoSubToggle = document.getElementById('video-sub-toggle');
  chrome.storage.local.get('videoToolEnabled', ({ videoToolEnabled }) => {
    videoSubToggle.checked = videoToolEnabled !== false;
  });
  videoSubToggle.addEventListener('change', async () => {
    chrome.storage.local.set({ videoToolEnabled: videoSubToggle.checked });
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) return;
    if (!videoSubToggle.checked) {
      await chrome.tabs.sendMessage(activeTab.id, { action: 'disableVideoTool' }).catch(() => {});
    } else {
      videoSubToggle.disabled = true;
      try {
        await chrome.tabs.sendMessage(activeTab.id, { action: 'enableVideoTool' });
      } catch (e) {
        setStatus(`Video tool error: ${e.message}`, '#f44336');
        videoSubToggle.checked = false;
        chrome.storage.local.set({ videoToolEnabled: false });
      }
      videoSubToggle.disabled = false;
    }
  });

  // Sidebar
  const sidebarBtn = document.getElementById('sidebar-btn');
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { action: 'sidebarStatus' })
      .then(r => { if (r?.open) sidebarBtn.textContent = '- Close word sidebar'; })
      .catch(() => {});
  }
  sidebarBtn.addEventListener('click', async () => {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) return;
    sidebarBtn.disabled = true;
    sidebarBtn.textContent = 'Loading…';
    try {
      const r = await chrome.tabs.sendMessage(activeTab.id, { action: 'openSidebar' });
      if (r?.closed) {
        sidebarBtn.textContent = '≡ Load word sidebar';
        sidebarBtn.disabled = false;
      } else if (r?.ok) {
        // Close popup so the sidebar is visible immediately
        window.close();
        return;
      } else {
        setStatus(r?.error || 'Sidebar failed', '#f44336');
        sidebarBtn.textContent = '≡ Load word sidebar';
        sidebarBtn.disabled = false;
      }
    } catch (e) {
      setStatus(`Sidebar error: ${e.message}`, '#f44336');
      sidebarBtn.textContent = '≡ Load word sidebar';
      sidebarBtn.disabled = false;
    }
  });

  document.getElementById('clear-extra-btn').addEventListener('click', async () => {
    await chrome.storage.local.remove(['mm_extra_vocab', 'mm_extra_kanji']);
    setExtraStatus([], []);
  });

  // ── Backup & restore (everything in chrome.storage.local) ─────────────────
  const backupStatusEl = document.getElementById('backup-status');
  function setBackupStatus(text, color) {
    if (!backupStatusEl) return;
    backupStatusEl.textContent = text;
    backupStatusEl.style.color = color || 'var(--dim)';
  }

  document.getElementById('export-all-btn').addEventListener('click', async () => {
    try {
      const data = await chrome.storage.local.get(null);
      const payload = {
        app: 'MaruComprehension',
        exportVersion: 1,
        extensionVersion: chrome.runtime.getManifest().version,
        exportedAt: new Date().toISOString(),
        data,
      };
      const date = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      a.download = `marucomprehension-backup-${date}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setBackupStatus('✓ Exported', '#72CE9D');
    } catch (e) {
      setBackupStatus(`Export failed: ${e.message}`, '#f44336');
    }
  });

  document.getElementById('import-all-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      // Accept our own wrapped format, or a raw storage dump as a fallback.
      const data = (parsed && typeof parsed.data === 'object' && parsed.data) ? parsed.data : parsed;
      const keys = Object.keys(data || {});
      if (!keys.length) throw new Error('No data found in file');

      if (!confirm(`Import ${keys.length} setting${keys.length !== 1 ? 's' : ''}/data key(s) from this backup? This replaces ALL current MaruComprehension data on this device (API key, vocab, known words, history, immersion tracking, settings) and can't be undone.`)) {
        e.target.value = '';
        return;
      }

      setBackupStatus('Importing…', '#888');
      await chrome.storage.local.clear();
      await chrome.storage.local.set(data);
      setBackupStatus('✓ Imported — reloading…', '#72CE9D');
      setTimeout(() => window.location.reload(), 700);
    } catch (err) {
      setBackupStatus(`Import failed: ${err.message}`, '#f44336');
    }
    e.target.value = '';
  });

  document.getElementById('local-player-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('player.html') });
    window.close();
  });

  // History toggle + page + clear
  const histToggle = document.getElementById('history-toggle');
  chrome.storage.local.get('mc_history_enabled', ({ mc_history_enabled }) => {
    histToggle.checked = mc_history_enabled !== false;
  });
  histToggle.addEventListener('change', () => {
    chrome.storage.local.set({ mc_history_enabled: histToggle.checked });
  });
  document.getElementById('history-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('video_history.html') });
    window.close();
  });
  document.getElementById('clear-history-btn').addEventListener('click', async () => {
    const { mc_video_history = {}, mc_word_history = {} } =
      await chrome.storage.local.get(['mc_video_history', 'mc_word_history']);
    const vn = Object.keys(mc_video_history).length;
    const wn = Object.keys(mc_word_history).length;
    if (!vn && !wn) { alert('History is already empty.'); return; }
    if (!confirm(`Clear ${vn} video${vn !== 1 ? 's' : ''} and ${wn} word${wn !== 1 ? 's' : ''} from history?`)) return;
    await chrome.storage.local.set({ mc_video_history: {}, mc_word_history: {} });
    histListEl.innerHTML = '<div id="hist-empty">No history yet</div>';
  });

  document.getElementById('kanji-stat-card').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('kanji.html') });
    window.close();
  });
  document.getElementById('vocab-stat-card').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('vocab.html') });
    window.close();
  });
  document.getElementById('changelog-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('changelog.html') });
    window.close();
  });

  // ── Watched badges toggle ─────────────────────────────────────────────────
  const badgesToggle = document.getElementById('badges-toggle');
  chrome.storage.local.get('mc_badges_enabled', ({ mc_badges_enabled }) => {
    badgesToggle.checked = mc_badges_enabled !== false;
  });
  badgesToggle.addEventListener('change', () => {
    chrome.storage.local.set({ mc_badges_enabled: badgesToggle.checked });
  });

  // ── Recent watch history (main tab) ──────────────────────────────────────
  function _compColorPop(score) {
    const stops = [[237,121,137],[253,194,129],[114,206,157]];
    const t = Math.max(0, Math.min(100, score)) / 100;
    const seg = t < 0.5 ? 0 : 1;
    const lt  = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    const [r1,g1,b1] = stops[seg], [r2,g2,b2] = stops[seg+1];
    return `rgb(${Math.round(r1+(r2-r1)*lt)},${Math.round(g1+(g2-g1)*lt)},${Math.round(b1+(b2-b1)*lt)})`;
  }

  const histListEl = document.getElementById('hist-list');
  chrome.storage.local.get(['mc_history_enabled', 'mc_video_history'], ({ mc_history_enabled = true, mc_video_history = {} }) => {
    const entries = Object.entries(mc_video_history)
      .sort((a, b) => (b[1].lastWatched || 0) - (a[1].lastWatched || 0))
      .slice(0, 8);

    if (!mc_history_enabled || !entries.length) {
      histListEl.innerHTML = '<div id="hist-empty">No history yet</div>';
      return;
    }

    histListEl.innerHTML = entries.map(([, v]) => {
      const score = v.lastScore?.score;
      const scoreHtml = score != null
        ? `<span class="hist-score" style="color:${_compColorPop(score)}">${score}%</span>` : '';
      const siteClass = `hs-${v.site || 'yt'}`;
      const siteLabel = v.site === 'cij' ? 'CIJ' : v.site === 'njk' ? 'NJK' : v.site === 'player' ? 'Local' : 'YT';
      const url = v.url || '';
      return `<div class="hist-row" data-url="${url.replace(/"/g,'&quot;')}">
        <span class="hist-site ${siteClass}">${siteLabel}</span>
        <span class="hist-title">${(v.title || '').replace(/</g,'&lt;')}</span>
        ${scoreHtml}
      </div>`;
    }).join('');

    histListEl.querySelectorAll('.hist-row').forEach(row => {
      row.addEventListener('click', () => {
        const url = row.dataset.url;
        if (url && !url.startsWith('blob:')) { chrome.tabs.create({ url }); window.close(); }
      });
    });
  });

  document.getElementById('hist-view-all-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('video_history.html') });
    window.close();
  });

  // Known words count + management page
  const knownCountEl = document.getElementById('known-words-count');
  const _refreshKnownCount = () => {
    chrome.storage.local.get('mc_user_known', ({ mc_user_known = [] }) => {
      knownCountEl.textContent = mc_user_known.length ? `${mc_user_known.length}` : '';
    });
  };
  _refreshKnownCount();
  document.getElementById('known-words-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('known_words.html') });
    window.close();
  });

  const v = chrome.runtime.getManifest().version;
  const vEl = document.getElementById('version-label');
  if (vEl) vEl.textContent = `v${v}`;

  initTimerTab();
  initStopwatch();
  initBarPositionSelect();
}

document.addEventListener('DOMContentLoaded', () => {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // Light/dark theme
  chrome.storage.local.get(['light_theme', 'score_colors'], ({ light_theme, score_colors }) => {
    if (light_theme) _applyTheme(true);
    if (score_colors) {
      _scoreColorsEnabled = true;
      document.getElementById('score-colors-toggle').checked = true;
    }
  });
  document.getElementById('theme-toggle').addEventListener('change', e => {
    _applyTheme(e.target.checked);
    chrome.storage.local.set({ light_theme: e.target.checked });
  });
  document.getElementById('score-colors-toggle').addEventListener('change', e => {
    _scoreColorsEnabled = e.target.checked;
    chrome.storage.local.set({ score_colors: e.target.checked });
    if (_lastScoreArgs) setScore(..._lastScoreArgs);
  });

  const apprenticeToggle = document.getElementById('apprentice-toggle');
  chrome.storage.local.get('mc_show_apprentice', ({ mc_show_apprentice }) => {
    apprenticeToggle.checked = !!mc_show_apprentice;
  });
  apprenticeToggle.addEventListener('change', () => {
    chrome.storage.local.set({ mc_show_apprentice: apprenticeToggle.checked });
  });

  init();
});

function _applyTheme(light) {
  document.body.classList.toggle('light-theme', light);
  document.getElementById('theme-toggle').checked = light;
  const trackColor = light ? '#c8dff6' : '#363A3B';
  for (const id of ['unique-ring-bg', 'freq-ring-bg', 'kanji-ring-bg']) {
    const el = document.getElementById(id);
    if (el) el.setAttribute('stroke', trackColor);
  }
}
