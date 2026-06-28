// Hover mode — tokenizes transcript text into clickable word spans.
// Depends on: common.js (getTokenizer, getVocab, MM_CONTENT_POS, hasKanji)

const HOVER_JLPT_COLORS = { 5:'#ED7989', 4:'#FDC281', 3:'#72CE9D', 2:'#66AAE8', 1:'#7E69F0' };
const HOVER_JLPT_LABELS = { 1:'N1', 2:'N2', 3:'N3', 4:'N4', 5:'N5' };

let _hoverEnabled  = false;
let _hoverJlptMap  = null;
let _hoverVocab    = null;
let _hoverTip      = null;
let _hoverPinned   = null;
let _hoverStyle    = null;
let _hoverIsLight  = false;

// ── Init / teardown ──────────────────────────────────────────────────────────

// Lazily inject tooltip CSS + element (shared by hover mode and sidebar word clicks)
function _ensureHoverUI() {
  if (!_hoverStyle) {
    _hoverStyle = document.createElement('style');
    _hoverStyle.textContent = `
      .jp-tok { border-radius:2px; cursor:pointer; transition:background .1s; }
      .jp-tok:hover { background:rgba(114,206,157,.18) !important; outline:1px solid rgba(114,206,157,.4); }
      .jp-tok.jp-tok-sel { background:rgba(114,206,157,.22) !important; outline:2px solid rgba(114,206,157,.6); }

      /* ── Dark theme (default) ── */
      #jp-hover-tip { position:fixed; z-index:2147483647; background:#232425; border:1px solid #363A3B;
        color:#c8d0e0; border-radius:14px; font-size:13px; line-height:1.4; width:260px;
        box-shadow:0 12px 40px rgba(0,0,0,.9); font-family:-apple-system,'Helvetica Neue',sans-serif;
        pointer-events:none; display:none; overflow:hidden; }
      #jp-hover-tip.pinned { pointer-events:auto; }
      .jht-head { display:flex; align-items:center; gap:8px; padding:10px 12px 8px;
        border-bottom:1px solid #363A3B; min-width:0; }
      .jht-word { font-size:20px; font-weight:700; color:#fff; letter-spacing:.02em;
        flex-shrink:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .jht-right { display:flex; align-items:center; gap:6px; margin-left:auto; flex-shrink:0; }
      .jht-close { background:none; border:none; color:#555; font-size:16px; line-height:1; cursor:pointer; padding:0 2px; }
      .jht-close:hover { color:#fff; }
      .jht-reading { font-size:12px; color:#66AAE8; padding:5px 12px 2px; }
      .jht-status { font-size:11px; font-weight:700; padding:2px 9px; border-radius:12px; white-space:nowrap; }
      .jht-status.known   { background:rgba(114,206,157,.15); color:#72CE9D; }
      .jht-status.unknown { background:rgba(237,121,137,.15); color:#ED7989; }
      .jht-kanji { display:flex; flex-wrap:wrap; gap:5px; padding:7px 12px; }
      .jht-kc { display:flex; flex-direction:column; align-items:center; padding:5px 8px;
        border-radius:8px; border:1px solid rgba(114,206,157,.3); text-decoration:none;
        min-width:40px; transition:filter .12s; }
      .jht-kc:hover { background:rgba(114,206,157,.18); }
      .jht-kc.unknown:hover { background:rgba(237,121,137,.18); }
      .jht-kc.unknown { border-color:rgba(237,121,137,.3); }
      .jht-kc-ch { font-size:18px; font-weight:700; color:#72CE9D; line-height:1.2; }
      .jht-kc.unknown .jht-kc-ch { color:#ED7989; }
      .jht-kc-lv { font-size:10px; font-weight:600; color:#72CE9D; opacity:.8; margin-top:1px; }
      .jht-kc.unknown .jht-kc-lv { color:#ED7989; }
      .jht-footer { display:flex; justify-content:flex-end; gap:7px; padding:6px 12px 9px;
        border-top:1px solid #363A3B; }
      .jht-link { font-size:12px; font-weight:700; padding:4px 12px; border-radius:16px;
        text-decoration:none; color:#fff; border:1px solid transparent; transition:filter .12s; }
      .jht-link:hover { filter:brightness(.85); }
      .jht-jisho { background:#66AAE8; border-color:#66AAE8; }
      .jht-mm    { background:#FDC281; border-color:#FDC281; }
      .jht-defs { padding:5px 12px 6px; border-bottom:1px solid #363A3B; }
      .jht-gloss { color:#dde2ee; font-size:13px; list-style:decimal; margin:0; padding-left:15px; }
      .jht-gloss li { margin-bottom:4px; line-height:1.4; }
      .jht-pos { font-size:10px; color:#8894b0; background:rgba(255,255,255,.07); border-radius:3px;
        padding:1px 5px; margin-left:6px; font-style:italic; vertical-align:middle;
        display:inline; white-space:nowrap; }
      .jht-loading  { font-size:11px; color:#555; font-style:italic; padding:2px 0; }
      .jht-no-entry { font-size:11px; color:#555; font-style:italic; padding:2px 0; }

      /* ── Light theme ── */
      #jp-hover-tip.jht-light { background:#ffffff; border-color:#66AAE8; color:#3a3f47;
        box-shadow:0 8px 32px rgba(0,0,0,.18); }
      #jp-hover-tip.jht-light .jht-head { border-bottom-color:#e0e4f0; }
      #jp-hover-tip.jht-light .jht-word { color:#2c2f33; }
      #jp-hover-tip.jht-light .jht-close { color:#aab4c4; }
      #jp-hover-tip.jht-light .jht-close:hover { color:#66748a; }
      #jp-hover-tip.jht-light .jht-status.known   { background:rgba(114,206,157,.2); color:#1e7a4e; }
      #jp-hover-tip.jht-light .jht-status.unknown { background:rgba(237,121,137,.2); color:#b82d3e; }
      #jp-hover-tip.jht-light .jht-kc { border-color:rgba(114,206,157,.5); }
      #jp-hover-tip.jht-light .jht-kc.unknown { border-color:rgba(237,121,137,.4); }
      #jp-hover-tip.jht-light .jht-kc-ch { color:#1e7a4e; }
      #jp-hover-tip.jht-light .jht-kc.unknown .jht-kc-ch { color:#b82d3e; }
      #jp-hover-tip.jht-light .jht-kc-lv { color:#1e7a4e; }
      #jp-hover-tip.jht-light .jht-kc.unknown .jht-kc-lv { color:#b82d3e; }
      #jp-hover-tip.jht-light .jht-footer { border-top-color:#e0e4f0; }
      #jp-hover-tip.jht-light .jht-defs { border-bottom-color:#e0e4f0; }
      #jp-hover-tip.jht-light .jht-gloss { color:#3a3f47; }
      #jp-hover-tip.jht-light .jht-pos { color:#66748a; background:rgba(0,0,0,.06); }
      #jp-hover-tip.jht-light .jht-loading,
      #jp-hover-tip.jht-light .jht-no-entry { color:#aab4c4; }
    `;
    document.head.appendChild(_hoverStyle);
    // Read initial theme
    chrome.storage.local.get('light_theme', ({ light_theme }) => {
      _hoverIsLight = !!light_theme;
      if (_hoverTip) _hoverTip.classList.toggle('jht-light', _hoverIsLight);
    });
  }
  if (!_hoverTip) {
    _hoverTip = document.createElement('div');
    _hoverTip.id = 'jp-hover-tip';
    _hoverTip.classList.toggle('jht-light', _hoverIsLight);
    document.body.appendChild(_hoverTip);
  }
}

