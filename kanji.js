// ── Card size ───────────────────────────────────────────────
const SIZE_KEY = 'cij_kanji_card_size';
const SIZES = ['xs', 'sm', 'md', 'lg'];
let currentCardSize = 'sm';
try { currentCardSize = localStorage.getItem(SIZE_KEY) || 'sm'; } catch {}

function applyCardSize(size) {
  SIZES.forEach(s => document.body.classList.remove('sz-' + s));
  document.body.classList.add('sz-' + size);
  document.querySelectorAll('#size-selector .pill-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.size === size);
  });
}

function setCardSize(size) {
  currentCardSize = size;
  try { localStorage.setItem(SIZE_KEY, size); } catch {}
  applyCardSize(size);
}
applyCardSize(currentCardSize);

// ── Boldness ────────────────────────────────────────────────
const BOLD_KEY = 'cij_kanji_boldness';
const BOLDS = ['light', 'med', 'bold'];
let currentBoldness = 'med';
try { currentBoldness = localStorage.getItem(BOLD_KEY) || 'med'; } catch {}

function applyBoldness(bw) {
  BOLDS.forEach(b => document.body.classList.remove('bw-' + b));
  document.body.classList.add('bw-' + bw);
  document.querySelectorAll('#boldness-selector .pill-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.boldness === bw);
  });
}

function setBoldness(bw) {
  currentBoldness = bw;
  try { localStorage.setItem(BOLD_KEY, bw); } catch {}
  applyBoldness(bw);
}
applyBoldness(currentBoldness);

// ── Invert ──────────────────────────────────────────────────
const INVERT_KEY = 'cij_kanji_invert';
let inverted = false;
try { inverted = localStorage.getItem(INVERT_KEY) === 'true'; } catch {}
applyInvert(inverted);

function applyInvert(on) {
  document.body.classList.toggle('invert', on);
  var btn = document.getElementById('invert-btn');
  if (btn) {
    btn.style.background = on ? 'var(--accent)' : 'var(--surface)';
    btn.style.color = on ? '#fff' : 'var(--dim)';
  }
}

function toggleInvert() {
  inverted = !inverted;
  try { localStorage.setItem(INVERT_KEY, inverted); } catch {}
  applyInvert(inverted);
}

// ── Data ────────────────────────────────────────────────────
const JLPT_ORDER = ['N5', 'N4', 'N3', 'N2', 'N1'];
const JLPT_COLORS = { N5: '#ef9a9a', N4: '#ffb74d', N3: '#f9a825', N2: '#4fc3f7', N1: '#81c784' };
const JLPT_BG = { N5: 'rgba(239,154,154,.22)', N4: 'rgba(255,183,77,.22)', N3: 'rgba(249,168,37,.22)', N2: 'rgba(79,195,247,.22)', N1: 'rgba(129,199,132,.22)' };

let jlptMap = {};
let kanjiDict = {};
let strokeMap = {};
let jlptKanji = {};
let allJlptKanji = new Set();
let mmKanjiSet = new Set();
let mmKanjiLevels = {};
let mmKanjiStatus = {};
let mmExtraKanjiSet = new Set();

