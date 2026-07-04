// ── Data ────────────────────────────────────────────────────
const JLPT_ORDER = ['N5', 'N4', 'N3', 'N2', 'N1'];
const JLPT_COLORS = { N5: '#ef9a9a', N4: '#ffb74d', N3: '#f9a825', N2: '#4fc3f7', N1: '#81c784' };

let jlptLookup = {};       // word/reading → JLPT level (22k keys, kana+kanji+readings)
let jlptBunproOnly = {};   // original Bunpro words → level (for accurate total counts)
let jlptTotalByLevel = {};
let mmVocab = [];
let mmExtraVocab = [];

async function loadData() {
  // Load comprehensive JLPT lookup (Bunpro + readings + kanji variants, 22k keys)
  try {
    var resp = await fetch('data/jlpt_vocab_lookup.json');
    jlptLookup = await resp.json();
  } catch (e) { console.error('Failed to load JLPT lookup:', e); }

  // Use Bunpro counts for accurate per-level totals
  try {
    var resp2 = await fetch('data/jlpt_vocab.json');
    jlptBunproOnly = await resp2.json();
    for (var w in jlptBunproOnly) {
      var lv = 'N' + jlptBunproOnly[w];
      jlptTotalByLevel[lv] = (jlptTotalByLevel[lv] || 0) + 1;
    }
  } catch (e) { console.error('Failed to load Bunpro list:', e); }

  try {
    var stored = await chrome.storage.local.get(['mm_vocab', 'mm_extra_vocab']);
    mmVocab = stored.mm_vocab || [];
    mmExtraVocab = stored.mm_extra_vocab || [];
  } catch (e) { console.error('Failed to load vocab:', e); }

  buildPage();
}

function wordJlpt(word) {
  var l = jlptLookup[word];
  return l ? 'N' + l : null;
}

