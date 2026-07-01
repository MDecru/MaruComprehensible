// History page — watched videos + unknown word frequency

let _videos = {};
let _words  = {};
let _videoFilter = '';
let _wordFilter  = '';
let _wordSort    = 'count';
let _hoverReady  = false;

const $ = id => document.getElementById(id);

async function _load() {
  const data = await chrome.storage.local.get(['mc_video_history', 'mc_word_history']);
  _videos = data.mc_video_history || {};
  _words  = data.mc_word_history  || {};
  _renderStats();
  _renderVideos();
  await _renderWords();
  // Activate hover.js for the word list — loads tokenizer + vocab once
  if (!_hoverReady) {
    const result = await hoverEnable(() => $('word-list-container'));
    if (result?.ok) _hoverReady = true;
  }
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

async function _renderWords() {
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
    <div class="word-row">
      <span class="word-text">${_esc(w)}</span>
      <span class="word-count">${d.count}×</span>
      <span class="word-date">${d.lastSeen ? _fmtDate(d.lastSeen) : ''}</span>
    </div>`).join('')}</div>`;

  // Re-tokenize so hover.js wraps words in .jp-tok spans with readings
  if (_hoverReady) await hoverRetokenize(con);
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

$('sort-count-btn').addEventListener('click', async () => {
  _wordSort = 'count';
  $('sort-count-btn').classList.add('active');
  $('sort-alpha-btn').classList.remove('active');
  await _renderWords();
});
$('sort-alpha-btn').addEventListener('click', async () => {
  _wordSort = 'alpha';
  $('sort-alpha-btn').classList.add('active');
  $('sort-count-btn').classList.remove('active');
  await _renderWords();
});

// ── Search ────────────────────────────────────────────────────────────────────

$('video-search').addEventListener('input', () => { _videoFilter = $('video-search').value; _renderVideos(); });
$('word-search').addEventListener('input', async () => { _wordFilter = $('word-search').value; await _renderWords(); });

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
  _renderStats(); await _renderWords();
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

_load();