async function loadData() {
  try {
    const resp = await fetch('data/jlpt_mapping.json');
    const jlptData = await resp.json();
    for (const [lvl, kanjis] of Object.entries(jlptData)) {
      const levelName = 'N' + lvl;
      jlptKanji[levelName] = kanjis;
      for (const k of kanjis) { jlptMap[k] = parseInt(lvl, 10); allJlptKanji.add(k); }
    }
    JLPT_ORDER.forEach(lvl => { if (!jlptKanji[lvl]) jlptKanji[lvl] = []; });
  } catch (e) { console.error('Failed to load JLPT mapping:', e); }

  try {
    const cached = sessionStorage.getItem('ext_kanji_dict_cache');
    if (cached) { kanjiDict = JSON.parse(cached); }
    else {
      const resp = await fetch('data/kanji_dict.json');
      kanjiDict = await resp.json();
      try { sessionStorage.setItem('ext_kanji_dict_cache', JSON.stringify(kanjiDict)); } catch {}
    }
  } catch (e) { console.error('Failed to load kanji dictionary:', e); }

  try {
    const resp = await fetch('data/kanji_strokes.json');
    strokeMap = await resp.json();
  } catch (e) { console.error('Failed to load stroke counts:', e); }

  try {
    const stored = await chrome.storage.local.get(['mm_kanji', 'mm_extra_kanji']);
    (stored.mm_kanji || []).forEach(k => {
      const ch = typeof k === 'string' ? k : k.item;
      if (ch && ch.length === 1) {
        mmKanjiSet.add(ch);
        if (typeof k === 'object') {
          var lv = parseInt(k.level, 10);
          var st = parseInt(k.status, 10);
          if (!isNaN(lv)) mmKanjiLevels[ch] = lv;
          if (!isNaN(st)) mmKanjiStatus[ch] = st;
        }
      }
    });
    (stored.mm_extra_kanji || []).forEach(k => {
      const ch = typeof k === 'string' ? k : k.item;
      if (ch && ch.length === 1) {
        mmExtraKanjiSet.add(ch);
        if (typeof k === 'object') {
          var lv = parseInt(k.level, 10);
          var st = parseInt(k.status, 10);
          if (!isNaN(lv)) mmKanjiLevels[ch] = lv;
          if (!isNaN(st)) mmKanjiStatus[ch] = st;
        }
      }
    });
  } catch (e) { console.error('Failed to load MM data:', e); }

  buildPage();
}

// ── MM level class ──────────────────────────────────────────
function getMmClass(kanji) {
  var inMM = mmKanjiSet.has(kanji) || mmExtraKanjiSet.has(kanji);
  if (!inMM) return 'unknown';
  var lvl = mmKanjiLevels[kanji];
  var status = mmKanjiStatus[kanji];
  // Use loose equality — API may return numbers or strings
  // Level 1 in MaruMori = demonstrated knowledge → treated as mastered
  if (status == 2 || lvl == 1) return 'lv-9';
  if (lvl == 9001) return 'lv-9';     // legacy manual known
  if (lvl >= 9) return 'lv-9';        // SRS mastered
  if (lvl == 8) return 'lv-8';
  if (lvl == 7) return 'lv-7';
  if (lvl >= 5 && lvl <= 6) return 'lv-5-6';
  if (lvl >= 2 && lvl <= 4) return 'lv-1-4';
  return 'lv-9'; // in MM set but missing level → treat as known
}

function getMmLvl(kanji) { return mmKanjiLevels[kanji] || null; }
function jlptLevelOf(kanji) { var l = jlptMap[kanji]; return l ? 'N'+l : null; }

// ── Build page ──────────────────────────────────────────────
var currentView = 'level';
var matrixSort = 'mm';  // 'mm' | 'strokes' | 'jlpt'

function switchView(view) {
  currentView = view;
  document.body.classList.toggle('view-matrix', view === 'matrix');
  document.getElementById('view-by-level').classList.toggle('active', view === 'level');
  document.getElementById('view-matrix').classList.toggle('active', view === 'matrix');
  document.getElementById('matrix-sorts').style.display = view === 'matrix' ? 'inline-flex' : 'none';
  buildPage();
}

function setMatrixSort(sort) {
  matrixSort = sort;
  document.querySelectorAll('#matrix-sorts .view-toggle').forEach(function(b) {
    b.classList.toggle('active', b.dataset.msort === sort);
  });
  buildPage();
}

function countMm(kArray) {
  var lv1_4=0, lv5_6=0, lv7=0, lv8=0, lv9=0;
  for (var i=0; i<kArray.length; i++) {
    var c = getMmClass(kArray[i]);
    if (c==='lv-1-4') lv1_4++; else if (c==='lv-5-6') lv5_6++; else if (c==='lv-7') lv7++; else if (c==='lv-8') lv8++; else if (c==='lv-9') lv9++;
  }
  return {lv1_4, lv5_6, lv7, lv8, lv9, unkn: kArray.length-lv1_4-lv5_6-lv7-lv8-lv9};
}

