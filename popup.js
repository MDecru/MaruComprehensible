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
  // 4 sequential requests (MM rate-limits aggressively)
  const kanjiItems  = await fetchItems('/known/kanji', token);                    await sleep(1100);
  const vocabItems  = await fetchItems('/known/vocabulary', token);               await sleep(1100);
  const kanjiExtra  = await fetchItems('/known/kanji?min-level=9001', token);     await sleep(1100);
  const vocabExtra  = await fetchItems('/known/vocabulary?min-level=9001', token);

  const kanji = [...new Set([...kanjiItems, ...kanjiExtra].map(x => x.item))];
  const vocab = [...new Set([...vocabItems,  ...vocabExtra].map(x => x.item))];
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
  return {
    vocab: new Set([...(mmVocab || []), ...(extraVocab || [])]).size,
    kanji: new Set([...(mmKanji || []), ...(extraKanji || [])]).size,
  };
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

async function init() {
  const { mm_token, mm_vocab, mm_kanji, mm_extra_vocab, mm_extra_kanji } =
    await chrome.storage.local.get(['mm_token', 'mm_vocab', 'mm_kanji', 'mm_extra_vocab', 'mm_extra_kanji']);

  if (mm_token) {
    document.getElementById('token').value = mm_token;
    const { vocab: vc, kanji: kc } = _mergedCounts(mm_vocab, mm_kanji, mm_extra_vocab, mm_extra_kanji);
    setStats(vc, kc);
    setStatus('✓ Connected', '#72CE9D');
  }
  setExtraStatus(mm_extra_vocab, mm_extra_kanji);

  document.getElementById('connect-btn').addEventListener('click', async () => {
    const token = document.getElementById('token').value.trim();
    if (!token) return;
    const btn = document.getElementById('connect-btn');
    btn.disabled = true;
    setStatus('Fetching vocab… (takes ~5 seconds)', '#888');
    try {
      const { kanji, vocab } = await fetchAllVocab(token);
      await chrome.storage.local.set({ mm_token: token, mm_vocab: vocab, mm_kanji: kanji });
      const { mm_extra_vocab: ev = [], mm_extra_kanji: ek = [] } = await chrome.storage.local.get(['mm_extra_vocab', 'mm_extra_kanji']);
      const { vocab: vc, kanji: kc } = _mergedCounts(vocab, kanji, ev, ek);
      setStats(vc, kc);
      setStatus(`✓ Connected — ${vocab.length} vocab, ${kanji.length} kanji`, '#72CE9D');
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
      setStatus('✓ Refreshed', '#72CE9D');
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
      .then(r => setTokStatus(r?.ready ? '✓ Ready' : 'not loaded', r?.ready ? '#72CE9D' : '#444'))
      .catch(() => setTokStatus('not loaded', '#444'));

    doScore(tab, { silent: true });
  }

  document.getElementById('preload-btn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const btn = document.getElementById('preload-btn');
    btn.disabled = true;
    setTokStatus('loading…', '#888');
    try {
      await preloadInTab(tab.id);
      // Poll until ready
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
    btn.disabled = false;
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
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { action: 'hoverStatus' })
      .then(r => { hoverToggle.checked = !!r?.enabled; })
      .catch(() => {});
  }
  hoverToggle.addEventListener('change', async () => {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) return;
    if (!hoverToggle.checked) {
      await chrome.tabs.sendMessage(activeTab.id, { action: 'disableHover' }).catch(() => {});
    } else {
      hoverToggle.disabled = true;
      try {
        const r = await chrome.tabs.sendMessage(activeTab.id, { action: 'enableHover' });
        if (!r?.ok) {
          setStatus(r?.error || 'Hover failed', '#f44336');
          hoverToggle.checked = false;
        }
      } catch (e) {
        setStatus(`Hover error: ${e.message}`, '#f44336');
        hoverToggle.checked = false;
      }
      hoverToggle.disabled = false;
    }
  });

  // Video subtitle tool toggle
  const videoSubToggle = document.getElementById('video-sub-toggle');
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { action: 'videoToolStatus' })
      .then(r => { videoSubToggle.checked = r?.enabled !== false; })
      .catch(() => { videoSubToggle.checked = true; });
  }
  videoSubToggle.addEventListener('change', async () => {
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
      .slice(0, 5);

    if (!mc_history_enabled || !entries.length) {
      histListEl.innerHTML = '<div id="hist-empty">No history yet</div>';
      return;
    }

    histListEl.innerHTML = entries.map(([, v]) => {
      const score = v.lastScore?.score;
      const scoreHtml = score != null
        ? `<span class="hist-score" style="color:${_compColorPop(score)}">${score}%</span>` : '';
      const siteClass = `hs-${v.site || 'yt'}`;
      const siteLabel = v.site === 'cij' ? 'CIJ' : v.site === 'player' ? 'Local' : 'YT';
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
