// nihongo-jikan.com content script — auto-injected

// Clone element and strip <rt>/<rp> furigana before reading textContent,
// otherwise ruby markup like <ruby>入<rt>はい</rt></ruby>る becomes "入はいる".
function _cleanText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('rt, rp').forEach(n => n.remove());
  return clone.textContent;
}

function extractPageTranscript() {
  // Try dedicated transcript containers first
  const containers = [
    '[class*="transcript"]', '[id*="transcript"]',
    '[class*="subtitle"]',   '[class*="caption"]',
    '[class*="script"]',     '[class*="lyric"]',
  ];
  for (const sel of containers) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = _cleanText(el).replace(/▶/g, '').trim();
    if (text.length > 20 && /[぀-鿿]{3,}/.test(text)) return text;
  }

  // Fallback: walk text nodes, collect Japanese-heavy lines (skip rt/rp content)
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const lines = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('rt, rp')) continue;
    const t = node.textContent.trim();
    if (t.length > 3 && /[぀-鿿]{2,}/.test(t)) lines.push(t);
  }
  return lines.join('\n');
}

async function fetchAndScoreUrl(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const text = await r.text();
    if (!text.includes('-->')) return null;
    return await scoreVTT(text);
  } catch { return null; }
}

async function tryYouTubeId(videoId, container) {
  const urls = [
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ja&fmt=vtt`,
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ja&fmt=vtt&kind=asr`,
  ];
  for (const url of urls) {
    const res = await fetchAndScoreUrl(url);
    if (res !== null) { showBadge(container, res.score); return res; }
  }
  return null;
}

async function scanPage() {
  // Only score on video detail pages — require an actual player element.
  // On list/catalogue pages there's no player, and the text fallback would
  // accidentally score all video titles/descriptions on screen.
  const player = document.querySelector('iframe[src*="youtube"], video, [class*="player"]');
  if (!player) return null;

  const _njkKey = `njk_${location.pathname}`;
  const _njkTitle = document.querySelector('h1, h2, meta[property="og:title"]')?.content?.trim()
    || document.querySelector('h1, h2')?.textContent?.trim()
    || document.title.replace(/\s*[\|\-–—].*$/, '').trim();

  function _njkSave(res) {
    if (res?.score != null) saveVideoHistory(_njkKey, { title: _njkTitle, url: location.href, site: 'njk', score: res });
  }

  // 1. Try page transcript (NJK embeds full transcript in DOM)
  const transcriptText = extractPageTranscript();
  if (transcriptText) {
    const res = await scoreText(transcriptText);
    if (res?.score !== null) {
      const container = player.parentElement || document.body;
      showBadge(container, res.score);
      _njkSave(res);
      return res;
    }
  }

  // 2. Fallback: YouTube iframe caption fetch
  for (const iframe of document.querySelectorAll('iframe')) {
    const src = iframe.src || iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
    const match = src.match(/(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (!match) continue;
    const res = await tryYouTubeId(match[1], iframe.parentElement || iframe);
    if (res !== null) { _njkSave(res); return res; }
  }

  // 3. Fallback: native <video> + <track>
  for (const video of document.querySelectorAll('video')) {
    for (const track of video.querySelectorAll('track')) {
      if (!track.src) continue;
      const res = await fetchAndScoreUrl(track.src);
      if (res !== null) { showBadge(video.parentElement || video, res.score); _njkSave(res); return res; }
    }
  }

  return null;
}

function njkFindTranscriptElement() {
  const selectors = [
    '[class*="transcript"]', '[id*="transcript"]',
    '[class*="subtitle"]',   '[class*="caption"]',
    '[class*="script"]',     '[class*="lyric"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = el.textContent.replace(/▶/g, '').trim();
    if (text.length > 20 && /[぀-鿿]{3,}/.test(text)) return el;
  }
  return null;
}

// Message handler for popup
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === 'enableHover') {
    hoverEnable(njkFindTranscriptElement).then(reply); return true;
  }
  if (msg.action === 'disableHover') {
    hoverDisable(); reply({ ok: true }); return;
  }
  if (msg.action === 'hoverStatus') {
    reply({ enabled: _hoverEnabled }); return;
  }
  if (msg.action === 'preload') {
    getTokenizer().then(() => reply({ ok: true })).catch(() => reply({ ok: false }));
    return true;
  }
  if (msg.action === 'tokStatus') {
    reply({ ready: _tokenizer !== null }); return;
  }
  if (msg.action === 'openSidebar') {
    const text = extractPageTranscript();
    sidebarToggle(text).then(reply); return true;
  }
  if (msg.action === 'sidebarStatus') {
    reply({ open: sidebarIsOpen() }); return;
  }
  if (msg.action !== 'rescore') return;
  scanPage().then(res => reply(res !== null ? { score: res.score, freqKnown: res.freqKnown, freqTotal: res.freqTotal, uniqueKnown: res.uniqueKnown, uniqueTotal: res.uniqueTotal, kanjiKnown: res.kanjiKnown, kanjiTotal: res.kanjiTotal } : { error: 'No Japanese subtitles found' }))
            .catch(e  => reply({ error: e.message }));
  return true; // async reply
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.mm_vocab?.newValue?.length) setTimeout(scanPage, 500);
});