function buildBar(c) {
  var t = c.lv1_4+c.lv5_6+c.lv7+c.lv8+c.lv9+c.unkn;
  if (!t) return '';
  var h = '';
  if (c.lv1_4) h += '<span class="mm-bar-seg lv1-4" style="width:'+(c.lv1_4/t*100).toFixed(1)+'%"></span>';
  if (c.lv5_6) h += '<span class="mm-bar-seg lv5-6" style="width:'+(c.lv5_6/t*100).toFixed(1)+'%"></span>';
  if (c.lv7)   h += '<span class="mm-bar-seg lv7"   style="width:'+(c.lv7  /t*100).toFixed(1)+'%"></span>';
  if (c.lv8+c.lv9) h += '<span class="mm-bar-seg lv8-9" style="width:'+((c.lv8+c.lv9)/t*100).toFixed(1)+'%"></span>';
  if (c.unkn)  h += '<span class="mm-bar-seg unkn"  style="width:'+(c.unkn /t*100).toFixed(1)+'%"></span>';
  var tip = '<span class="mm-bar-tip">'+
    (c.lv1_4?'<b style=color:#ED7989>●</b> Lv1-4: '+c.lv1_4+'<br>':'')+
    (c.lv5_6?'<b style=color:#FDC281>●</b> Lv5-6: '+c.lv5_6+'<br>':'')+
    (c.lv7?'<b style=color:#72CE9D>●</b> Lv7: '+c.lv7+'<br>':'')+
    (c.lv8?'<b style=color:#66AAE8>●</b> Lv8: '+c.lv8+'<br>':'')+
    (c.lv9?'<b style=color:#7E69F0>●</b> Lv9: '+c.lv9+'<br>':'')+
    (c.unkn?'<b style=color:var(--dim)>●</b> Unknown: '+c.unkn:'')+
  '</span>';
  return '<span class="mm-bar-wrap">'+tip+'<span class="mm-bar">'+h+'</span></span>';
}

function buildPage() {
  var main = document.getElementById('main-content');
  if (!main) return;

  var uncategorized = [], seen = new Set();
  mmKanjiSet.forEach(function(k) { if (!allJlptKanji.has(k) && !seen.has(k)) { seen.add(k); uncategorized.push(k); } });
  mmExtraKanjiSet.forEach(function(k) { if (!allJlptKanji.has(k) && !seen.has(k)) { seen.add(k); uncategorized.push(k); } });

  var hasMM = mmKanjiSet.size > 0 || mmExtraKanjiSet.size > 0;

  if (currentView === 'matrix') {
    var allKanjis = [];
    JLPT_ORDER.forEach(function(lvl) { (jlptKanji[lvl]||[]).forEach(function(k){ allKanjis.push(k); }); });
    uncategorized.forEach(function(k){ allKanjis.push(k); });

    // Sort
    var mmRank = { 'lv-9':0, 'lv-8':1, 'lv-7':2, 'lv-5-6':3, 'lv-1-4':4, 'unknown':5 };
    if (matrixSort === 'strokes') {
      allKanjis.sort(function(a, b) { return (strokeMap[a]||99) - (strokeMap[b]||99); });
    } else if (matrixSort === 'jlpt') {
      var jlptRank = { 'N5':0, 'N4':1, 'N3':2, 'N2':3, 'N1':4 };
      allKanjis.sort(function(a, b) {
        var ja = jlptRank[jlptLevelOf(a)]; if (ja === undefined) ja = 9;
        var jb = jlptRank[jlptLevelOf(b)]; if (jb === undefined) jb = 9;
        return ja - jb;
      });
    } else if (matrixSort === 'id') {
      allKanjis.sort(function(a, b) { return a.localeCompare(b, 'ja'); });
    } else {
      allKanjis.sort(function(a, b) {
        var ra = mmRank[getMmClass(a)]; if (ra === undefined) ra = 9;
        var rb = mmRank[getMmClass(b)]; if (rb === undefined) rb = 9;
        return ra - rb;
      });
    }

    var c = countMm(allKanjis);
    var barHtml = hasMM ? '<span class="mm-summary">'+buildBar(c)+'</span>' : '';
    var sortLabels = { mm:'by MM level', strokes:'by stroke count', jlpt:'by JLPT', id:'by ID' };
    var sortLabel = ' · ' + (sortLabels[matrixSort] || '');
    main.innerHTML = '<div class="level-section">'+
      '<div class="level-header"><h2>All Kanji</h2><span class="count">'+allKanjis.length+' kanji'+sortLabel+'</span>'+barHtml+'</div>'+
      '<div class="kanji-grid">'+buildKanjiCards(allKanjis)+'</div></div>';
    updateSearchCount(); attachCardEvents(); return;
  }

  var html = '';
  var allLevels = JLPT_ORDER.slice();
  if (uncategorized.length > 0) allLevels.push('uncategorized');

  for (var li = 0; li < allLevels.length; li++) {
    var level = allLevels[li];
    var kanjis = level === 'uncategorized' ? uncategorized : (jlptKanji[level] || []);
    if (!kanjis.length) continue;
    var c = countMm(kanjis);
    var barHtml = hasMM ? '<span class="mm-summary">'+buildBar(c)+'</span>' : '';
    var sectionId = level === 'uncategorized' ? 'uncategorized' : level;
    html += '<div class="level-section" id="sec-'+sectionId+'">'+
      '<div class="level-header"><h2>'+(level==='uncategorized'?'Uncategorized':level)+'</h2><span class="count">'+kanjis.length+' kanji</span>'+barHtml+'</div>'+
      '<div class="kanji-grid">'+buildKanjiCards(kanjis)+'</div></div>';
  }

  main.innerHTML = html || '<div class="empty-state"><p>No kanji data loaded.<br>Try connecting MaruMori first, or check that dictionary files are available.</p></div>';
  updateSearchCount(); attachCardEvents();
}

