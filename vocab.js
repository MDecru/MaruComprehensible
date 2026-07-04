// ── Data ────────────────────────────────────────────────────
const JLPT_ORDER = ['N5', 'N4', 'N3', 'N2', 'N1'];
const JLPT_COLORS = { N5: '#ef9a9a', N4: '#ffb74d', N3: '#f9a825', N2: '#4fc3f7', N1: '#81c784' };
const JLPT_BG = { N5: 'rgba(239,154,154,.22)', N4: 'rgba(255,183,77,.22)', N3: 'rgba(249,168,37,.22)', N2: 'rgba(79,195,247,.22)', N1: 'rgba(129,199,132,.22)' };

let jlptVocab = {};    // word → JLPT level number (1-5)
let mmVocab = [];      // array of {item, level, status}
let mmExtraVocab = [];

async function loadData() {
  // Load Bunpro JLPT vocab mapping (7,407 words from official JLPT lists)
  try {
    var resp = await fetch('data/jlpt_vocab.json');
    jlptVocab = await resp.json();
  } catch (e) { console.error('Failed to load JLPT vocab:', e); }

  // Load MM vocab from storage
  try {
    var stored = await chrome.storage.local.get(['mm_vocab', 'mm_extra_vocab']);
    mmVocab = stored.mm_vocab || [];
    mmExtraVocab = stored.mm_extra_vocab || [];
  } catch (e) { console.error('Failed to load vocab:', e); }

  buildPage();
}

function wordJlpt(word) {
  var l = jlptVocab[word];
  return l ? 'N' + l : null;
}

// ── SRS class ───────────────────────────────────────────────
function getSrsClass(item) {
  if (typeof item !== 'object') return 'lv-9'; // old string format = known
  var lvl = parseInt(item.level, 10);
  var st  = parseInt(item.status, 10);
  if (st === 2 || lvl === 1 || lvl === 9001 || lvl >= 9) return 'lv-9';
  if (lvl === 8) return 'lv-8';
  if (lvl === 7) return 'lv-7';
  if (lvl >= 5 && lvl <= 6) return 'lv-5-6';
  if (!isNaN(lvl) && lvl >= 1) return 'lv-1-4';
  return 'unkn';
}

