// Shared scoring logic — loaded before each site-specific content script

const KUROMOJI_DICT_URL = chrome.runtime.getURL('dict');
const DICT_FILES = [
  'base.dat.gz', 'check.dat.gz', 'cc.dat.gz',
  'tid.dat.gz', 'tid_map.dat.gz', 'tid_pos.dat.gz',
  'unk.dat.gz', 'unk_char.dat.gz', 'unk_compat.dat.gz', 'unk_invoke.dat.gz', 'unk_map.dat.gz', 'unk_pos.dat.gz',
];
const MM_CONTENT_POS = new Set(['名詞','動詞','形容詞','形容動詞','副詞','連体詞','感動詞']);
const NUMERAL_RE = /^[0-9０-９]+$/;

let _tokenizer = null;
let _tokenizerPromise = null;

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

function getVocab() {
  return new Promise(resolve => {
    chrome.storage.local.get(['mm_vocab', 'mm_extra_vocab', 'mm_extra_kanji'], d => {
      const set = new Set(d.mm_vocab || []);
      for (const v of (d.mm_extra_vocab || [])) set.add(v);
      for (const k of (d.mm_extra_kanji || [])) set.add(k);
      resolve(set);
    });
  });
}

function getKanji() {
  return new Promise(resolve => {
    chrome.storage.local.get(['mm_kanji', 'mm_extra_kanji'], d => {
      const set = new Set(d.mm_kanji || []);
      for (const k of (d.mm_extra_kanji || [])) set.add(k);
      resolve(set);
    });
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
  const stops = [[237,121,137],[253,194,129],[114,206,157]];
  const t = Math.max(0, Math.min(100, pct)) / 100;
  const seg = t < 0.5 ? 0 : 1;
  const lt = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const [r1,g1,b1] = stops[seg], [r2,g2,b2] = stops[seg+1];
  return `rgb(${Math.round(r1+(r2-r1)*lt)},${Math.round(g1+(g2-g1)*lt)},${Math.round(b1+(b2-b1)*lt)})`;
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