async function hoverEnable(findContainer) {
  if (_hoverEnabled) return { ok: true, msg: 'already on' };

  // Need tokenizer
  let tokenizer;
  try { tokenizer = await getTokenizer(); }
  catch (e) { return { ok: false, error: 'Tokenizer not ready — pre-load first' }; }

  // JLPT map
  if (!_hoverJlptMap) {
    try {
      const r = await fetch(chrome.runtime.getURL('data/jlpt_mapping.json'));
      const data = await r.json();
      _hoverJlptMap = {};
      for (const [lvl, ks] of Object.entries(data))
        for (const k of ks) _hoverJlptMap[k] = +lvl;
    } catch { _hoverJlptMap = {}; }
  }

  _hoverVocab = await getVocab();

  // Find the transcript container
  const container = findContainer();
  if (!container) return { ok: false, error: 'No transcript found on page' };

  _ensureHoverUI();

  // Tokenize the container
  _hoverTokenizeElement(container, tokenizer);

  // Event listeners — capture phase ensures YouTube's SPA delegation can't block us
  document.addEventListener('mouseover',  _hoverOver,  { passive: true, capture: true });
  document.addEventListener('mouseout',   _hoverOut,   { passive: true, capture: true });
  document.addEventListener('click',      _hoverClick, true);
  document.addEventListener('keydown',    _hoverKey,   true);

  _hoverEnabled = true;
  return { ok: true };
}