// ── Build page ──────────────────────────────────────────────
function buildPage() {
  var allVocab = mmVocab.concat(mmExtraVocab);
  if (!allVocab.length) {
    document.getElementById('main-content').innerHTML =
      '<div class="empty-state"><p>No vocab data.<br>Connect MaruMori in the extension popup first.</p></div>';
    document.getElementById('result-subtitle').textContent = '';
    return;
  }

  // ── Summary ──
  var known = 0, learning = 0, total = allVocab.length;
  for (var i = 0; i < allVocab.length; i++) {
    var st = (typeof allVocab[i] === 'object') ? parseInt(allVocab[i].status, 10) : null;
    if (st === 2) known++;
    else if (st === 0) learning++;
  }
  var other = total - known - learning;

  document.getElementById('summary-row').innerHTML =
    '<div class="summary-card total"><div class="val">' + total.toLocaleString() + '</div><div class="lbl">Total Vocab</div></div>' +
    '<div class="summary-card known"><div class="val">' + known.toLocaleString() + '</div><div class="lbl">Known</div></div>' +
    '<div class="summary-card learn"><div class="val">' + learning.toLocaleString() + '</div><div class="lbl">Learning</div></div>';

  // ── Group by JLPT level ──
  var groups = {}; // 'N5' → [{item,level,status}, ...]
  var uncategorized = [];
  JLPT_ORDER.forEach(function(l) { groups[l] = []; });

  for (var i = 0; i < allVocab.length; i++) {
    var word = typeof allVocab[i] === 'string' ? allVocab[i] : allVocab[i].item;
    var jlpt = wordJlpt(word);
    if (jlpt && groups[jlpt]) {
      groups[jlpt].push(allVocab[i]);
    } else {
      uncategorized.push(allVocab[i]);
    }
  }

  // Count SRS tiers per group
  function countSrs(items) {
    var c = { 'lv-1-4':0, 'lv-5-6':0, 'lv-7':0, 'lv-8':0, 'lv-9':0, unkn:0 };
    for (var i = 0; i < items.length; i++) {
      c[getSrsClass(items[i])]++;
    }
    return c;
  }

  function buildBar(c) {
    var t = c['lv-1-4']+c['lv-5-6']+c['lv-7']+c['lv-8']+c['lv-9']+c.unkn;
    if (!t) return '';
    var h = '';
    if (c['lv-1-4']) h += '<span class="bar-seg lv1-4" style="width:'+(c['lv-1-4']/t*100).toFixed(1)+'%"></span>';
    if (c['lv-5-6']) h += '<span class="bar-seg lv5-6" style="width:'+(c['lv-5-6']/t*100).toFixed(1)+'%"></span>';
    if (c['lv-7'])   h += '<span class="bar-seg lv7"   style="width:'+(c['lv-7']  /t*100).toFixed(1)+'%"></span>';
    if (c['lv-8'])   h += '<span class="bar-seg lv8"   style="width:'+(c['lv-8']  /t*100).toFixed(1)+'%"></span>';
    if (c['lv-9'])   h += '<span class="bar-seg lv9"   style="width:'+(c['lv-9']  /t*100).toFixed(1)+'%"></span>';
    if (c.unkn)      h += '<span class="bar-seg unkn"  style="width:'+(c.unkn   /t*100).toFixed(1)+'%"></span>';
    var tip = '<span class="bar-tip">'+
      (c['lv-1-4']?'<b style=color:#ED7989>●</b> Lv1-4: '+c['lv-1-4']+'<br>':'')+
      (c['lv-5-6']?'<b style=color:#FDC281>●</b> Lv5-6: '+c['lv-5-6']+'<br>':'')+
      (c['lv-7']?'<b style=color:#72CE9D>●</b> Lv7: '+c['lv-7']+'<br>':'')+
      (c['lv-8']?'<b style=color:#66AAE8>●</b> Lv8: '+c['lv-8']+'<br>':'')+
      (c['lv-9']?'<b style=color:#7E69F0>●</b> Lv9: '+c['lv-9']+'<br>':'')+
      (c.unkn?'<b style=color:var(--dim)>●</b> Unknown: '+c.unkn:'')+
    '</span>';
    return '<div class="bar-wrap">'+tip+'<div class="bar">'+h+'</div></div>';
  }

  // ── Render ──
  var html = '';
  var allLevels = JLPT_ORDER.slice();
  if (uncategorized.length) allLevels.push('uncategorized');

  for (var li = 0; li < allLevels.length; li++) {
    var level = allLevels[li];
    var items = level === 'uncategorized' ? uncategorized : groups[level];
    if (!items.length) continue;

    var c = countSrs(items);
    var pct = total ? (items.length/total*100).toFixed(0) : 0;

    html += '<div class="level-section">'+
      '<div class="level-header">'+
        '<h2>' + (level === 'uncategorized' ? 'Uncategorized (kana-only)' : level + ' Level') + '</h2>'+
        '<span class="count">' + items.length + ' words</span>'+
        '<span class="pct">' + pct + '% of total</span>'+
      '</div>'+
      buildBar(c) +
    '</div>';
  }

  document.getElementById('main-content').innerHTML = html || '<div class="empty-state"><p>No vocab could be categorized.</p></div>';
  document.getElementById('result-subtitle').textContent = total + ' words across ' + allLevels.length + ' levels';
}

// ── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  chrome.storage.local.get(['light_theme'], function(items) {
    document.body.classList.toggle('light-theme', !!items.light_theme);
  });
  chrome.storage.onChanged.addListener(function(changes, area) {
    if (area === 'local' && changes.light_theme) {
      document.body.classList.toggle('light-theme', !!changes.light_theme.newValue);
    }
  });
  loadData();
});
