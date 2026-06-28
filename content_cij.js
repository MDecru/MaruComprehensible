// cijapanese.com + local CIJ replica content script

let _cijVttCache = null;

// Wait for the <track> element to be added by the page's JS, then fetch VTT.
async function cijFetchVTT() {
  if (_cijVttCache) return _cijVttCache;

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

// CIJ transcript panel (for hover-on-transcript feature)
function cijFindTranscriptElement() {
  for (const sel of ['#tx-list', '.tx-list', '.cue-list']) {
    const el = document.querySelector(sel);
    if (el && /[぀-鿿]{2,}/.test(el.textContent)) return el;
  }
  for (const sel of ['[class*="transcript"]', '[id*="transcript"]', '[class*="subtitle"]', '[class*="caption"]']) {
    const el = document.querySelector(sel);
    if (!el) continue;
    if (el.textContent.trim().length > 20 && /[぀-鿿]{3,}/.test(el.textContent)) return el;
  }
  return null;
}

// ── Overlay & control bar (same as YouTube) ───────────────────────────────────

let _cijControlBar  = null;
let _cijSubOverlay  = null;
let _cijSubBtn      = null;
let _cijSettingsBtn = null;
let _cijSettingsPnl = null;
let _cijCues        = null;
let _cijLastCueIdx  = -2;
let _cijSubCleanup  = null;
let _cijPauseOnHover  = false;
let _cijPausedByHover = false;

let _cijFontSize   = 20;
let _cijBgOpacity  = 0.78;
let _cijFontWeight = 400;
let _cijColorblind = false;

const _CIJ_FONT_SIZES   = [20, 28, 36, 46];
const _CIJ_FONT_WEIGHTS = [{ label: 'Normal', value: 400 }, { label: 'Medium', value: 600 }, { label: 'Bold', value: 700 }];

if (chrome.runtime?.id) {
  try {
    chrome.storage.local.get('yt_sub_settings', ({ yt_sub_settings: s }) => {
      if (!s || chrome.runtime.lastError) return;
      if (s.fontSize    !== undefined) _cijFontSize    = s.fontSize;
      if (s.bgOpacity   !== undefined) _cijBgOpacity   = s.bgOpacity;
      if (s.fontWeight  !== undefined) _cijFontWeight  = s.fontWeight;
      if (s.colorblind  !== undefined) _cijColorblind  = s.colorblind;
      if (s.pauseOnHover !== undefined) _cijPauseOnHover = s.pauseOnHover;
    });
  } catch {}
}

function _cijSaveSettings() {
  if (!chrome.runtime?.id) return;
  try { chrome.storage.local.set({ yt_sub_settings: {
    fontSize: _cijFontSize, bgOpacity: _cijBgOpacity,
    fontWeight: _cijFontWeight, colorblind: _cijColorblind,
    pauseOnHover: _cijPauseOnHover,
  }}); } catch {}
}

function _cijGetPlayer() {
  const video = document.querySelector('video');
  if (!video) return null;
  // Reuse wrapper if already created
  if (video.parentElement?.id === 'mc-cij-wrap') return video.parentElement;
  // Insert a positioned wrapper around the video so overlay/bar sit on top of it
  const wrap = document.createElement('div');
  wrap.id = 'mc-cij-wrap';
  wrap.style.cssText = 'position:relative;display:block;width:100%;line-height:0;';
  video.before(wrap);
  wrap.appendChild(video);
  // Hide the native fullscreen button — we provide our own in the control bar
  video.setAttribute('controlslist', (video.getAttribute('controlslist') || '') + ' nofullscreen');
  return wrap;
}

function _cijEnsureOverlay(player) {
  if (_cijSubOverlay) return _cijSubOverlay;

  _cijSubOverlay = document.createElement('div');
  _cijSubOverlay.id = 'mc-cij-overlay';
  _cijSubOverlay.style.cssText = [
    'position:absolute', 'bottom:12%', 'left:0', 'right:0',
    'z-index:9996', 'display:flex', 'justify-content:center',
    'pointer-events:auto', 'text-align:center',
  ].join(';');
  _cijSubOverlay.addEventListener('mouseenter', () => {
    if (!_cijPauseOnHover) return;
    const v = document.querySelector('video');
    if (v && !v.paused) { v.pause(); _cijPausedByHover = true; }
  });
  _cijSubOverlay.addEventListener('mouseleave', () => {
    if (!_cijPausedByHover) return;
    _cijPausedByHover = false;
    document.querySelector('video')?.play().catch(() => {});
  });
  player.appendChild(_cijSubOverlay);
  return _cijSubOverlay;
}

function _cijSetSubActive(active) {
  if (_cijSubBtn)      _cijSubBtn.style.color       = active ? '#66AAE8' : '#888';
  if (_cijSettingsBtn) _cijSettingsBtn.style.display = active ? '' : 'none';
  if (!active && _cijSettingsPnl) _cijSettingsPnl.style.display = 'none';
}

function _cijRecolorOverlay() {
  if (!_hoverVocab) return;
  for (const span of (_cijSubOverlay?.querySelectorAll('.jp-tok') || [])) {
    const known = _hoverVocab.has(span.dataset.basic) || _hoverVocab.has(span.dataset.word);
    span.style.color = known ? '#66AAE8' : (_cijColorblind ? '#FDC281' : '#ED7989');
  }
}

function _cijParseVTTCues(vtt) {
  const toMs = str => {
    const s = str.trim().replace(/,/, '.');
    const parts = s.split(':').map(Number);
    const [h, m, sec] = parts.length === 3 ? parts : [0, ...parts];
    return Math.round((h * 3600 + m * 60 + sec) * 1000);
  };
  const cues = [];
  for (const block of vtt.split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    const ti = lines.findIndex(l => l.includes('-->'));
    if (ti < 0) continue;
    const [startStr, endStr] = lines[ti].split(/\s*-->\s*/);
    const text = lines.slice(ti + 1)
      .map(l => l.replace(/<[^>]+>/g, '').trim()).filter(Boolean).join(' ');
    if (!text) continue;
    const start = toMs(startStr), end = toMs(endStr);
    if (isNaN(start) || isNaN(end)) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

function _cijStartTimeSync() {
  const video = document.querySelector('video');
  if (!video) return () => {};
  _cijLastCueIdx = -2;

  const handler = async () => {
    if (!_cijCues || !_cijSubOverlay) return;
    const ms = video.currentTime * 1000;
    let idx = -1;
    for (let i = 0; i < _cijCues.length; i++) {
      if (ms >= _cijCues[i].start && ms < _cijCues[i].end) { idx = i; break; }
    }
    if (idx === _cijLastCueIdx) return;
    _cijLastCueIdx = idx;

    _cijSubOverlay.innerHTML = '';
    if (idx < 0) return;

    const wrap = document.createElement('span');
    wrap.style.cssText = [
      `background:rgba(0,0,0,${_cijBgOpacity})`, 'color:#fff',
      'padding:5px 18px', 'border-radius:6px', 'display:inline-block',
      `font-size:${_cijFontSize}px`, `font-weight:${_cijFontWeight}`, 'line-height:1.6',
    ].join(';');
    wrap.textContent = _cijCues[idx].text;
    _cijSubOverlay.appendChild(wrap);
    await hoverRetokenize(_cijSubOverlay);
    if (_cijColorblind) _cijRecolorOverlay();
  };

  video.addEventListener('timeupdate', handler);
  return () => video.removeEventListener('timeupdate', handler);
}

function _cijToggleSettings(player) {
  if (_cijSettingsPnl) {
    _cijSettingsPnl.style.display = _cijSettingsPnl.style.display === 'none' ? 'block' : 'none';
    return;
  }

  const pnl = document.createElement('div');
  pnl.id = 'mc-cij-settings';
  pnl.style.cssText = [
    'position:absolute', 'top:44px', 'left:12px', 'z-index:9998',
    'background:rgba(15,15,15,.96)', 'border:1px solid #3a3f4a',
    'border-radius:10px', 'padding:14px 16px',
    'color:#d0d4e0', 'font-size:13px', 'font-family:-apple-system,sans-serif',
    'white-space:nowrap', 'min-width:240px',
    'box-shadow:0 8px 24px rgba(0,0,0,.7)',
  ].join(';');

  function _lbl(text) {
    const el = document.createElement('div');
    el.style.cssText = 'font-size:11px;color:#888;margin-bottom:7px;letter-spacing:.4px;text-transform:uppercase';
    el.textContent = text; pnl.appendChild(el);
  }
  function _row(gap, mb) {
    const row = document.createElement('div');
    row.style.cssText = `display:flex;gap:${gap}px;margin-bottom:${mb}px`;
    pnl.appendChild(row); return row;
  }
  function _active(on) {
    return [
      `background:${on ? 'rgba(102,170,232,.2)' : 'rgba(255,255,255,.06)'}`,
      `color:${on ? '#66AAE8' : '#888'}`,
      `border:1px solid ${on ? '#66AAE8' : '#3a3f4a'}`,
    ].join(';');
  }

  // Font size
  _lbl('Font size');
  const fsRow = _row(6, 14);
  _CIJ_FONT_SIZES.forEach((sz, i) => {
    const btn = document.createElement('button');
    btn.dataset.sz = sz; btn.textContent = i + 1;
    btn.style.cssText = `flex:1;padding:5px 0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;transition:all .15s;${_active(sz === _cijFontSize)}`;
    btn.addEventListener('click', e => {
      e.stopPropagation(); _cijFontSize = sz;
      fsRow.querySelectorAll('[data-sz]').forEach(b => { b.style.cssText = `flex:1;padding:5px 0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;transition:all .15s;${_active(+b.dataset.sz === _cijFontSize)}`; });
      const w = _cijSubOverlay?.querySelector('span');
      if (w) w.style.fontSize = `${_cijFontSize}px`;
      _cijSaveSettings();
    });
    fsRow.appendChild(btn);
  });

  // Font weight
  _lbl('Font weight');
  const fwRow = _row(6, 14);
  _CIJ_FONT_WEIGHTS.forEach(({ label, value }) => {
    const btn = document.createElement('button');
    btn.dataset.fw = value; btn.textContent = label;
    btn.style.cssText = `flex:1;padding:5px 0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:${value};transition:all .15s;${_active(value === _cijFontWeight)}`;
    btn.addEventListener('click', e => {
      e.stopPropagation(); _cijFontWeight = value;
      fwRow.querySelectorAll('[data-fw]').forEach(b => { b.style.cssText = `flex:1;padding:5px 0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:${b.dataset.fw};transition:all .15s;${_active(+b.dataset.fw === _cijFontWeight)}`; });
      const w = _cijSubOverlay?.querySelector('span');
      if (w) w.style.fontWeight = `${_cijFontWeight}`;
      _cijSaveSettings();
    });
    fwRow.appendChild(btn);
  });

  // BG opacity
  _lbl('Background opacity');
  const bgRow = document.createElement('div');
  bgRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:14px';
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = '0'; slider.max = '100';
  slider.value = Math.round(_cijBgOpacity * 100);
  slider.style.cssText = 'flex:1;cursor:pointer;accent-color:#66AAE8';
  slider.addEventListener('click', e => e.stopPropagation());
  slider.addEventListener('input', e => {
    e.stopPropagation(); _cijBgOpacity = slider.value / 100;
    bgVal.textContent = `${slider.value}%`;
    const w = _cijSubOverlay?.querySelector('span');
    if (w) w.style.background = `rgba(0,0,0,${_cijBgOpacity})`;
    _cijSaveSettings();
  });
  const bgVal = document.createElement('span');
  bgVal.style.cssText = 'font-size:12px;color:#66AAE8;min-width:34px;text-align:right';
  bgVal.textContent = `${slider.value}%`;
  bgRow.appendChild(slider); bgRow.appendChild(bgVal); pnl.appendChild(bgRow);

  // Color mode
  _lbl('Color mode');
  const cmRow = _row(6, 6);
  [{ label: 'Blue / Red', cb: false }, { label: 'Blue / Orange', cb: true }].forEach(({ label, cb }) => {
    const btn = document.createElement('button');
    btn.dataset.cb = cb; btn.textContent = label;
    btn.style.cssText = `flex:1;padding:5px 4px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;transition:all .15s;${_active(cb === _cijColorblind)}`;
    btn.addEventListener('click', e => {
      e.stopPropagation(); _cijColorblind = cb;
      cmRow.querySelectorAll('[data-cb]').forEach(b => { b.style.cssText = `flex:1;padding:5px 4px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;transition:all .15s;${_active((b.dataset.cb === 'true') === _cijColorblind)}`; });
      _cijRecolorOverlay(); _cijLastCueIdx = -2; _cijSaveSettings();
    });
    cmRow.appendChild(btn);
  });
  const cmHint = document.createElement('div');
  cmHint.style.cssText = 'font-size:11px;color:#555;margin-top:5px;margin-bottom:14px';
  cmHint.textContent = 'Blue = known · Red/Orange = unknown';
  pnl.appendChild(cmHint);

  // Pause on hover
  _lbl('Pause on hover');
  const phRow = _row(6, 4);
  [{ label: 'Off', val: false }, { label: 'On', val: true }].forEach(({ label, val }) => {
    const btn = document.createElement('button');
    btn.dataset.ph = val; btn.textContent = label;
    btn.style.cssText = `flex:1;padding:5px 0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;transition:all .15s;${_active(val === _cijPauseOnHover)}`;
    btn.addEventListener('click', e => {
      e.stopPropagation(); _cijPauseOnHover = val;
      if (!val && _cijPausedByHover) { _cijPausedByHover = false; document.querySelector('video')?.play().catch(() => {}); }
      phRow.querySelectorAll('[data-ph]').forEach(b => { b.style.cssText = `flex:1;padding:5px 0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;transition:all .15s;${_active((b.dataset.ph === 'true') === _cijPauseOnHover)}`; });
      _cijSaveSettings();
    });
    phRow.appendChild(btn);
  });
  const phHint = document.createElement('div');
  phHint.style.cssText = 'font-size:11px;color:#555;margin-top:3px';
  phHint.textContent = 'Pauses playback while hovering a subtitle';
  pnl.appendChild(phHint);

  player.appendChild(pnl);
  _cijSettingsPnl = pnl;
}

function _cijCreateControlBar(player, score) {
  if (_cijControlBar) {
    const el = document.getElementById('mc-cij-score');
    if (el && score !== null) el.textContent = `${score}%`;
    return;
  }

  const bar = document.createElement('div');
  bar.id = 'mc-cij-bar';
  bar.style.cssText = [
    'position:absolute', 'top:12px', 'left:12px', 'z-index:9997',
    'display:inline-flex', 'align-items:stretch',
    'border-radius:7px', 'overflow:hidden',
    'background:rgba(0,0,0,.78)',
    'border:1px solid rgba(255,255,255,.14)',
    'font-family:-apple-system,sans-serif',
  ].join(';');

  const scoreEl = document.createElement('span');
  scoreEl.id = 'mc-cij-score';
  scoreEl.style.cssText = 'padding:5px 10px;font-size:13px;font-weight:700;color:#fff;border-right:1px solid rgba(255,255,255,.12);display:flex;align-items:center';
  scoreEl.textContent = score !== null ? `${score}%` : '–';
  bar.appendChild(scoreEl);

  // 字幕 button
  _cijSubBtn = document.createElement('button');
  _cijSubBtn.id = 'mc-cij-btn';
  _cijSubBtn.textContent = '字幕';
  _cijSubBtn.style.cssText = 'padding:5px 10px;font-size:13px;font-weight:600;color:#888;background:none;border:none;border-right:1px solid rgba(255,255,255,.12);cursor:pointer;letter-spacing:.3px;transition:color .15s';
  let _loading = false;
  _cijSubBtn.addEventListener('click', async e => {
    e.stopPropagation();
    if (_loading) return;
    if (!_cijCues) {
      _loading = true; _cijSubBtn.textContent = '…';
      const vtt = await cijFetchVTT();
      _loading = false; _cijSubBtn.textContent = '字幕';
      if (!vtt) return;
      _cijCues = _cijParseVTTCues(vtt);
      if (!_cijCues.length) { _cijCues = null; return; }
      _cijEnsureOverlay(player);
      if (!_hoverEnabled) await hoverEnable(() => _cijSubOverlay);
      _cijSubCleanup?.(); _cijSubCleanup = _cijStartTimeSync();
      _cijSetSubActive(true);
    } else if (_cijSubCleanup) {
      _cijSubCleanup?.(); _cijSubCleanup = null;
      if (_cijSubOverlay) _cijSubOverlay.innerHTML = '';
      _cijSetSubActive(false);
    } else {
      _cijEnsureOverlay(player);
      _cijSubCleanup?.(); _cijSubCleanup = _cijStartTimeSync();
      _cijSetSubActive(true);
    }
  });
  bar.appendChild(_cijSubBtn);

  // ⚙ settings button
  _cijSettingsBtn = document.createElement('button');
  _cijSettingsBtn.id = 'mc-cij-settings-btn';
  _cijSettingsBtn.textContent = '⚙';
  _cijSettingsBtn.style.cssText = 'padding:5px 8px;font-size:12px;color:#888;background:none;border:none;cursor:pointer;display:none';
  _cijSettingsBtn.addEventListener('click', e => { e.stopPropagation(); _cijToggleSettings(player); });
  bar.appendChild(_cijSettingsBtn);

  // ⛶ fullscreen button — requests fullscreen on the wrapper (user gesture context)
  const fsBtn = document.createElement('button');
  fsBtn.id = 'mc-cij-fs-btn';
  fsBtn.title = 'Fullscreen';
  fsBtn.style.cssText = 'padding:5px 8px;background:none;border:none;color:#fff;cursor:pointer;display:flex;align-items:center';
  fsBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor"><path d="M0 0h4v1.5H1.5V4H0zm9 0h4v4h-1.5V1.5H9zM0 9h1.5v2.5H4V13H0zm11.5 2.5V9H13v4H9v-1.5z"/></svg>';
  fsBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (!document.fullscreenElement) {
      player.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });
  bar.appendChild(fsBtn);

  player.appendChild(bar);
  _cijControlBar = bar;
}

// ── Page scan (score + control bar) ──────────────────────────────────────────

async function scanPage() {
  const vtt = await cijFetchVTT();
  if (!vtt) return null;

  const res = await scoreVTT(vtt);
  const video = document.querySelector('video');
  const player = _cijGetPlayer();
  if (player) {
    if (getComputedStyle(player).position === 'static') player.style.position = 'relative';
    _cijCreateControlBar(player, res?.score ?? null);
  } else if (video) {
    showBadge(video.parentElement || document.body, res?.score ?? null, { top: '12px', left: '12px' });
  }
  return res;
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === 'enableHover') {
    hoverEnable(cijFindTranscriptElement).then(reply); return true;
  }
  if (msg.action === 'disableHover') {
    hoverDisable();
    _cijSubCleanup?.(); _cijSubCleanup = null;
    if (_cijSubOverlay) _cijSubOverlay.innerHTML = '';
    _cijSetSubActive(false);
    reply({ ok: true }); return;
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
  _cijVttCache = null;
  scanPage()
    .then(res => reply(res !== null
      ? { score: res.score, freqKnown: res.freqKnown, freqTotal: res.freqTotal, uniqueKnown: res.uniqueKnown, uniqueTotal: res.uniqueTotal, kanjiKnown: res.kanjiKnown, kanjiTotal: res.kanjiTotal }
      : { error: 'No Japanese subtitles found' }))
    .catch(e => reply({ error: e.message }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.mm_vocab?.newValue?.length) {
    _cijVttCache = null;
    scanPage();
  }
});

// Auto-score on load
scanPage();

// Re-tokenize transcript panel when it fills in dynamically
new MutationObserver(() => {
  if (typeof _hoverEnabled !== 'undefined' && _hoverEnabled) {
    const container = cijFindTranscriptElement();
    if (container) hoverRetokenize(container);
  }
}).observe(document.body, { childList: true, subtree: true });

getTokenizer().catch(() => {});

// Style the wrapper when it enters/exits fullscreen, and keep hover/sidebar visible.
// The native video fullscreen button is suppressed (controlslist=nofullscreen);
// fullscreen is only triggered by our own button which requests on the wrapper.
document.addEventListener('fullscreenchange', () => {
  const fs = document.fullscreenElement;
  const video = document.querySelector('video');
  const wrap = document.getElementById('mc-cij-wrap');
  const fsBtn = document.getElementById('mc-cij-fs-btn');
  if (!wrap) return;

  if (fs === wrap) {
    wrap.style.cssText = 'position:relative;display:flex;align-items:center;justify-content:center;background:#000;width:100vw;height:100vh;';
    if (video) { video.style.maxWidth = '100vw'; video.style.maxHeight = '100vh'; }
    if (fsBtn) fsBtn.title = 'Exit fullscreen';
    for (const id of ['jp-hover-tip', 'jp-sidebar']) {
      const el = document.getElementById(id); if (el) wrap.appendChild(el);
    }
  } else {
    wrap.style.cssText = 'position:relative;display:block;width:100%;line-height:0;';
    if (video) { video.style.maxWidth = ''; video.style.maxHeight = ''; }
    if (fsBtn) fsBtn.title = 'Fullscreen';
    for (const id of ['jp-hover-tip', 'jp-sidebar']) {
      const el = document.getElementById(id); if (el) document.body.appendChild(el);
    }
  }
});
