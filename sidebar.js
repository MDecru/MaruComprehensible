// Sidebar — unknown words grouped by JLPT level.
// Depends on: common.js (buildMergedTokens, getTokenizer, getVocab, MM_CONTENT_POS, hasKanji)
//             hover.js (_katToHira, _hoverJlptMap)

let _sidebarEl = null;
let _sbPrevBodyMargin = '';
let _sbPushFn = null;
let _sbPopFn  = null;
let _sbLastGroups = null;

// Site content scripts can register custom push/restore handlers when body
// marginRight doesn't work (e.g. YouTube, NJK where body overflow is hidden).
function sbRegisterPush(pushFn, popFn) { _sbPushFn = pushFn; _sbPopFn = popFn; }
let _sbSortMode = 'jlpt';   // 'jlpt' | 'freq'
let _sbActiveFilter = 'unknown';
let _sbViewMode = 'words';  // 'words' | 'kanji'
let _sbLastKanjiGroups = null;

function sidebarIsOpen() { return _sidebarEl !== null; }

async function sidebarToggle(text) {
  if (_sidebarEl) { _sidebarClose(); return { ok: true, closed: true }; }
  // Dismiss any pinned hover tooltip so it doesn't overlap the sidebar
  if (typeof _hoverHide === 'function') _hoverHide();
  if (!text?.trim()) return { ok: false, error: 'No text available' };

  let tokenizer;
  try { tokenizer = await getTokenizer(); }
  catch { return { ok: false, error: 'Tokenizer not ready — pre-load first' }; }

  const [vocab, jlptMap, { light_theme }, kanjiKnownSet] = await Promise.all([
    getVocab(),
    _sbLoadJlptMap(),
    new Promise(r => chrome.storage.local.get('light_theme', r)),
    getKanji(),
  ]);
  const tokens = buildMergedTokens(tokenizer.tokenize(text), vocab);

  // Collect all unique content words (known and unknown)
  const seen = new Map();
  for (const tok of tokens) {
    if (!MM_CONTENT_POS.has(tok.pos)) continue;
    const w = tok.basic_form || tok.surface_form;
    if (!hasKanji(w) && [...w].length < 2) continue;

    const known = vocab.has(w) || vocab.has(tok.surface_form);
    if (!seen.has(w)) {
      // Hardest kanji level determines word level (1=N1 hardest, 5=N5 easiest)
      let level = 0;
      for (const ch of w) {
        const l = jlptMap[ch];
        if (l && (level === 0 || l < level)) level = l;
      }
      seen.set(w, { basic: w, reading: _katToHira(tok.reading || ''), level, known, count: 0 });
    }
    seen.get(w).count++;
  }

  const groups = { 5: [], 4: [], 3: [], 2: [], 1: [], 0: [] };
  for (const entry of seen.values()) groups[entry.level].push(entry);

  // Collect unique kanji from content tokens
  const kanjiSeen = new Map();
  for (const tok of tokens) {
    if (!MM_CONTENT_POS.has(tok.pos)) continue;
    const w = tok.basic_form || tok.surface_form;
    for (const ch of w) {
      if (!/[一-龯㐀-䶿]/.test(ch)) continue;
      if (!kanjiSeen.has(ch)) {
        const lvl = jlptMap[ch] || 0;
        kanjiSeen.set(ch, { basic: ch, reading: '', level: lvl, known: kanjiKnownSet.has(ch), count: 0 });
      }
      kanjiSeen.get(ch).count++;
    }
  }
  const kanjiGroups = { 5: [], 4: [], 3: [], 2: [], 1: [], 0: [] };
  for (const entry of kanjiSeen.values()) kanjiGroups[entry.level].push(entry);

  _sidebarInject(groups, kanjiGroups, !!light_theme);
  return { ok: true };
}

function _sidebarClose() {
  _sidebarEl?.remove();
  _sidebarEl = null;
  if (_sbPopFn) {
    _sbPopFn();
  } else {
    document.body.style.transition = 'margin-right .2s ease';
    document.body.style.marginRight = _sbPrevBodyMargin;
  }
}