// Run on load
scanPage();

let _observer = new MutationObserver(() => {
  _observer.disconnect();
  setTimeout(() => {
    scanPage();
    // Re-tokenize any new transcript nodes if hover mode is on
    if (_hoverEnabled) {
      const container = njkFindTranscriptElement();
      if (container) hoverRetokenize(container);
    }
    _observer.observe(document.body, { childList: true, subtree: true });
  }, 1200);
});
_observer.observe(document.body, { childList: true, subtree: true });

getTokenizer().catch(() => {});

// ── Watched badges on NJK listing pages ──────────────────────────────────────
(async () => {
  // Skip actual video pages — the score badge is shown inline by scanPage()
  const player = document.querySelector('iframe[src*="youtube"], video, [class*="player"]');
  if (player) return;

  const { mc_history_enabled = true, mc_badges_enabled = true, mc_video_history = {} } =
    await chrome.storage.local.get(['mc_history_enabled', 'mc_badges_enabled', 'mc_video_history']);
  if (!mc_history_enabled || !mc_badges_enabled || !Object.keys(mc_video_history).length) return;

  function _njkColor(score) {
    if (score == null) return '#72CE9D';
    const stops = [[237,121,137],[253,194,129],[114,206,157]];
    const t = Math.max(0, Math.min(100, score)) / 100;
    const seg = t < 0.5 ? 0 : 1;
    const lt  = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    const [r1,g1,b1] = stops[seg], [r2,g2,b2] = stops[seg+1];
    return `rgb(${Math.round(r1+(r2-r1)*lt)},${Math.round(g1+(g2-g1)*lt)},${Math.round(b1+(b2-b1)*lt)})`;
  }

  function _njkInject() {
    document.querySelectorAll('a').forEach(a => {
      // Only badge thumbnail links (those that contain an img) — skip title/text links
      const img = a.querySelector('img');
      if (!img) return;
      if (!a.href.includes('nihongo-jikan.com')) return;
      if (a.querySelector('.mc-watched-badge')) return;
      let path;
      try { path = new URL(a.href).pathname; } catch { return; }
      if (!path || path === '/') return;
      const entry = mc_video_history[`njk_${path}`];
      if (!entry) return;

      const score = entry.lastScore?.score;
      const badge = document.createElement('div');
      badge.className = 'mc-watched-badge';
      badge.style.cssText = [
        'position:absolute', 'bottom:8px', 'left:8px', 'z-index:10',
        'background:rgba(0,0,0,.85)', `color:${_njkColor(score)}`,
        'font:700 13px/1 -apple-system,sans-serif',
        'padding:5px 10px', 'border-radius:6px', 'pointer-events:none', 'letter-spacing:.3px',
      ].join(';');
      badge.textContent = score != null ? `✓ ${score}%` : '✓ Watched';

      const parent = img.parentElement || a;
      if (!parent.style.position) parent.style.position = 'relative';
      parent.appendChild(badge);
    });
  }

  // Run once after a short delay to let the framework finish its initial render.
  // No MutationObserver — NJK re-renders card DOM on thumbnail hover which would
  // cause the observer to fire continuously and crash the page.
  setTimeout(_njkInject, 800);
})();

// nihongo-jikan.com likely wraps content in a framework root element rather
// than relying on body layout, so body.marginRight has no visible effect.
// Shift the outermost content container instead.
sbRegisterPush(
  () => {
    const el = document.querySelector('main, #__next, #app, #root') || document.body;
    el.dataset.sbPrevMargin = el.style.marginRight;
    el.style.transition = 'margin-right .2s ease';
    el.style.marginRight = '260px';
  },
  () => {
    const el = document.querySelector('main, #__next, #app, #root') || document.body;
    el.style.marginRight = el.dataset.sbPrevMargin || '';
    delete el.dataset.sbPrevMargin;
  }
);