function hoverDisable() {
  if (!_hoverEnabled) return;
  _hoverEnabled = false;

  document.removeEventListener('mouseover',  _hoverOver,  { capture: true });
  document.removeEventListener('mouseout',   _hoverOut,   { capture: true });
  document.removeEventListener('click',      _hoverClick, true);
  document.removeEventListener('keydown',    _hoverKey,   true);

  _hoverHide();
  if (_hoverTip)   { _hoverTip.remove();   _hoverTip = null; }
  if (_hoverStyle) { _hoverStyle.remove(); _hoverStyle = null; }

  // Unwrap token spans, restoring original children (preserves <ruby> markup)
  for (const span of document.querySelectorAll('.jp-tok')) {
    span.replaceWith(...Array.from(span.childNodes));
  }
  // Clear processed markers so re-enabling re-tokenizes cleanly
  for (const el of document.querySelectorAll('[data-jp-done]')) {
    delete el.dataset.jpDone;
  }
}

// ── Tokenize DOM ─────────────────────────────────────────────────────────────

// Re-tokenize new content added to the DOM after hover was enabled
async function hoverRetokenize(root) {
  if (!_hoverEnabled || !root) return;
  const tokenizer = await getTokenizer().catch(() => null);
  if (!tokenizer) return;
  _hoverVocab = await getVocab(); // refresh in case it changed
  _hoverTokenizeElement(root, tokenizer);
}

// ── Tokenize DOM (ruby-aware) ─────────────────────────────────────────────────
//
// NJK pages use <ruby>漢字<rt>reading</rt></ruby> markup. A plain TreeWalker
// sees separate text nodes ("漢字" inside ruby, "reading" inside rt, trailing
// kana as a sibling) so cross-node merging is impossible.
//
// Instead we: (1) find "line containers" — elements that directly hold text /
// ruby children, (2) build a posMap of (textNode, offset) pairs that skips
// <rt>/<rp> content, (3) tokenize the cleaned string, (4) use DOM Ranges to
// wrap content tokens — a range can span the ruby→sibling boundary so the
// whole conjugated word becomes one .jp-tok span with the ruby preserved inside.

function _hoverTokenizeElement(root, tokenizer) {
  const containers = new Set();

  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = tw.nextNode())) {
    if (n.parentElement?.closest('.jp-tok, #jp-hover-tip, rt, rp')) continue;
    if (!/[぀-鿿゠-ヿ]/.test(n.textContent)) continue;
    // If inside <ruby>, the container is ruby's parent; otherwise the direct parent
    let c = n.parentElement;
    if (c?.nodeName === 'RUBY') c = c.parentElement;
    if (c && c !== root) containers.add(c);
  }

  for (const c of containers) {
    if (!root.contains(c) || c.closest('.jp-tok, #jp-hover-tip')) continue;
    if (c.dataset.jpDone) continue;
    _hoverProcessContainer(c, tokenizer);
    c.dataset.jpDone = '1';
  }
}

// Build cleaned text + posMap (textNode/offset per char, skipping rt/rp).
function _hoverBuildPosMap(container) {
  const posMap = [];
  let text = '';

  function walk(el) {
    for (const child of el.childNodes) {
      if (child.nodeName === 'RT' || child.nodeName === 'RP') continue;
      if (child.nodeType === Node.TEXT_NODE) {
        for (let i = 0; i < child.textContent.length; i++) {
          posMap.push({ node: child, offset: i });
        }
        text += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.classList?.contains('jp-tok') || child.id === 'jp-hover-tip') continue;
        walk(child);
      }
    }
  }

  walk(container);
  return { text, posMap };
}

