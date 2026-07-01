// History page — watched videos + unknown word frequency

let _videos = {};
let _words  = {};
let _videoFilter = '';
let _wordFilter  = '';
let _wordSort    = 'count';

const $ = id => document.getElementById(id);

async function _load() {
  const data = await chrome.storage.local.get(['mc_video_history', 'mc_word_history']);
  _videos = data.mc_video_history || {};
  _words  = data.mc_word_history  || {};
  _renderStats();
  _renderVideos();
  _renderWords();
}

function _renderStats() {
  const v = Object.keys(_videos).length;
  const w = Object.keys(_words).length;
  $('stats-label').textContent = [
    v ? `${v} video${v === 1 ? '' : 's'}` : '',
    w ? `${w} unknown word${w === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');
}

function _renderVideos() {
  const q = _videoFilter.trim().toLowerCase();
  let entries = Object.entries(_videos).sort((a, b) => (b[1].lastWatched || 0) - (a[1].lastWatched || 0));
  if (q) entries = entries.filter(([, v]) => (v.title || '').toLowerCase().includes(q));

  $('clear-videos-btn').disabled = !Object.keys(_videos).length;
  const con = $('video-list-container');

  if (!Object.keys(_videos).length) {
    con.innerHTML = `<div class="empty"><strong>No videos yet</strong>Watch a Japanese video with subtitles — the score will be saved here automatically.</div>`;
    return;
  }
  if (!entries.length) {
    con.innerHTML = `<div class="no-match">No videos match "<strong>${_esc(q)}</strong>"</div>`;
    return;
  }

  con.innerHTML = `<div class="video-list">${entries.map(([key, v]) => {
    const score = v.lastScore?.score;
    const scoreColor = score != null ? _compColor(score) : '#6a7480';
    const siteClass = `site-${v.site || 'yt'}`;
    const siteLabel = v.site === 'cij' ? 'CIJ' : v.site === 'player' ? 'Local' : 'YouTube';
    const date = v.lastWatched ? _fmtDate(v.lastWatched) : '';
    return `<div class="video-card" data-key="${_esc(key)}" data-url="${_esc(v.url || '')}">
      <span class="site-badge ${siteClass}">${siteLabel}</span>
      <div class="video-info">
        <div class="video-title">${_esc(v.title || key)}</div>
        <div class="video-meta">${date}</div>
      </div>
      ${score != null ? `<div class="score-badge" style="color:${scoreColor}">${score}%</div>` : ''}
      ${(v.watchCount || 0) > 1 ? `<div class="watch-count">×${v.watchCount}</div>` : ''}
    </div>`;
  }).join('')}</div>`;

  con.querySelectorAll('.video-card').forEach(card => {
    card.addEventListener('click', () => {
      const url = card.dataset.url;
      if (url && !url.startsWith('blob:')) chrome.tabs.create({ url });
    });
  });
}

function _renderWords() {
  const q = _wordFilter.trim().toLowerCase();
  let entries = Object.entries(_words);
  if (_wordSort === 'count') entries.sort((a, b) => b[1].count - a[1].count);
  else entries.sort((a, b) => a[0].localeCompare(b[0], 'ja'));
  if (q) entries = entries.filter(([w]) => w.includes(q) || w.toLowerCase().includes(q));

  $('clear-words-btn').disabled  = !Object.keys(_words).length;
  $('export-words-btn').disabled = !Object.keys(_words).length;
  const con = $('word-list-container');

  if (!Object.keys(_words).length) {
    con.innerHTML = `<div class="empty"><strong>No data yet</strong>Unknown words will appear here as you watch Japanese subtitled videos.</div>`;
    return;
  }
  if (!entries.length) {
    con.innerHTML = `<div class="no-match">No words match "<strong>${_esc(q)}</strong>"</div>`;
    return;
  }

  con.innerHTML = `<div class="word-list">${entries.map(([w, d]) => `
    <div class="word-row" data-word="${_esc(w)}">
      <span class="word-text">${_esc(w)}</span>
      <span class="word-count">${d.count}×</span>
      <span class="word-date">${d.lastSeen ? _fmtDate(d.lastSeen) : ''}</span>
    </div>`).join('')}</div>`;

  con.querySelectorAll('.word-row[data-word]').forEach(row => {
    row.addEventListener('mouseenter', () => _showTip(row.dataset.word, row));
    row.addEventListener('mouseleave', _hideTip);
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────────

$('tab-words-btn').addEventListener('click', () => {
  $('tab-words-btn').classList.add('active');
  $('tab-videos-btn').classList.remove('active');
  $('section-words').style.display = '';
  $('section-videos').style.display = 'none';
});
$('tab-videos-btn').addEventListener('click', () => {
  $('tab-videos-btn').classList.add('active');
  $('tab-words-btn').classList.remove('active');
  $('section-videos').style.display = '';
  $('section-words').style.display = 'none';
});

// ── Sorting ───────────────────────────────────────────────────────────────────

$('sort-count-btn').addEventListener('click', () => {
  _wordSort = 'count';
  $('sort-count-btn').classList.add('active');
  $('sort-alpha-btn').classList.remove('active');
  _renderWords();
});
$('sort-alpha-btn').addEventListener('click', () => {
  _wordSort = 'alpha';
  $('sort-alpha-btn').classList.add('active');
  $('sort-count-btn').classList.remove('active');
  _renderWords();
});

// ── Search ────────────────────────────────────────────────────────────────────

$('video-search').addEventListener('input', () => { _videoFilter = $('video-search').value; _renderVideos(); });
$('word-search').addEventListener('input', () => { _wordFilter = $('word-search').value; _renderWords(); });

// ── Actions ───────────────────────────────────────────────────────────────────

$('clear-videos-btn').addEventListener('click', async () => {
  const n = Object.keys(_videos).length;
  if (!n || !confirm(`Clear all ${n} video history entries?`)) return;
  _videos = {};
  await chrome.storage.local.set({ mc_video_history: {} });
  _renderStats(); _renderVideos();
});

$('clear-words-btn').addEventListener('click', async () => {
  const n = Object.keys(_words).length;
  if (!n || !confirm(`Clear all ${n} unknown word entries?`)) return;
  _words = {};
  await chrome.storage.local.set({ mc_word_history: {} });
  _renderStats(); _renderWords();
});

$('export-words-btn').addEventListener('click', () => {
  const entries = Object.entries(_words).sort((a, b) => b[1].count - a[1].count);
  if (!entries.length) return;
  const csv = 'word,count,last_seen\n' + entries.map(([w, d]) =>
    `"${w.replace(/"/g,'""')}",${d.count},${d.lastSeen ? new Date(d.lastSeen).toISOString().split('T')[0] : ''}`
  ).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'unknown_words.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function _compColor(score) {
  const stops = [[237,121,137],[253,194,129],[114,206,157]];
  const t = Math.max(0, Math.min(100, score)) / 100;
  const seg = t < 0.5 ? 0 : 1;
  const lt  = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const [r1,g1,b1] = stops[seg], [r2,g2,b2] = stops[seg+1];
  return `rgb(${Math.round(r1+(r2-r1)*lt)},${Math.round(g1+(g2-g1)*lt)},${Math.round(b1+(b2-b1)*lt)})`;
}