async function _sbLoadJlptMap() {
  // Reuse map already loaded by hover.js if available
  if (window._jlptMapCache) return window._jlptMapCache;
  if (_hoverJlptMap && Object.keys(_hoverJlptMap).length) {
    window._jlptMapCache = _hoverJlptMap;
    return _hoverJlptMap;
  }
  try {
    const r = await fetch(chrome.runtime.getURL('data/jlpt_mapping.json'));
    const data = await r.json();
    const map = {};
    for (const [lvl, ks] of Object.entries(data)) for (const k of ks) map[k] = +lvl;
    window._jlptMapCache = map;
    _hoverJlptMap = map;
    return map;
  } catch { return {}; }
}

const _SB_LABEL = { 1:'N1', 2:'N2', 3:'N3', 4:'N4', 5:'N5', 0:'Other' };
const _SB_COLOR = { 5:'#ED7989', 4:'#FDC281', 3:'#72CE9D', 2:'#66AAE8', 1:'#7E69F0', 0:'#555a65' };

function _sbHex2rgb(hex) {
  return [1,3,5].map(i => parseInt(hex.slice(i, i+2), 16)).join(',');
}

function _sbEsc(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _sbWordHtml(w, wordCol, dimColor, readingColor) {
  const reading = (w.reading && w.reading !== w.basic)
    ? `<span class="sb-r">${_sbEsc(w.reading)}</span>` : '';
  const count = w.count > 1 ? `<span class="sb-x">×${w.count}</span>` : '';
  const cls   = `sb-word${w.known ? ' sb-known' : ' sb-unknown'}`;
  return `<div class="${cls}" data-basic="${_sbEsc(w.basic)}" data-reading="${_sbEsc(w.reading)}" style="--c:${wordCol}">
    <span class="sb-s">${_sbEsc(w.basic)}</span>${reading}${count}
  </div>`;
}

function _sbBuildSections(groups, isLight, sortMode) {
  const empty = '<div style="padding:28px 14px;color:#4a5068;font-size:12px;text-align:center">No words found</div>';

  if (sortMode === 'freq') {
    const allWords = Object.entries(groups).flatMap(([lvl, ws]) =>
      ws.map(w => ({ ...w, lvl: +lvl }))
    ).sort((a, b) => b.count - a.count);
    if (!allWords.length) return empty;
    const wUnk = allWords.filter(w => !w.known).length;
    const wKnw = allWords.filter(w =>  w.known).length;
    const wordsHtml = allWords.map(w => {
      const col = (w.lvl === 0 && !isLight) ? '#c8cedd' : _SB_COLOR[w.lvl];
      return _sbWordHtml(w, col);
    }).join('');
    return `<div class="sb-sec" data-unk="${wUnk}" data-knw="${wKnw}">
      <div class="sb-sh">
        <span class="sb-n sb-n-unk">${wUnk} unknown</span>
        <span class="sb-n sb-n-knw" style="display:none">${wKnw} known</span>
        <span class="sb-n sb-n-all" style="display:none">${allWords.length} words</span>
        <button class="sb-tog" title="Collapse section">−</button>
      </div>
      <div class="sb-ws">${wordsHtml}</div>
    </div>`;
  }

  // JLPT grouped view
  let html = '';
  for (const lvl of [5, 4, 3, 2, 1, 0]) {
    const words = groups[lvl];
    if (!words.length) continue;
    const col     = _SB_COLOR[lvl];
    const wordCol = (lvl === 0 && !isLight) ? '#c8cedd' : col;
    const label   = _SB_LABEL[lvl];
    const rgb     = _sbHex2rgb(col);
    const wUnk    = words.filter(w => !w.known).length;
    const wKnw    = words.filter(w =>  w.known).length;
    const wordsHtml = words.map(w => _sbWordHtml(w, wordCol)).join('');
    html += `<div class="sb-sec" data-unk="${wUnk}" data-knw="${wKnw}">
      <div class="sb-sh">
        <span class="sb-badge" style="color:${col};border-color:rgba(${rgb},.35);background:rgba(${rgb},.12)">${label}</span>
        <span class="sb-n sb-n-unk">${wUnk} unknown</span>
        <span class="sb-n sb-n-knw" style="display:none">${wKnw} known</span>
        <span class="sb-n sb-n-all" style="display:none">${words.length} word${words.length !== 1 ? 's' : ''}</span>
        <button class="sb-tog" title="Collapse section">−</button>
      </div>
      <div class="sb-ws">${wordsHtml}</div>
    </div>`;
  }
  return html || empty;
}

function _sidebarInject(groups, kanjiGroups, isLight = false) {
  _sbLastGroups = groups;
  _sbLastKanjiGroups = kanjiGroups;
  _sidebarClose();

  // Theme tokens
  const T = isLight ? {
    bg:         '#ffffff',
    surface:    '#f0f2f5',
    border:     '#66AAE8',
    text:       '#2c2f33',
    body:       '#3a3f47',
    muted:      '#66748a',
    dim:        '#8896a8',
    ftabBg:     '#66AAE8',
    ftabColor:  '#fff',
    wordHover:  'rgba(102,170,232,.08)',
    reading:    '#66AAE8',
    closeColor: '#7E69F0',
    closeHover: '#5a4bc8',
  } : {
    bg:         '#232425',
    surface:    '#2D3031',
    border:     '#363A3B',
    text:       '#f0f2f8',
    body:       '#d4d8e8',
    muted:      '#9aa3bc',
    dim:        '#5a6282',
    ftabBg:     '#72CE9D',
    ftabColor:  '#fff',
    wordHover:  'rgba(255,255,255,.05)',
    reading:    '#66AAE8',
    closeColor: '#4a5068',
    closeHover: '#e8eaf0',
  };

  const allWords = Object.values(groups).flat();
  const unknownCount = allWords.filter(w => !w.known).length;
  const knownCount   = allWords.filter(w =>  w.known).length;
  const allKanji = Object.values(kanjiGroups).flat();
  const kanjiUnk = allKanji.filter(k => !k.known).length;
  const kanjiKnw = allKanji.filter(k =>  k.known).length;

  const el = document.createElement('div');
  el.id = 'jp-sidebar';
  el.innerHTML = `<style>
    #jp-sidebar{position:fixed;top:0;right:0;width:260px;height:100vh;
      background:${T.bg};border-left:1px solid ${T.border};
      font-family:-apple-system,'Helvetica Neue',sans-serif;
      z-index:2147483646;overflow-y:auto;
      box-shadow:-6px 0 24px rgba(0,0,0,.4);color:${T.body};font-size:13px}
    #jp-sb-hd{display:flex;align-items:center;padding:13px 14px 11px;
      border-bottom:1px solid ${T.border};position:sticky;top:0;background:${T.bg};z-index:1;
      flex-wrap:wrap;gap:6px 0}
    #jp-sb-top{display:flex;align-items:center;width:100%}
    #jp-sb-stats{display:flex;flex-direction:column;gap:2px;font-size:11px;color:${T.dim};width:100%;margin-top:3px}
    #jp-sb-ttl{font-size:13px;font-weight:700;color:${T.text};letter-spacing:.3px}
    #jp-sb-tot{font-size:11px;color:${T.dim}}
    #jp-sb-cls{margin-left:auto;background:none;border:none;color:${T.closeColor};
      font-size:18px;cursor:pointer;line-height:1;padding:0 2px}
    #jp-sb-cls:hover{color:${T.closeHover}}
    #jp-sb-view{display:flex;align-items:center;gap:4px;width:100%}
    #jp-sb-controls{display:flex;align-items:center;gap:4px;width:100%;flex-wrap:wrap}
    #jp-sb-filter{display:flex;gap:4px;flex:1}
    #jp-sb-sort{margin-left:auto}
    .sb-vtab,.sb-ftab,.sb-sort{background:rgba(128,128,128,.08);border:1px solid rgba(128,128,128,.2);
      border-radius:12px;color:${T.muted};font-size:11px;font-weight:600;
      padding:3px 11px;cursor:pointer;transition:all .12s}
    .sb-vtab:hover,.sb-ftab:hover,.sb-sort:hover{background:rgba(128,128,128,.14);color:${T.body}}
    .sb-vtab.active,.sb-ftab.active,.sb-sort.active{background:${T.ftabBg};border-color:${T.ftabBg};color:${T.ftabColor}}
    .sb-sec{border-top:1px solid ${T.border}}
    .sb-sec.sb-collapsed .sb-ws{display:none}
    .sb-sh{display:flex;align-items:center;gap:8px;padding:9px 14px 5px;cursor:pointer;
      user-select:none}
    .sb-sh:hover{background:rgba(128,128,128,.05)}
    .sb-badge{font-size:11px;font-weight:700;border-radius:5px;padding:2px 8px;border:1px solid}
    .sb-n{font-size:11px;color:${T.dim}}
    .sb-tog{margin-left:auto;background:none;border:none;color:${T.dim};cursor:pointer;
      font-size:14px;line-height:1;padding:0 2px}
    .sb-tog:hover{color:${T.body}}
    .sb-ws{padding:2px 0 6px}
    .sb-word{display:flex;align-items:baseline;gap:5px;padding:5px 14px;
      color:${T.body};cursor:pointer;transition:background .1s}
    .sb-word:hover{background:${T.wordHover}}
    .sb-s{font-size:15px;font-weight:600;color:var(--c)}
    .sb-r{font-size:11px;color:${T.reading}}
    .sb-x{margin-left:auto;font-size:10px;color:${T.dim}}
    #jp-sidebar.filter-unknown .sb-known{display:none}
    #jp-sidebar.filter-known  .sb-unknown{display:none}
    #jp-sidebar.filter-unknown .sb-sec[data-unk="0"],
    #jp-sidebar.filter-known  .sb-sec[data-knw="0"]{display:none}
  </style>
  <div id="jp-sb-hd">
    <div id="jp-sb-top">
      <span id="jp-sb-ttl">Words</span>
      <button id="jp-sb-cls">×</button>
    </div>
    <div id="jp-sb-stats">
      <span id="jp-sb-tot">${unknownCount} unknown · ${knownCount} known</span>
      <span id="jp-sb-kanjitot">${kanjiUnk} kanji unknown · ${kanjiKnw} known</span>
    </div>
    <div id="jp-sb-view">
      <button class="sb-vtab${_sbViewMode === 'words' ? ' active' : ''}" data-view="words">Words</button>
      <button class="sb-vtab${_sbViewMode === 'kanji' ? ' active' : ''}" data-view="kanji">Kanji</button>
      <button class="sb-sort${_sbSortMode === 'freq' ? ' active' : ''}" id="jp-sb-sort" style="margin-left:auto">⇅ Freq</button>
    </div>
    <div id="jp-sb-controls">
      <div id="jp-sb-filter">
        <button class="sb-ftab active" data-filter="unknown">Unknown</button>
        <button class="sb-ftab" data-filter="">All</button>
        <button class="sb-ftab" data-filter="known">Known</button>
      </div>
    </div>
  </div>
  <div id="jp-sb-body">${_sbBuildSections(_sbViewMode === 'kanji' ? kanjiGroups : groups, isLight, _sbSortMode)}</div>`;

  // Push page content left so sidebar doesn't overlay it
  if (_sbPushFn) {
    _sbPushFn();
  } else {
    _sbPrevBodyMargin = document.body.style.marginRight;
    document.body.style.transition = 'margin-right .2s ease';
    document.body.style.marginRight = '260px';
  }

  document.body.appendChild(el);
  _sidebarEl = el;

  // Start with saved filter active
  el.classList.add(_sbActiveFilter ? `filter-${_sbActiveFilter}` : '');
  _sbUpdateSectionCounts(el, _sbActiveFilter);

  el.querySelector('#jp-sb-cls').addEventListener('click', _sidebarClose);

  // Filter tabs
  el.querySelector('#jp-sb-filter').addEventListener('click', e => {
    const tab = e.target.closest('.sb-ftab');
    if (!tab) return;
    el.querySelectorAll('.sb-ftab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const f = tab.dataset.filter;
    _sbActiveFilter = f;
    el.classList.toggle('filter-unknown', f === 'unknown');
    el.classList.toggle('filter-known',   f === 'known');
    _sbUpdateSectionCounts(el, f);
  });

  // View toggle (Words / Kanji)
  el.querySelector('#jp-sb-view').addEventListener('click', e => {
    const vtab = e.target.closest('.sb-vtab');
    if (vtab) {
      el.querySelectorAll('.sb-vtab').forEach(t => t.classList.remove('active'));
      vtab.classList.add('active');
      _sbViewMode = vtab.dataset.view;
      const activeGroups = _sbViewMode === 'kanji' ? _sbLastKanjiGroups : _sbLastGroups;
      el.querySelector('#jp-sb-body').innerHTML = _sbBuildSections(activeGroups, isLight, _sbSortMode);
      _sbUpdateSectionCounts(el, _sbActiveFilter);
      const allW = Object.values(activeGroups).flat();
      const unk = allW.filter(w => !w.known).length;
      const knw = allW.filter(w =>  w.known).length;
      el.querySelector('#jp-sb-tot').textContent = `${unk} unknown · ${knw} known`;
    }
  });

  // Sort toggle
  el.querySelector('#jp-sb-sort').addEventListener('click', e => {
    _sbSortMode = _sbSortMode === 'freq' ? 'jlpt' : 'freq';
    e.currentTarget.classList.toggle('active', _sbSortMode === 'freq');
    const activeGroups = _sbViewMode === 'kanji' ? _sbLastKanjiGroups : _sbLastGroups;
    el.querySelector('#jp-sb-body').innerHTML = _sbBuildSections(activeGroups, isLight, _sbSortMode);
    _sbUpdateSectionCounts(el, _sbActiveFilter);
  });

  // Collapse/expand sections via header click or toggle button
  el.addEventListener('click', e => {
    const sh = e.target.closest('.sb-sh');
    if (!sh) return;
    // Don't collapse if clicking on the word itself (sb-word is a child of sb-ws, not sb-sh)
    const sec = sh.closest('.sb-sec');
    if (!sec) return;
    sec.classList.toggle('sb-collapsed');
    const tog = sh.querySelector('.sb-tog');
    if (tog) tog.textContent = sec.classList.contains('sb-collapsed') ? '+' : '−';
  });

  // Word clicks — open hover tooltip
  el.addEventListener('click', e => {
    const word = e.target.closest('.sb-word');
    if (!word) return;
    hoverShowWord({ basic: word.dataset.basic, reading: word.dataset.reading }, word);
  });
}

function _sbUpdateSectionCounts(el, filter) {
  for (const sec of el.querySelectorAll('.sb-sec')) {
    sec.querySelector('.sb-n-unk').style.display = filter === 'unknown' ? '' : 'none';
    sec.querySelector('.sb-n-knw').style.display = filter === 'known'   ? '' : 'none';
    sec.querySelector('.sb-n-all').style.display = filter === ''        ? '' : 'none';
  }
}

// Re-inject with new theme when the popup toggle changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'light_theme' in changes && _sidebarEl && _sbLastGroups) {
    _sidebarInject(_sbLastGroups, _sbLastKanjiGroups || { 5:[], 4:[], 3:[], 2:[], 1:[], 0:[] }, !!changes.light_theme.newValue);
  }
});
