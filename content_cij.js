// cijapanese.com content script — auto-injected on video pages

let _cijVttCache = null;

// Wait for the <track> element to be added by the page's JS, then fetch VTT.
async function cijFetchVTT() {
  if (_cijVttCache) return _cijVttCache;

  // Poll for the track element up to 8 seconds (page JS adds it dynamically)
  let track = null;
  for (let i = 0; i < 16; i++) {
    const video = document.querySelector('video');
    track = video?.querySelector('track[src]');
    if (track?.src) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!track?.src) return null;

  try {
    const r = await fetch(track.src);
    if (!r.ok) return null;
    const text = await r.text();
    if (!text.includes('-->')) return null;
    _cijVttCache = text;
    return text;
  } catch { return null; }
}

// CIJ website uses #tx-list / .tx-list for the scrollable transcript panel,
// with individual .cue > .cue-body > .cue-text spans for each subtitle line.
function cijFindTranscriptElement() {
  // Specific CIJ selectors first
  for (const sel of ['#tx-list', '.tx-list', '.cue-list']) {
    const el = document.querySelector(sel);
    if (el && /[぀-鿿]{2,}/.test(el.textContent)) return el;
  }
  // Generic fallback
  for (const sel of ['[class*="transcript"]', '[id*="transcript"]', '[class*="subtitle"]', '[class*="caption"]']) {
    const el = document.querySelector(sel);
    if (!el) continue;
    if (el.textContent.trim().length > 20 && /[぀-鿿]{3,}/.test(el.textContent)) return el;
  }
  return null;
}

async function scanPage() {
  const vtt = await cijFetchVTT();
  if (!vtt) return null;

  const res = await scoreVTT(vtt);
  const video = document.querySelector('video');
  const container = video?.closest('[class*="player"],[class*="video"],[id*="player"],[id*="video"]')
                 || video?.parentElement
                 || document.body;
  showBadge(container, res?.score ?? null, { top: '12px', left: '12px' });
  return res;
}

// Message handler for popup
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === 'enableHover') {
    hoverEnable(cijFindTranscriptElement).then(reply); return true;
  }
  if (msg.action === 'disableHover') {
    hoverDisable(); reply({ ok: true }); return;
  }
  if (msg.action === 'hoverStatus') {
    reply({ enabled: _hoverEnabled }); return;
  }
  if (msg.action === 'openSidebar') {
    cijFetchVTT().then(vtt => {
      if (!vtt) { reply({ ok: false, error: 'No subtitles found' }); return; }
      return sidebarToggle(parseVTT(vtt)).then(reply);
    }).catch(e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'sidebarStatus') {
    reply({ open: sidebarIsOpen() }); return;
  }
  if (msg.action === 'preload') {
    getTokenizer().then(() => reply({ ok: true })).catch(() => reply({ ok: false }));
    return true;
  }
  if (msg.action === 'tokStatus') {
    reply({ ready: _tokenizer !== null }); return;
  }
  if (msg.action !== 'rescore') return;
  _cijVttCache = null; // force re-fetch
  scanPage()
    .then(res => reply(res !== null ? { score: res.score, freqKnown: res.freqKnown, freqTotal: res.freqTotal, uniqueKnown: res.uniqueKnown, uniqueTotal: res.uniqueTotal, kanjiKnown: res.kanjiKnown, kanjiTotal: res.kanjiTotal } : { error: 'No Japanese subtitles found' }))
    .catch(e  => reply({ error: e.message }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.mm_vocab?.newValue?.length) {
    _cijVttCache = null;
    scanPage();
  }
});

// Auto-score on load — wait for the page's JS to set up the video + track
scanPage();

// Re-tokenize if hover is on when the transcript fills in (it's populated dynamically)
new MutationObserver(() => {
  if (typeof _hoverEnabled !== 'undefined' && _hoverEnabled) {
    const container = cijFindTranscriptElement();
    if (container) hoverRetokenize(container);
  }
}).observe(document.body, { childList: true, subtree: true });

getTokenizer().catch(() => {});