function buildKanjiCards(kanjis) {
  var out = '';
  for (var i = 0; i < kanjis.length; i++) {
    var k = kanjis[i], mmClass = getMmClass(k);
    out += '<div class="kanji-card mm-'+mmClass+'" data-kanji="'+escAttr(k)+'">'+k+'</div>';
  }
  return out;
}

// ── Event delegation for kanji cards ────────────────────────
var pinnedCard = null;

function attachCardEvents() {
  document.querySelectorAll('.kanji-card').forEach(function(card) {
    card.addEventListener('click', function(e) {
      e.stopPropagation();
      if (pinnedCard === card) {
        pinnedCard = null;
        tooltip.classList.remove('pinned');
        tooltip.classList.remove('show');
        currentTooltipKanji = null;
      } else {
        if (pinnedCard) {
          // Switch to new card
          pinnedCard = null;
          tooltip.classList.remove('pinned');
        }
        pinnedCard = card;
        tooltip.classList.add('pinned');
        showTooltip(e, card);
      }
    });
  });
  document.addEventListener('click', function(e) {
    if (pinnedCard && !e.target.closest('.kanji-card') && !e.target.closest('#kanji-tooltip')) {
      pinnedCard = null;
      tooltip.classList.remove('pinned');
      tooltip.classList.remove('show');
      currentTooltipKanji = null;
    }
  });
}

// ── Search ──────────────────────────────────────────────────
function onSearch() {
  var q = (document.getElementById('search').value || '').trim().toLowerCase();
  document.querySelectorAll('.kanji-card').forEach(function(card) {
    var k = card.dataset.kanji || '';
    var entry = kanjiDict[k];
    var reading = entry ? entry[0] : '', meaning = entry ? entry[1] : '';
    var searchText = (k+' '+reading+' '+meaning+' '+(jlptMap[k]?'N'+jlptMap[k]:'')).toLowerCase();
    card.style.display = (!q || searchText.indexOf(q)!==-1) ? '' : 'none';
  });
  updateSearchCount();
}

function updateSearchCount() {
  var el = document.getElementById('result-count');
  if (!el) return;
  var q = (document.getElementById('search').value || '').trim();
  var total = document.querySelectorAll('.kanji-card').length;
  var visible = document.querySelectorAll('.kanji-card[style*="display: none"]').length;
  el.textContent = q ? (total-visible)+' / '+total : total+' kanji';
}

// ── Navigation (by-level mode only) ─────────────────────────
function scrollToLevel(level) {
  var section = document.getElementById('sec-'+level);
  if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelectorAll('.jlpt-nav-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.level === level);
  });
}

// ── Tooltip ─────────────────────────────────────────────────
var tooltip = document.getElementById('kanji-tooltip');
var currentTooltipKanji = null;

