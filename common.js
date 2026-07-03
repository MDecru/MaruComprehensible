// Shared scoring logic — loaded before each site-specific content script

var KUROMOJI_DICT_URL = chrome.runtime.getURL('dict');
var DICT_FILES = [
  'base.dat.gz', 'check.dat.gz', 'cc.dat.gz',
  'tid.dat.gz', 'tid_map.dat.gz', 'tid_pos.dat.gz',
  'unk.dat.gz', 'unk_char.dat.gz', 'unk_compat.dat.gz', 'unk_invoke.dat.gz', 'unk_map.dat.gz', 'unk_pos.dat.gz',
];
var MM_CONTENT_POS = new Set(['名詞','動詞','形容詞','形容動詞','副詞','連体詞','感動詞']);
var NUMERAL_RE = /^[0-9０-９]+$/;

var _tokenizer = null;
var _tokenizerPromise = null;

function getTokenizer() {
  if (_tokenizer) return Promise.resolve(_tokenizer);
  if (_tokenizerPromise) return _tokenizerPromise;
  _tokenizerPromise = (async () => {
    // Pre-fetch all dict files with fetch() then serve from cache via XHR stub.
    window._kuromojiDictCache = {};
    for (const f of DICT_FILES) {
      try {
        const r = await fetch(`${KUROMOJI_DICT_URL}/${f}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        window._kuromojiDictCache[f] = await r.arrayBuffer();
      } catch (e) {
        _tokenizerPromise = null;
        throw e;
      }
    }

    return new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: KUROMOJI_DICT_URL }).build((err, t) => {
        if (err) { _tokenizerPromise = null; reject(err); }
        else     { _tokenizer = t; resolve(t); }
      });
    });
  })();
  return _tokenizerPromise;
}

function hasKanji(s) { return /[一-龯㐀-䶿]/.test(s); }

// Full token-merging pipeline:
//   1) compound noun merging (vocab-aware greedy)
//   2) honorific prefix (接頭詞 お/ご) prepended to next word
//   3) copula (です) left alone — never merged or scored
//   4) て/で particle after 動詞 → pendingTe; following 動詞 (helper verb) → merged in
//   5) 助動詞 (ます/た/ない/etc.) → merged into previous content token
function buildMergedTokens(rawTokens, vocabSet) {
  // Step 1: compound noun merging
  const step1 = [];
  let i = 0;
  while (i < rawTokens.length) {
    const tok = rawTokens[i];
    if (tok.pos === '名詞' && !NUMERAL_RE.test(tok.surface_form)) {
      let surface = tok.surface_form;
      let bestLen = 0;
      const maxJ = Math.min(rawTokens.length, i + 4);
      for (let j = i + 1; j < maxJ; j++) {
        if (rawTokens[j].pos !== '名詞' || NUMERAL_RE.test(rawTokens[j].surface_form)) break;
        surface += rawTokens[j].surface_form;
        if (vocabSet.has(surface)) bestLen = j - i + 1;
      }
      if (bestLen > 1) {
        let combined = '', combinedReading = '';
        for (let k = i; k < i + bestLen; k++) {
          combined += rawTokens[k].surface_form;
          combinedReading += rawTokens[k].reading || rawTokens[k].surface_form;
        }
        step1.push({ surface_form: combined, basic_form: combined, reading: combinedReading, pos: '名詞', pos_detail_1: tok.pos_detail_1 });
        i += bestLen;
        continue;
      }
    }
    step1.push(rawTokens[i]);
    i++;
  }

  // Step 2: prefix / te-form / auxiliary merging
  const out = [];
  let pendingPrefix = null;

  for (const tok of step1) {
    if (tok.pos === '接頭詞' && !pendingPrefix) {
      pendingPrefix = { surface_form: tok.surface_form, reading: tok.reading || tok.surface_form };
      continue;
    }

    let surface = tok.surface_form;
    let basic   = (tok.basic_form && tok.basic_form !== '*') ? tok.basic_form : surface;
    let reading = tok.reading || surface;

    if (pendingPrefix) {
      surface = pendingPrefix.surface_form + surface;
      basic   = pendingPrefix.surface_form + basic;
      reading = pendingPrefix.reading + reading;
      pendingPrefix = null;
    }

    const isCopula = basic === 'です';
    const prev = out.length ? out[out.length - 1] : null;

    // Hiragana-only 動詞 directly after 名詞 = verb inflection attachment
    // e.g. 壊(名詞) + れ(動詞) → 壊れ promoted to 動詞 so て-form merging can follow
    if (!isCopula && tok.pos === '動詞' && /^[ぁ-ん]+$/.test(surface) && prev?.pos === '名詞' && prev._merge) {
      prev.surface_form += surface;
      prev.basic_form    = (prev.basic_form || prev.surface_form) + basic;
      prev.reading       = (prev.reading    || '') + reading;
      prev.pos = '動詞';
      continue;
    }

    // て/で after 動詞 → merge and mark as pendingTe
    if (!isCopula && tok.pos === '助詞' && (surface === 'て' || surface === 'で') && prev?._merge && prev.pos === '動詞') {
      prev.surface_form += surface;
      prev._pendingTe = true;
      continue;
    }

    // Helper 動詞 continuing a te-form (ている/てある/てしまう/etc.)
    if (!isCopula && tok.pos === '動詞' && prev?._pendingTe) {
      prev.surface_form += surface;
      prev._pendingTe = false;
      continue;
    }

    // 助動詞 (ます、た、ない、etc.) → fold into previous content word
    if (!isCopula && tok.pos === '助動詞' && prev?._merge) {
      prev.surface_form += surface;
      continue;
    }

    out.push({
      surface_form: surface,
      basic_form:   basic,
      reading,
      pos:          tok.pos,
      pos_detail_1: tok.pos_detail_1 || '',
      _merge:       !isCopula,
      _pendingTe:   false,
    });
  }

  return out;
}

function parseVTT(text) {
  const lines = [];
  for (const block of text.split(/\n\n+/)) {
    const bl = block.trim().split('\n');
    const ti = bl.findIndex(l => l.includes('-->'));
    if (ti < 0) continue;
    const txt = bl.slice(ti + 1)
      .map(l => l
        .replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, '') // strip furigana readings BEFORE other tags
        .replace(/<rp[^>]*>[\s\S]*?<\/rp>/gi, '')
        .replace(/<[^>]+>/g, '')                  // strip remaining tags
        .trim()
      )
      .filter(Boolean).join(' ');
    if (txt) lines.push(txt);
  }
  return lines.join('\n');
}

function _chromeGet(keys) {
  return new Promise(resolve => {
    if (!chrome.runtime?.id) { resolve({}); return; }
    try {
      chrome.storage.local.get(keys, d => {
        if (chrome.runtime.lastError) { resolve({}); return; }
        resolve(d);
      });
    } catch { resolve({}); }
  });
}

function getVocab() {
  return _chromeGet(['mm_vocab', 'mm_extra_vocab', 'mm_extra_kanji', 'mc_user_known']).then(d => {
    const set = new Set(d.mm_vocab || []);
    for (const v of (d.mm_extra_vocab || [])) set.add(v);
    for (const k of (d.mm_extra_kanji || [])) set.add(k);
    for (const w of (d.mc_user_known  || [])) set.add(w);
    return set;
  });
}

function getKanji() {
  return _chromeGet(['mm_kanji', 'mm_extra_kanji']).then(d => {
    const set = new Set(d.mm_kanji || []);
    for (const k of (d.mm_extra_kanji || [])) set.add(k);
    return set;
  });
}

function _scoreKanji(tokens, kanjiSet) {
  const KANJI_RE = /[一-龯㐀-䶿]/g;
  const seen = new Set();
  let known = 0, total = 0;
  for (const tok of tokens) {
    if (!MM_CONTENT_POS.has(tok.pos)) continue;
    const w = tok.basic_form || tok.surface_form;
    for (const ch of (w.match(KANJI_RE) || [])) {
      if (seen.has(ch)) continue;
      seen.add(ch);
      total++;
      if (kanjiSet.has(ch)) known++;
    }
  }
  return { known, total };
}

function _scoreTokens(tokens, vocab) {
  let known = 0, total = 0;
  for (const tok of tokens) {
    if (!MM_CONTENT_POS.has(tok.pos)) continue;
    const w = tok.basic_form || tok.surface_form;
    if (!hasKanji(w) && [...w].length < 2) continue;
    total++;
    if (vocab.has(w) || vocab.has(tok.surface_form)) known++;
  }
  return { pct: total > 0 ? Math.round(100 * known / total) : null, known, total };
}

// Counts each unique content word once — returns { known, total } raw counts.
function _scoreTokensUnique(tokens, vocab) {
  const seen = new Set();
  let known = 0, total = 0;
  for (const tok of tokens) {
    if (!MM_CONTENT_POS.has(tok.pos)) continue;
    const w = tok.basic_form || tok.surface_form;
    if (!hasKanji(w) && [...w].length < 2) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    total++;
    if (vocab.has(w) || vocab.has(tok.surface_form)) known++;
  }
  return { known, total };
}

// Returns { score, freqKnown, freqTotal, uniqueKnown, uniqueTotal, kanjiKnown, kanjiTotal }
async function scoreText(rawText) {
  const [vocab, kanji] = await Promise.all([getVocab(), getKanji()]);
  if (!vocab.size || !rawText.trim()) return null;
  const tokenizer = await getTokenizer();
  const tokens = buildMergedTokens(tokenizer.tokenize(rawText), vocab);
  const { pct, known: fk, total: ft } = _scoreTokens(tokens, vocab);
  const { known: uk, total: ut } = _scoreTokensUnique(tokens, vocab);
  const { known: kk, total: kt } = _scoreKanji(tokens, kanji);
  return { score: pct, freqKnown: fk, freqTotal: ft, uniqueKnown: uk, uniqueTotal: ut, kanjiKnown: kk, kanjiTotal: kt };
}

// ── Watch / word history helpers ──────────────────────────────────────────────

async function saveVideoHistory(key, { title, url, site, score }) {
  try {
    if (!chrome.runtime?.id) return;
    const data = await chrome.storage.local.get(['mc_history_enabled', 'mc_video_history']);
    if (data.mc_history_enabled === false) return;
    const hist = data.mc_video_history || {};
    const prev = hist[key];
    hist[key] = { title: title || key, url, site, lastScore: score, lastWatched: Date.now(), watchCount: (prev?.watchCount || 0) + 1, firstWatched: prev?.firstWatched || Date.now() };
    await chrome.storage.local.set({ mc_video_history: hist });
  } catch {}
}

var _pendingWords = {};
var _wordFlushTimer = null;
async function trackUnknownWords(words) {
  try {
    if (!chrome.runtime?.id || !words?.length) return;
    for (const w of words) _pendingWords[w] = (_pendingWords[w] || 0) + 1;
    if (_wordFlushTimer) return;
    _wordFlushTimer = setTimeout(async () => {
      _wordFlushTimer = null;
      const batch = _pendingWords; _pendingWords = {};
      if (!Object.keys(batch).length) return;
      const data = await chrome.storage.local.get(['mc_history_enabled', 'mc_word_history']);
      if (data.mc_history_enabled === false) return;
      const hist = data.mc_word_history || {};
      const now = Date.now();
      for (const [w, cnt] of Object.entries(batch)) {
        if (!hist[w]) hist[w] = { count: 0, lastSeen: 0 };
        hist[w].count += cnt; hist[w].lastSeen = now;
      }
      await chrome.storage.local.set({ mc_word_history: hist });
    }, 5000);
  } catch {}
}

async function scoreVTT(vttText) {
  const [vocab, kanji] = await Promise.all([getVocab(), getKanji()]);
  if (!vocab.size) return null;
  const text = parseVTT(vttText);
  if (!text.trim()) return null;
  const tokenizer = await getTokenizer();
  const tokens = buildMergedTokens(tokenizer.tokenize(text), vocab);
  const { pct, known: fk, total: ft } = _scoreTokens(tokens, vocab);
  const { known: uk, total: ut } = _scoreTokensUnique(tokens, vocab);
  const { known: kk, total: kt } = _scoreKanji(tokens, kanji);
  return { score: pct, freqKnown: fk, freqTotal: ft, uniqueKnown: uk, uniqueTotal: ut, kanjiKnown: kk, kanjiTotal: kt };
}

function compColor(pct) {
  if (pct == null || !isFinite(pct)) return 'rgb(114,206,157)';
  const stops = [[237,121,137],[253,194,129],[114,206,157]];
  const t = Math.max(0, Math.min(100, pct)) / 100;
  const seg = t < 0.5 ? 0 : 1;
  const lt = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const [r1,g1,b1] = stops[seg], [r2,g2,b2] = stops[seg+1];
  return `rgb(${Math.round(r1+(r2-r1)*lt)},${Math.round(g1+(g2-g1)*lt)},${Math.round(b1+(b2-b1)*lt)})`;
}

// ── Immersion timer (auto video-time tracking) ────────────────────────────

var TIMER_DEFAULT_RESET_HOUR = 4;

function timerLogicalDay(ts, resetHour) {
  const d = new Date(ts - resetHour * 3600000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

var _timerResetHour = TIMER_DEFAULT_RESET_HOUR;
var _timerTrackingEnabled = true;
_chromeGet(['mc_timer_settings', 'mc_timer_tracking_enabled']).then(d => {
  if (d.mc_timer_settings?.resetHour != null) _timerResetHour = d.mc_timer_settings.resetHour;
  if (d.mc_timer_tracking_enabled === false) _timerTrackingEnabled = false;
});
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.mc_timer_settings) {
      _timerResetHour = changes.mc_timer_settings.newValue?.resetHour ?? TIMER_DEFAULT_RESET_HOUR;
    }
    if (changes.mc_timer_tracking_enabled) {
      _timerTrackingEnabled = changes.mc_timer_tracking_enabled.newValue !== false;
    }
  });
} catch {}

var _timerPendingSec = 0;
var _timerFlushTimer = null;
var _timerSite = null; // set once by startVideoTimeTracking — one video source per page
function _timerFlush() {
  _timerFlushTimer = null;
  const add = _timerPendingSec;
  _timerPendingSec = 0;
  if (add <= 0 || !chrome.runtime?.id) return;
  try {
    chrome.storage.local.get(['mc_timer_days', 'mc_timer_site_totals', 'mc_timer_source_days'], ({ mc_timer_days = {}, mc_timer_site_totals = {}, mc_timer_source_days = {} }) => {
      if (chrome.runtime.lastError) return;
      const day = timerLogicalDay(Date.now(), _timerResetHour);
      mc_timer_days[day] = (mc_timer_days[day] || 0) + add;
      if (_timerSite) {
        mc_timer_site_totals[_timerSite] = (mc_timer_site_totals[_timerSite] || 0) + add;
        mc_timer_source_days[_timerSite] = mc_timer_source_days[_timerSite] || {};
        mc_timer_source_days[_timerSite][day] = (mc_timer_source_days[_timerSite][day] || 0) + add;
      }
      chrome.storage.local.set({ mc_timer_days, mc_timer_site_totals, mc_timer_source_days });
    });
  } catch {}
}
function _timerAddSeconds(sec) {
  _timerPendingSec += sec;
  if (!_timerFlushTimer) _timerFlushTimer = setTimeout(_timerFlush, 3000);
}
window.addEventListener('pagehide', () => {
  if (_timerFlushTimer) { clearTimeout(_timerFlushTimer); _timerFlush(); }
});

// Lets any extension page (popup, stats page) show a "currently tracking"
// indicator without guessing which tab to check — they just read this
// timestamp from storage and treat it as live if it's recent. Throttled to
// one write per ~2s since it doesn't need per-second precision.
var _timerHeartbeatTimer = null;
function _timerHeartbeat() {
  if (_timerHeartbeatTimer || !chrome.runtime?.id) return;
  _timerHeartbeatTimer = setTimeout(() => { _timerHeartbeatTimer = null; }, 2000);
  try { chrome.storage.local.set({ mc_timer_last_active: Date.now() }); } catch {}
}

// Tracks real elapsed time while getVideoEl() returns a playing, visible video.
// Ignores background tabs and large gaps (throttled/suspended timers) so only
// genuine watch time accumulates into the daily immersion total. `site` is a
// short id (e.g. 'yt', 'cij', 'njk', 'player') used for the per-source breakdown.
var _timerIsRecording = false; // page-local: true while this tab is actively accumulating

function startVideoTimeTracking(getVideoEl, site) {
  _timerSite = site || null;
  let lastTick = null;
  setInterval(() => {
    if (!_timerTrackingEnabled) { lastTick = null; _timerIsRecording = false; return; }
    let video;
    try { video = getVideoEl(); } catch { video = null; }
    const backgrounded = document.hidden && document.pictureInPictureElement !== video;
    if (!video || video.paused || video.ended || backgrounded) { lastTick = null; _timerIsRecording = false; return; }
    _timerIsRecording = true;
    _timerHeartbeat();
    const now = Date.now();
    if (lastTick != null) {
      const delta = (now - lastTick) / 1000;
      if (delta > 0 && delta < 5) _timerAddSeconds(delta);
    }
    lastTick = now;
  }, 1000);
}

// ── Shared control-bar widgets ─────────────────────────────────────────────

// Immersion status dot for on-video control bars. Green glow = this tab is
// recording immersion time right now; grey = auto-detect on but idle;
// red = auto-detect disabled. Click toggles the global auto-detect setting.
function mcCreateTimerDotButton({ borderSide = 'right' } = {}) {
  const btn = document.createElement('button');
  btn.className = 'mc-timer-dot-btn';
  btn.style.cssText = [
    'padding:0 9px', 'background:none', 'border:none',
    `border-${borderSide}:1px solid rgba(255,255,255,.12)`,
    'cursor:pointer', 'display:flex', 'align-items:center',
  ].join(';');
  const dot = document.createElement('span');
  dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#666;transition:background .2s,box-shadow .2s';
  btn.appendChild(dot);

  const update = () => {
    if (!chrome.runtime?.id) return;
    if (!_timerTrackingEnabled) {
      dot.style.background = '#ED7989'; dot.style.boxShadow = 'none';
      btn.title = 'Immersion tracking disabled — click to enable';
    } else if (_timerIsRecording) {
      dot.style.background = '#72CE9D'; dot.style.boxShadow = '0 0 5px #72CE9D';
      btn.title = 'Recording immersion time — click to disable tracking';
    } else {
      dot.style.background = '#666'; dot.style.boxShadow = 'none';
      btn.title = 'Immersion auto-detect on (idle) — click to disable';
    }
  };
  update();
  setInterval(update, 1000);

  btn.addEventListener('click', e => {
    e.stopPropagation();
    try { chrome.storage.local.set({ mc_timer_tracking_enabled: !_timerTrackingEnabled }); } catch {}
  });
  return btn;
}

// Applies the user's preferred corner (mc_bar_position: tl/tr/bl/br) to an
// absolutely-positioned control bar, and live-updates when the setting changes.
function mcApplyBarPosition(bar) {
  const apply = pos => {
    const p = (pos === 'tr' || pos === 'bl' || pos === 'br') ? pos : 'tl';
    // 'auto' (not '') so stylesheet top/left rules can't fight the inline values
    bar.style.top = bar.style.bottom = bar.style.left = bar.style.right = 'auto';
    if (p[0] === 't') bar.style.top = '12px'; else bar.style.bottom = '80px';
    if (p[1] === 'l') bar.style.left = '12px'; else bar.style.right = '12px';
  };
  _chromeGet(['mc_bar_position']).then(d => apply(d.mc_bar_position));
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.mc_bar_position) apply(changes.mc_bar_position.newValue);
    });
  } catch {}
}

function showBadge(container, score, { top='10px', left='10px' } = {}) {
  let badge = container.querySelector('.jp-comp-badge');
  if (score === null) { if (badge) badge.remove(); return; }
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'jp-comp-badge';
    badge.style.cssText = [
      'position:absolute', `top:${top}`, `left:${left}`,
      'z-index:99999', 'pointer-events:none',
      'background:rgba(0,0,0,0.78)', 'color:#fff',
      'padding:4px 10px', 'border-radius:20px',
      "font:700 14px/1 -apple-system,'Helvetica Neue',sans-serif",
      'display:inline-flex', 'align-items:center', 'gap:6px',
      'width:max-content', 'white-space:nowrap', 'box-sizing:content-box',
    ].join(';');
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(badge);
  }
  const col = compColor(score);
  badge.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${col};display:inline-block;flex-shrink:0"></span>${score}%`;
}
