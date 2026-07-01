// Badge injector for CIJ listing pages (not video pages — those use content_cij.js)
(async () => {
  if (/\/video\/\d/.test(location.pathname)) return;

  const { mc_history_enabled = true, mc_video_history = {} } =
    await chrome.storage.local.get(['mc_history_enabled', 'mc_video_history']);
  if (!mc_history_enabled || !Object.keys(mc_video_history).length) return;

  function _color(score) {
    if (score == null) return '#72CE9D';
    const stops = [[237,121,137],[253,194,129],[114,206,157]];
    const t = Math.max(0, Math.min(100, score)) / 100;
    const seg = t < 0.5 ? 0 : 1;
    const lt  = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    const [r1,g1,b1] = stops[seg], [r2,g2,b2] = stops[seg+1];
    return `rgb(${Math.round(r1+(r2-r1)*lt)},${Math.round(g1+(g2-g1)*lt)},${Math.round(b1+(b2-b1)*lt)})`;
  }

  function _inject() {
    document.querySelectorAll('a[href*="/video/"]').forEach(a => {
      if (a.querySelector('.mc-watched-badge')) return;
      const m = a.href.match(/\/video\/(\d+)/);
      if (!m) return;
      const entry = mc_video_history[`cij_${m[1]}`];
      if (!entry) return;

      const score = entry.lastScore?.score;
      const color = _color(score);
      const badge = document.createElement('div');
      badge.className = 'mc-watched-badge';
      badge.style.cssText = [
        'position:absolute', 'bottom:6px', 'left:6px', 'z-index:10',
        'background:rgba(0,0,0,.82)', `color:${color}`,
        'font:700 11px/1 -apple-system,sans-serif',
        'padding:3px 7px', 'border-radius:5px', 'pointer-events:none',
        'letter-spacing:.2px',
      ].join(';');
      badge.textContent = score != null ? `✓ ${score}%` : '✓';

      const img = a.querySelector('img');
      const parent = img?.parentElement || a;
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.appendChild(badge);
    });
  }

  _inject();
  new MutationObserver(_inject).observe(document.body, { childList: true, subtree: true });
})();