function _hoverProcessContainer(container, tokenizer) {
  const { text, posMap } = _hoverBuildPosMap(container);
  if (!text.trim() || !/[぀-鿿゠-ヿ]/.test(text)) return;

  const tokens = buildMergedTokens(tokenizer.tokenize(text), _hoverVocab);

  // Collect wraps in forward order, apply in REVERSE so later DOM changes
  // don't invalidate earlier node references.
  const toWrap = [];
  let pos = 0;

  for (const tok of tokens) {
    const surface = tok.surface_form;
    const start = pos, end = pos + surface.length;
    pos = end;
    if (end > posMap.length) break;
    if (!MM_CONTENT_POS.has(tok.pos) || NUMERAL_RE.test(surface)) continue;

    const basic = tok.basic_form || surface;
    // Determine JLPT level from hardest kanji in the word
    let level = 0;
    for (const ch of basic) {
      const l = _hoverJlptMap?.[ch];
      if (l && (level === 0 || l < level)) level = l;
    }
    toWrap.push({
      sNode: posMap[start].node,   sOff: posMap[start].offset,
      eNode: posMap[end-1].node,   eOff: posMap[end-1].offset + 1,
      surface, basic, level,
      pos:     tok.pos,
      reading: tok.reading || '',
      known:   _hoverVocab.has(basic) || _hoverVocab.has(surface),
    });
  }

  for (let i = toWrap.length - 1; i >= 0; i--) {
    const w = toWrap[i];
    try {
      const range = document.createRange();
      range.setStart(w.sNode, w.sOff);
      range.setEnd(w.eNode, w.eOff);

      const span = document.createElement('span');
      span.className       = 'jp-tok';
      span.dataset.word    = w.surface;
      span.dataset.basic   = w.basic;
      span.dataset.pos     = w.pos;
      span.dataset.reading = w.reading;
      span.style.color     = w.known
        ? (_hoverIsLight ? '#1a5fa8' : '#66AAE8')
        : (_hoverIsLight ? '#b82d3e' : '#ED7989');

      // extractContents handles ruby-boundary ranges — ruby markup stays inside span
      span.appendChild(range.extractContents());
      range.insertNode(span);
    } catch { /* ignore invalid ranges */ }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _katToHira(s) {
  return (s || '').replace(/[ァ-ン]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

const _defCache = {};
async function _fetchDef(word) {
  if (_defCache[word] !== undefined) return _defCache[word];
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'jishoLookup', word });
    if (!resp?.ok) { _defCache[word] = null; return null; }
    _defCache[word] = { reading: resp.reading, senses: resp.senses };
    return _defCache[word];
  } catch { _defCache[word] = null; return null; }
}

// ── Tooltip content ──────────────────────────────────────────────────────────

function _hoverBuildTip(dataset, pinned, defResult) {
  const word  = dataset.word  || '';
  const basic = dataset.basic || word;
  const pos   = dataset.pos   || '';
  const kReading = _katToHira(dataset.reading || '');

  const known = _hoverVocab?.has(basic) || _hoverVocab?.has(word);
  const statusHtml = pos
    ? `<span class="jht-status ${known ? 'known' : 'unknown'}">${known ? '✓ Known' : '? Unknown'}</span>`
    : '';

  const closeBtn = pinned ? `<button class="jht-close" title="Close">×</button>` : '';
  const headHtml = `<div class="jht-head"><span class="jht-word">${_esc(word)}</span><div class="jht-right">${statusHtml}${closeBtn}</div></div>`;

  // Reading line: prefer Jisho reading (hiragana), fallback to kuromoji
  const displayReading = defResult?.reading || kReading;
  const readingHtml = (displayReading && displayReading !== word)
    ? `<div class="jht-reading">${_esc(displayReading)}</div>` : '';

  // Definitions (from Jisho, or loading placeholder)
  let defHtml = '';
  if (pinned) {
    if (defResult === undefined) {
      // Still loading
      defHtml = `<div class="jht-defs"><span class="jht-loading">Loading…</span></div>`;
    } else if (defResult?.senses?.length) {
      const items = defResult.senses.map(s => {
        const short = s.pos ? _shortenPos(s.pos) : null;
        const posTag = short ? `<span class="jht-pos">${_esc(short)}</span>` : '';
        return `<li>${s.defs.map(_esc).join('; ')}${posTag}</li>`;
      }).join('');
      defHtml = `<div class="jht-defs"><ul class="jht-gloss">${items}</ul></div>`;
    } else if (defResult === null) {
      defHtml = `<div class="jht-defs jht-no-entry">No definition found</div>`;
    }
  }

  // Per-kanji cards
  const kanjiChars = [...basic].filter(ch => /[一-龯㐀-䶿]/.test(ch));
  const kanjiHtml = kanjiChars.length
    ? `<div class="jht-kanji">${kanjiChars.map(ch => {
        const kknown = _hoverVocab?.has(ch);
        const jlvl   = _hoverJlptMap?.[ch];
        const lvlLbl = jlvl ? HOVER_JLPT_LABELS[jlvl] : (kknown ? '✓' : '?');
        const lvlStyle = jlvl ? `color:${HOVER_JLPT_COLORS[jlvl]}` : '';
        const mmUrl = `https://marumori.io/dictionary/search?q=${encodeURIComponent(ch)}&t=kanji`;
        return `<a class="jht-kc${kknown ? '' : ' unknown'}" href="${mmUrl}" target="_blank">
          <span class="jht-kc-ch">${_esc(ch)}</span>
          <span class="jht-kc-lv" style="${lvlStyle}">${lvlLbl}</span>
        </a>`;
      }).join('')}</div>` : '';

  const displayWord = basic !== word ? basic : word;
  const footerHtml = `<div class="jht-footer">
    <a class="jht-link jht-jisho" href="https://jisho.org/search/${encodeURIComponent(displayWord)}" target="_blank">Jisho ↗</a>
    <a class="jht-link jht-mm" href="https://marumori.io/dictionary/search?q=${encodeURIComponent(displayWord)}&t=vocabulary" target="_blank">MaruMori ↗</a>
  </div>`;

  return headHtml + readingHtml + defHtml + kanjiHtml + footerHtml;
}

function _esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const _POS_MAP = [
  [/godan verb.*irregular/i,       'Godan verb (irr.)'],
  [/godan verb/i,                  'Godan verb'],
  [/ichidan verb.*irregular/i,     'Ichidan verb (irr.)'],
  [/ichidan verb/i,                'Ichidan verb'],
  [/na-adjective|keiyodoshi/i,     'na-adj.'],
  [/i-adjective|keiyoshi/i,        'i-adj.'],
  [/adverb.*to$/i,                 'Adverb (to)'],
  [/adverb/i,                      'Adverb'],
  [/auxiliary verb/i,              'Aux. verb'],
  [/auxiliary/i,                   'Auxiliary'],
  [/conjunction/i,                 'Conj.'],
  [/interjection/i,                'Interj.'],
  [/wikipedia/i,                   null],
  [/^noun/i,                       'Noun'],
  [/^particle$/i,                  'Particle'],
  [/^prefix$/i,                    'Prefix'],
  [/^suffix$/i,                    'Suffix'],
];

function _shortenPos(pos) {
  for (const [re, label] of _POS_MAP) {
    if (re.test(pos)) return label;
  }
  // Fallback: cap at 20 chars
  return pos.length > 20 ? pos.slice(0, 18) + '…' : pos;
}

// ── Positioning ──────────────────────────────────────────────────────────────

function _hoverPosition(el) {
  const rect = el.getBoundingClientRect();
  const tw   = _hoverTip.offsetWidth  || 280;
  const th   = _hoverTip.offsetHeight || 120;
  let x = rect.left;
  let y = rect.bottom + 8;
  if (x + tw > window.innerWidth  - 8) x = window.innerWidth  - tw - 8;
  if (x < 8) x = 8;
  if (y + th > window.innerHeight - 8) y = rect.top - th - 8;
  _hoverTip.style.left = x + 'px';
  _hoverTip.style.top  = y + 'px';
}

// ── Event handlers ───────────────────────────────────────────────────────────

function _hoverOver(e) {
  if (_hoverPinned) return;
  const tok = e.target.closest('.jp-tok');
  if (!tok) { _hoverTip.style.display = 'none'; return; }
  _hoverTip.innerHTML = _hoverBuildTip(tok.dataset, false, null);
  _hoverTip.style.display = 'block';
  _hoverTip.classList.remove('pinned');
  _hoverTip.style.pointerEvents = 'none';
  _hoverPosition(tok);
}

function _hoverOut(e) {
  if (_hoverPinned) return;
  if (!e.relatedTarget?.closest?.('.jp-tok')) {
    _hoverTip.style.display = 'none';
  }
}

function _hoverClick(e) {
  const tok = e.target.closest('.jp-tok');
  if (tok) {
    e.stopPropagation();
    if (_hoverPinned === tok) { _hoverHide(); return; }
    if (_hoverPinned) _hoverPinned.classList.remove('jp-tok-sel');

    // Show immediately with loading placeholder for definitions
    _hoverTip.innerHTML = _hoverBuildTip(tok.dataset, true, undefined);
    _hoverTip.style.display = 'block';
    _hoverTip.classList.add('pinned');
    _hoverTip.style.pointerEvents = 'auto';
    _hoverPosition(tok);
    _hoverPinned = tok;
    tok.classList.add('jp-tok-sel');
    _hoverTip.querySelector('.jht-close')?.addEventListener('click', _hoverHide);

    // Fetch definition then re-render in place
    const lookupWord = tok.dataset.basic || tok.dataset.word;
    _fetchDef(lookupWord).then(def => {
      if (_hoverPinned !== tok) return; // user moved on
      _hoverTip.innerHTML = _hoverBuildTip(tok.dataset, true, def);
      _hoverPosition(tok);
      _hoverTip.querySelector('.jht-close')?.addEventListener('click', _hoverHide);
    });
    return;
  }
  if (_hoverPinned && !e.target.closest('#jp-hover-tip')) _hoverHide();
}

function _hoverKey(e) {
  if (e.key === 'Escape') _hoverHide();
}

function _hoverHide() {
  if (!_hoverTip) return;
  _hoverTip.style.display = 'none';
  _hoverTip.classList.remove('pinned');
  _hoverTip.style.pointerEvents = 'none';
  if (_hoverPinned) { _hoverPinned.classList.remove('jp-tok-sel'); _hoverPinned = null; }
}

// ── Public API for sidebar ────────────────────────────────────────────────────

let _sbOutsideActive = false;

// Show a pinned hover tooltip for a word entry in the sidebar.
// Works whether hover mode is active or not.
async function hoverShowWord(wordData, anchorEl) {
  _ensureHoverUI();
  if (!_hoverVocab) _hoverVocab = await getVocab();

  // Clear previous pinned state (may be a jp-tok span or a previous sb-word sentinel)
  if (_hoverPinned) { _hoverPinned.classList.remove('jp-tok-sel'); _hoverPinned = null; }

  const dataset = {
    word:    wordData.basic,
    basic:   wordData.basic,
    pos:     '',
    reading: wordData.reading || '',
  };

  _hoverTip.innerHTML = _hoverBuildTip(dataset, true, undefined);
  _hoverTip.style.display = 'block';
  _hoverTip.classList.add('pinned');
  _hoverTip.style.pointerEvents = 'auto';

  // Use anchorEl as a sentinel so _hoverOut (if hover mode is on) sees a truthy
  // _hoverPinned and returns early — otherwise mousing over the tooltip closes it.
  _hoverPinned = anchorEl;

  _sbPosition(anchorEl);
  _hoverTip.querySelector('.jht-close')?.addEventListener('click', _hoverHide);

  // When hover mode is off its document listeners aren't registered, so add
  // click-outside and Escape handling ourselves.
  if (!_hoverEnabled) _sbEnsureOutsideListeners();

  _fetchDef(dataset.basic).then(def => {
    if (!_hoverTip || _hoverTip.style.display === 'none') return;
    _hoverTip.innerHTML = _hoverBuildTip(dataset, true, def);
    _sbPosition(anchorEl);
    _hoverTip.querySelector('.jht-close')?.addEventListener('click', _hoverHide);
  });
}

function _sbEnsureOutsideListeners() {
  if (_sbOutsideActive) return;
  _sbOutsideActive = true;

  const onKey = (e) => { if (e.key === 'Escape') { _hoverHide(); cleanup(); } };
  const onClick = (e) => {
    // Clicking another sb-word is handled by the sidebar delegation — just clean up listeners
    if (e.target.closest('.sb-word')) { cleanup(); return; }
    if (!e.target.closest('#jp-hover-tip')) { _hoverHide(); cleanup(); }
  };
  const cleanup = () => {
    document.removeEventListener('click',   onClick, true);
    document.removeEventListener('keydown', onKey,   true);
    _sbOutsideActive = false;
  };

  // Defer so this click event doesn't immediately close the tooltip
  setTimeout(() => {
    document.addEventListener('click',   onClick, true);
    document.addEventListener('keydown', onKey,   true);
  }, 0);
}

// Position tooltip to the left of the sidebar panel
function _sbPosition(anchorEl) {
  const tipW = _hoverTip.offsetWidth  || 270;
  const tipH = _hoverTip.offsetHeight || 150;
  const rect = anchorEl.getBoundingClientRect();
  const x    = Math.max(8, rect.left - tipW - 8);
  let   y    = rect.top;
  if (y + tipH > window.innerHeight - 8) y = window.innerHeight - tipH - 8;
  if (y < 8) y = 8;
  _hoverTip.style.left = x + 'px';
  _hoverTip.style.top  = y + 'px';
}

// Live theme switching
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'light_theme' in changes) {
    _hoverIsLight = !!changes.light_theme.newValue;
    if (_hoverTip) _hoverTip.classList.toggle('jht-light', _hoverIsLight);
  }
});