function showTooltip(event, card) {
  var kanji = card.dataset.kanji;
  currentTooltipKanji = kanji;

  var entry = kanjiDict[kanji];
  var jlptLvl = jlptMap[kanji];
  var mmClass = getMmClass(kanji);
  var mmLvl = getMmLvl(kanji);

  var badgesHtml = '';
  if (jlptLvl) badgesHtml += '<span class="kt-badge" style="background:'+JLPT_BG['N'+jlptLvl]+';color:'+JLPT_COLORS['N'+jlptLvl]+'">N'+jlptLvl+'</span>';
  if (mmKanjiSet.size > 0 || mmExtraKanjiSet.size > 0) {
    var mmLabel = mmClass !== 'unknown' ? (mmLvl ? 'MM Lv '+mmLvl : 'MM ✓') : 'MM ?';
    badgesHtml += '<span class="kt-badge mm-'+mmClass+'">'+mmLabel+'</span>';
  }

  var bodyHtml = '';
  if (entry) {
    var glosses = entry[1].split(';').map(function(s){ return s.trim(); }).filter(Boolean);
    var glossItems = glosses.map(function(g){ return '<li>'+escHtml(g)+'</li>'; }).join('');
    bodyHtml = '<div class="kt-body"><div class="kt-reading">'+escHtml(entry[0])+'</div><ul class="kt-gloss">'+glossItems+'</ul></div>';
  }

  tooltip.innerHTML = '<div class="kt-head"><span class="kt-char">'+kanji+'</span><div class="kt-badges">'+badgesHtml+'</div></div>'+bodyHtml+
    '<div class="kt-footer">'+
      (entry ? '' : '<div class="kt-no-entry">No dictionary entry</div>')+
      '<div class="kt-links">'+
        '<a class="kt-link kt-jisho" href="https://jisho.org/search/'+encodeURIComponent(kanji)+'%20%23kanji" target="_blank">Jisho ↗</a>'+
        '<a class="kt-link kt-marumori" href="https://marumori.io/dictionary/search?q='+encodeURIComponent(kanji)+'&t=kanji" target="_blank">MaruMori ↗</a>'+
      '</div></div>';

  tooltip.classList.add('show');
  positionTooltip(event);
}

function hideTooltip() {
  if (pinnedCard) return;
  tooltip.classList.remove('show');
  currentTooltipKanji = null;
}

function positionTooltip(event) {
  var tw = tooltip.offsetWidth || 260, th = tooltip.offsetHeight || 100;
  var x = event.clientX + 14, y = event.clientY - 10;
  if (x + tw > window.innerWidth - 12) x = event.clientX - tw - 14;
  if (x < 8) x = 8;
  if (y + th > window.innerHeight - 12) y = event.clientY - th - 10;
  if (y < 8) y = 8;
  tooltip.style.left = x+'px'; tooltip.style.top = y+'px';
}

// ── Utilities ───────────────────────────────────────────────
function escHtml(s) { if (!s) return ''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s) { if (!s) return ''; return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  chrome.storage.local.get(['light_theme'], function(items) {
    document.body.classList.toggle('light-theme', !!items.light_theme);
  });
  chrome.storage.onChanged.addListener(function(changes, area) {
    if (area === 'local' && changes.light_theme) document.body.classList.toggle('light-theme', !!changes.light_theme.newValue);
  });

  var searchEl = document.getElementById('search');
  if (searchEl) searchEl.addEventListener('input', onSearch);

  document.querySelectorAll('.jlpt-nav-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { scrollToLevel(btn.dataset.level); });
  });

  document.querySelectorAll('#size-selector .pill-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { setCardSize(btn.dataset.size); });
  });

  document.querySelectorAll('#boldness-selector .pill-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { setBoldness(btn.dataset.boldness); });
  });

  var invertBtn = document.getElementById('invert-btn');
  if (invertBtn) invertBtn.addEventListener('click', toggleInvert);

  document.getElementById('view-by-level').addEventListener('click', function() { switchView('level'); });
  document.getElementById('view-matrix').addEventListener('click', function() { switchView('matrix'); });

  document.querySelectorAll('#matrix-sorts .view-toggle').forEach(function(btn) {
    btn.addEventListener('click', function() { setMatrixSort(btn.dataset.msort); });
  });

  loadData();
});