// ── Word hover tooltip ────────────────────────────────────────────────────────

const _tip = document.getElementById('wh-tip');
const _defCache = {};
let _tipHideTimer = null;

function _showTip(word, rowEl) {
  clearTimeout(_tipHideTimer);
  _tip.innerHTML = `<span style="font-size:20px;font-weight:700;color:#f2f4fa">${_esc(word)}</span><div style="color:#6a7480;font-size:11px;margin-top:4px">Loading…</div>`;
  _positionTip(rowEl);
  _tip.style.display = 'block';

  if (_defCache[word] !== undefined) { _renderTip(word, _defCache[word]); return; }

  chrome.runtime.sendMessage({ action: 'jishoLookup', word }, resp => {
    const def = (resp?.ok && (resp.reading || resp.senses?.length))
      ? { reading: resp.reading, senses: resp.senses } : null;
    _defCache[word] = def;
    if (_tip.style.display !== 'none') _renderTip(word, def);
  });
}

function _renderTip(word, def) {
  const reading = def?.reading && def.reading !== word ? def.reading : null;
  const wordHtml = reading
    ? `<ruby style="font-size:22px;font-weight:700;color:#f2f4fa">${_esc(word)}<rt>${_esc(reading)}</rt></ruby>`
    : `<span style="font-size:22px;font-weight:700;color:#f2f4fa">${_esc(word)}</span>`;

  let defsHtml = '';
  if (def?.senses?.length) {
    const items = def.senses.slice(0, 3).map(s => {
      const pos = s.pos ? `<span style="font-size:10px;color:#9E8CF8;font-weight:700;margin-right:4px">${_esc(_shortPos(s.pos))}</span>` : '';
      return `<li style="padding:3px 0;border-bottom:1px solid #272b34;list-style:none">${pos}${s.defs.slice(0, 2).map(_esc).join('; ')}</li>`;
    }).join('');
    defsHtml = `<ul style="margin-top:8px;padding:0">${items}</ul>`;
  } else if (def === null) {
    defsHtml = `<div style="color:#6a7480;font-size:11px;margin-top:6px">No definition found</div>`;
  }
  _tip.innerHTML = `<div>${wordHtml}</div>${defsHtml}`;
}

function _positionTip(rowEl) {
  const rect = rowEl.getBoundingClientRect();
  const maxW = 280;
  let x = rect.left;
  if (x + maxW > window.innerWidth - 8) x = window.innerWidth - maxW - 8;
  _tip.style.left = `${Math.max(8, x)}px`;
  _tip.style.top = `${rect.top}px`;
  requestAnimationFrame(() => {
    const th = _tip.offsetHeight;
    _tip.style.top = `${Math.max(8, rect.top - th - 8)}px`;
  });
}

function _hideTip() {
  _tipHideTimer = setTimeout(() => { _tip.style.display = 'none'; }, 80);
}

function _shortPos(pos) {
  if (!pos) return '';
  if (/noun/i.test(pos)) return 'noun';
  if (/verb/i.test(pos)) return 'verb';
  if (/adjective/i.test(pos)) return 'adj.';
  if (/adverb/i.test(pos)) return 'adv.';
  if (/particle/i.test(pos)) return 'particle';
  if (/expression/i.test(pos)) return 'expr.';
  return pos.split(/[,;]/)[0].trim().slice(0, 12);
}

_load();