// ── SRS class ───────────────────────────────────────────────
function getSrsClass(item) {
  if (typeof item !== 'object') return 'lv-9';
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
    return;
  }

  // ── Summary ──
  var known = 0, learning = 0, total = allVocab.length;
  for (var i = 0; i < allVocab.length; i++) {
    var st = (typeof allVocab[i] === 'object') ? parseInt(allVocab[i].status, 10) : null;
    if (st === 2) known++;
    else if (st === 0) learning++;
  }

  document.getElementById('summary-row').innerHTML =
    '<div class="summary-card total"><div class="val">' + total.toLocaleString() + '</div><div class="lbl">Total Vocab</div></div>' +
    '<div class="summary-card known"><div class="val">' + known.toLocaleString() + '</div><div class="lbl">Known</div></div>' +
    '<div class="summary-card learn"><div class="val">' + learning.toLocaleString() + '</div><div class="lbl">Learning</div></div>';

  // ── Group user vocab by JLPT level ──
  var groups = {};
  JLPT_ORDER.forEach(function(l) { groups[l] = []; });
  var uncategorized = [];
  var classified = 0;

  for (var i = 0; i < allVocab.length; i++) {
    var word = typeof allVocab[i] === 'string' ? allVocab[i] : allVocab[i].item;
    var jlpt = wordJlpt(word);
    if (jlpt && groups[jlpt]) {
      groups[jlpt].push(allVocab[i]);
      classified++;
    } else {
      uncategorized.push(allVocab[i]);
    }
  }

  document.getElementById('result-subtitle').textContent =
    total + ' words, ' + classified + ' classified across ' + JLPT_ORDER.length + ' JLPT levels';

  // ── Progress rings ──
  var allBunpro = 0, allUser = 0;
  for (var li = 0; li < JLPT_ORDER.length; li++) {
    allBunpro += (jlptTotalByLevel[JLPT_ORDER[li]] || 0);
    allUser += (groups[JLPT_ORDER[li]] || []).length;
  }

  function ringSvg(pct, color, size) {
    var r = size === 'big' ? 40 : 30;
    var sw = size === 'big' ? 6 : 5;
    var circ = 2 * Math.PI * r;
    var dash = pct > 0 ? (pct / 100 * circ).toFixed(1) : 0;
    return '<svg viewBox="0 0 '+(r*2+sw*2)+' '+(r*2+sw*2)+'">'+
      '<circle cx="'+(r+sw)+'" cy="'+(r+sw)+'" r="'+r+'" fill="none" stroke="var(--border)" stroke-width="'+sw+'"/>'+
      '<circle cx="'+(r+sw)+'" cy="'+(r+sw)+'" r="'+r+'" fill="none" stroke="'+color+
        '" stroke-width="'+sw+'" stroke-linecap="round" stroke-dasharray="'+dash+' '+circ+'" style="transition:stroke-dasharray .5s"/>'+
    '</svg>';
  }

  function ringHtml(level, color, userCt, totalCt, big) {
    var pct = totalCt ? Math.min(100, (userCt/totalCt*100).toFixed(0)) : 0;
    var cls = big ? ' ring-big' : '';
    return '<div class="ring-item">'+
      '<div class="ring-svg-wrap'+cls+'">'+ringSvg(pct, color, big?'big':'')+
      '<div class="ring-inner"><span class="ring-pct">'+pct+'%</span></div></div>'+
      '<span class="ring-lbl">'+level+'</span>'+
      '<span class="ring-sub">'+userCt+'/'+totalCt+'</span>'+
    '</div>';
  }

  var ringsHtml = ringHtml('All', '#72CE9D', allUser, allBunpro, true);
  for (var li = 0; li < JLPT_ORDER.length; li++) {
    var lv = JLPT_ORDER[li];
    var colors = { N5:'#ED7989', N4:'#FDC281', N3:'#72CE9D', N2:'#66AAE8', N1:'#7E69F0' };
    ringsHtml += ringHtml(lv, colors[lv], (groups[lv]||[]).length, jlptTotalByLevel[lv]||0, false);
  }
  document.getElementById('rings-row').innerHTML = ringsHtml;

  // ── Per-level bars ──
  var html = '';
  for (var li = 0; li < JLPT_ORDER.length; li++) {
    var level = JLPT_ORDER[li];
    var userWords = groups[level] || [];
    var levelTotal = jlptTotalByLevel[level] || 1;
    var userCount = userWords.length;
    var denom = Math.max(levelTotal, userCount);
    var pct = Math.min(100, (userCount / denom * 100).toFixed(0));

    var tiers = { 'lv-1-4':0, 'lv-5-6':0, 'lv-7':0, 'lv-8':0, 'lv-9':0 };
    for (var j = 0; j < userWords.length; j++) {
      tiers[getSrsClass(userWords[j])]++;
    }
    var learnedTotal = tiers['lv-1-4']+tiers['lv-5-6']+tiers['lv-7']+tiers['lv-8']+tiers['lv-9'];
    var notLearned = Math.max(0, denom - learnedTotal);

    function p(v) { return (v/denom*100).toFixed(1); }
    var barHtml = '<div class="bar">';
    if (tiers['lv-1-4']) barHtml += '<span class="bar-seg lv1-4" style="width:'+p(tiers['lv-1-4'])+'%"></span>';
    if (tiers['lv-5-6']) barHtml += '<span class="bar-seg lv5-6" style="width:'+p(tiers['lv-5-6'])+'%"></span>';
    if (tiers['lv-7'])   barHtml += '<span class="bar-seg lv7"   style="width:'+p(tiers['lv-7'])+'%"></span>';
    if (tiers['lv-8'])   barHtml += '<span class="bar-seg lv8"   style="width:'+p(tiers['lv-8'])+'%"></span>';
    if (tiers['lv-9'])   barHtml += '<span class="bar-seg lv9"   style="width:'+p(tiers['lv-9'])+'%"></span>';
    if (notLearned > 0)  barHtml += '<span class="bar-seg unkn"  style="width:'+p(notLearned)+'%"></span>';
    barHtml += '</div>';

    var tipHtml = '<span class="bar-tip">'+
      '<b>Level ' + level + ':</b> ' + userCount + ' / ' + denom + ' words (' + pct + '%)<br>'+
      (tiers['lv-1-4']?'<b style=color:#ED7989>●</b> Lv1-4: '+tiers['lv-1-4']+'<br>':'')+
      (tiers['lv-5-6']?'<b style=color:#FDC281>●</b> Lv5-6: '+tiers['lv-5-6']+'<br>':'')+
      (tiers['lv-7']?'<b style=color:#72CE9D>●</b> Lv7: '+tiers['lv-7']+'<br>':'')+
      (tiers['lv-8']?'<b style=color:#66AAE8>●</b> Lv8: '+tiers['lv-8']+'<br>':'')+
      (tiers['lv-9']?'<b style=color:#7E69F0>●</b> Lv9: '+tiers['lv-9']+'<br>':'')+
      (notLearned>0?'<b style=color:var(--dim)>●</b> Not learned: '+notLearned:'')+
    '</span>';

    html += '<div class="level-section">'+
      '<div class="level-header">'+
        '<h2>' + level + ' Level</h2>'+
        '<span class="count">' + userCount + ' / ' + denom + ' words</span>'+
        '<span class="pct">' + pct + '% learned</span>'+
      '</div>'+
      '<div class="bar-wrap">'+tipHtml+barHtml+'</div>'+
    '</div>';
  }

  // Uncategorized
  if (uncategorized.length) {
    html += '<div class="level-section">'+
      '<div class="level-header">'+
        '<h2>Uncategorized</h2>'+
        '<span class="count">' + uncategorized.length + ' words</span>'+
        '<span class="pct">' + (uncategorized.length/total*100).toFixed(0) + '% of your vocab</span>'+
      '</div>'+
    '</div>';
  }

  document.getElementById('main-content').innerHTML = html || '<div class="empty-state"><p>No vocab could be categorized.</p></div>';
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
