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

let _transcriptHoverActive = false;

let _cijFontSize   = 20;
let _cijBgOpacity  = 0.78;
let _cijFontWeight = 400;
let _cijColorblind = false;
let _cijSubPosition   = 12;
let _cijSubDelay      = 0;
let _cijSubStyle      = 'box';
let _cijSubMaxWidth   = 90;
let _cijAutoPause        = false;
let _cijUnknownOnly      = false;
let _cijOutlineThickness = 1;
let _cijFurigana         = false;
let _cijFuriganaOpacity  = 0.7;

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
      if (s.subPosition  !== undefined) _cijSubPosition  = s.subPosition;
      if (s.subDelay     !== undefined) _cijSubDelay      = s.subDelay;
      if (s.subStyle     !== undefined) _cijSubStyle      = s.subStyle;
      if (s.subMaxWidth  !== undefined) _cijSubMaxWidth   = s.subMaxWidth;
      if (s.autoPause    !== undefined) _cijAutoPause     = s.autoPause;
      if (s.unknownOnly        !== undefined) _cijUnknownOnly      = s.unknownOnly;
      if (s.outlineThickness   !== undefined) _cijOutlineThickness = s.outlineThickness;
      if (s.furigana           !== undefined) _cijFurigana         = s.furigana;
      if (s.furiganaOpacity    !== undefined) _cijFuriganaOpacity  = s.furiganaOpacity;
    });
  } catch {}
}

function _cijSaveSettings() {
  if (!chrome.runtime?.id) return;
  try { chrome.storage.local.set({ yt_sub_settings: {
    fontSize: _cijFontSize, bgOpacity: _cijBgOpacity,
    fontWeight: _cijFontWeight, colorblind: _cijColorblind,
    pauseOnHover: _cijPauseOnHover,
    subPosition: _cijSubPosition, subDelay: _cijSubDelay, subStyle: _cijSubStyle, subMaxWidth: _cijSubMaxWidth, autoPause: _cijAutoPause, unknownOnly: _cijUnknownOnly,
    outlineThickness: _cijOutlineThickness, furigana: _cijFurigana, furiganaOpacity: _cijFuriganaOpacity,
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
  return wrap;
}

function _cijEnsureOverlay(player) {
  if (_cijSubOverlay) return _cijSubOverlay;

  _cijSubOverlay = document.createElement('div');
  _cijSubOverlay.id = 'mc-cij-overlay';
  _cijSubOverlay.dataset.mcFullHover = '1';
  _cijSubOverlay.style.cssText = [
    'position:absolute', `bottom:${_cijSubPosition}%`, 'left:0', 'right:0',
    'z-index:9996', 'display:flex', 'justify-content:center',
    'pointer-events:auto', 'text-align:center',
  ].join(';');
  // Guard against the site calling video.play() while we own the pause
  const _cijVideo = () => document.querySelector('video');
  const _cijOnVideoPlay = () => { if (_cijPausedByHover) _cijVideo()?.pause(); };

  _cijSubOverlay.addEventListener('mouseenter', () => {
    if (!_cijPauseOnHover) return;
    const v = _cijVideo();
    if (v && !v.paused) {
      v.pause();
      _cijPausedByHover = true;
      v.addEventListener('play', _cijOnVideoPlay);
    }
  });
  const _cijHoverResume = () => {
    const v = _cijVideo();
    if (v) v.removeEventListener('play', _cijOnVideoPlay);
    _cijPausedByHover = false;
    v?.play().catch(() => {});
  };

  _cijSubOverlay.addEventListener('mouseleave', () => {
    if (!_cijPausedByHover) return;
    if (_hoverPinned) return; // tooltip is open — defer resume until tooltip closes
    _cijHoverResume();
  });
  document.addEventListener('mc-tooltip-closed', () => {
    if (!_cijPausedByHover) return;
    if (_cijSubOverlay?.matches(':hover')) return; // mouse is still on overlay
    _cijHoverResume();
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
  const wrap = _cijSubOverlay?.querySelector(':scope > span');
  if (wrap) wrap.style.color = _cijUnknownOnly ? 'transparent' : '#fff';
  for (const span of (_cijSubOverlay?.querySelectorAll('.jp-tok') || [])) {
    const known = _hoverVocab.has(span.dataset.basic) || _hoverVocab.has(span.dataset.word);
    span.style.color = known ? '#66AAE8' : (_cijColorblind ? '#FDC281' : '#ED7989');
    span.style.display = (_cijUnknownOnly && known) ? 'none' : '';
  }
}

function _cijParseVTTCues(vtt) {
  const toMs = str => {
    const s = str.trim().split(/\s/)[0].replace(/,/, '.');
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
    const ms = video.currentTime * 1000 + _cijSubDelay;
    let idx = -1;
    for (let i = 0; i < _cijCues.length; i++) {
      if (ms >= _cijCues[i].start && ms < _cijCues[i].end) { idx = i; break; }
    }
    const prevIdx = _cijLastCueIdx;
    if (idx === _cijLastCueIdx) return;
    _cijLastCueIdx = idx;

    _cijSubOverlay.innerHTML = '';
    if (idx < 0) {
      if (_cijAutoPause && prevIdx >= 0) video.pause();
      return;
    }

    const wrap = document.createElement('span');
    const _cijT = _cijOutlineThickness;
    const _wrapBg = _cijSubStyle === 'outline'
      ? `background:transparent;text-shadow:-${_cijT}px -${_cijT}px ${_cijT*2}px #000,${_cijT}px -${_cijT}px ${_cijT*2}px #000,-${_cijT}px ${_cijT}px ${_cijT*2}px #000,${_cijT}px ${_cijT}px ${_cijT*2}px #000`
      : `background:rgba(0,0,0,${_cijBgOpacity})`;
    wrap.style.cssText = [
      _wrapBg, 'color:#fff',
      'padding:5px 18px', 'border-radius:6px', 'display:inline-block',
      `font-size:${_cijFontSize}px`, `font-weight:${_cijFontWeight}`,
      `line-height:${_cijFurigana ? '2.4' : '1.6'}`,
      `max-width:${_cijSubMaxWidth}%`,
    ].join(';');
    wrap.textContent = _cijCues[idx].text;
    _cijSubOverlay.appendChild(wrap);
    await hoverRetokenize(_cijSubOverlay);
    if (_cijFurigana) hoverApplyFurigana(_cijSubOverlay);
    _cijSubOverlay.style.setProperty('--mc-rt-opacity', _cijFuriganaOpacity);
    _cijRecolorOverlay();
  };

  video.addEventListener('timeupdate', handler);
  return () => video.removeEventListener('timeupdate', handler);
}

function _cijReposSettingsPnl() {
  if (!_cijSettingsPnl || !_cijControlBar) return;
  const r = _cijControlBar.getBoundingClientRect();
  _cijSettingsPnl.style.top  = (r.bottom + 6) + 'px';
  _cijSettingsPnl.style.left = r.left + 'px';
}

function _cijToggleSettings(_player) {
  if (_cijSettingsPnl) {
    const opening = _cijSettingsPnl.style.display === 'none';
    _cijSettingsPnl.style.display = opening ? 'block' : 'none';
    if (opening) _cijReposSettingsPnl();
    return;
  }

  const pnl = document.createElement('div');
  pnl.id = 'mc-cij-settings';
  // Attach to body so the CIJ site's inherited CSS (font scaling, button resets,
  // container zoom) cannot affect our panel's appearance.
  pnl.style.cssText = [
    'position:fixed', 'z-index:2147483647',
    'background:rgba(22,24,28,.97)', 'border:1px solid #404550',
    'border-radius:10px', 'padding:14px 16px 0',
    'color:#d0d4e0', 'font-size:13px', 'font-family:-apple-system,sans-serif',
    'white-space:nowrap', 'width:300px',
    'box-shadow:0 8px 24px rgba(0,0,0,.7)',
    'line-height:normal', 'box-sizing:border-box',
    'display:flex', 'flex-direction:column',
    'max-height:min(520px,calc(90vh - 60px))', 'overflow:hidden',
  ].join(';');

  // Header row with close button
  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-shrink:0';
  const hdrTitle = document.createElement('span');
  hdrTitle.style.cssText = 'font-size:12px;font-weight:700;color:#d0d4e0;letter-spacing:.3px;text-transform:uppercase';
  hdrTitle.textContent = 'Subtitle settings';
  const hdrClose = document.createElement('button');
  hdrClose.textContent = '✕';
  hdrClose.style.cssText = 'background:none;border:none;color:#888;font-size:14px;cursor:pointer;padding:0 0 0 12px;line-height:1';
  hdrClose.addEventListener('click', e => { e.stopPropagation(); pnl.style.display = 'none'; });
  hdr.appendChild(hdrTitle); hdr.appendChild(hdrClose); pnl.appendChild(hdr);

  // ── Tab bar ───────────────────────────────────────────────
  const _secs = ['Style', 'Layout', 'Playback'].map(() => document.createElement('div'));
  let _activeTab = 0;
  const _tabBase = 'background:none;border:none;border-radius:0;padding:7px 0;flex:1;cursor:pointer;font-size:11px;font-weight:700;font-family:-apple-system,sans-serif;line-height:normal;box-sizing:border-box;margin-bottom:-1px;letter-spacing:.4px;text-transform:uppercase;transition:color .15s,border-color .15s';
  const _tabOn  = `color:#66AAE8;border-bottom:2px solid #66AAE8;${_tabBase}`;
  const _tabOff = `color:#808898;border-bottom:2px solid transparent;${_tabBase}`;
  const tabBar = document.createElement('div');
  tabBar.style.cssText = 'display:flex;gap:0;margin-bottom:16px;border-bottom:1px solid #404550;flex-shrink:0';
  const _tabBtns = ['Style', 'Layout', 'Playback'].map((label, i) => {
    const btn = document.createElement('button');
    btn.textContent = label; btn.style.cssText = i === 0 ? _tabOn : _tabOff;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _secs[_activeTab].style.display = 'none'; _tabBtns[_activeTab].style.cssText = _tabOff;
      _activeTab = i; _secs[i].style.display = 'block'; _tabBtns[i].style.cssText = _tabOn;
    });
    tabBar.appendChild(btn); return btn;
  });
  pnl.appendChild(tabBar);
  const _content = document.createElement('div');
  _content.style.cssText = 'overflow-y:auto;flex:1;min-height:0;padding-bottom:14px';
  _secs.forEach((s, i) => { s.style.display = i === 0 ? 'block' : 'none'; _content.appendChild(s); });
  pnl.appendChild(_content);

  let _cur = _secs[0];
  const _btnBase = 'flex:1;border-radius:6px;cursor:pointer;line-height:normal;font-family:-apple-system,sans-serif;box-sizing:border-box;transition:all .15s';
  function _lbl(text) {
    const el = document.createElement('div');
    el.style.cssText = 'font-size:11px;color:#aab0bc;margin-bottom:7px;letter-spacing:.4px;text-transform:uppercase';
    el.textContent = text; _cur.appendChild(el);
  }
  function _row(gap, mb) {
    const row = document.createElement('div');
    row.style.cssText = `display:flex;gap:${gap}px;margin-bottom:${mb}px`;
    _cur.appendChild(row); return row;
  }
  function _active(on) {
    return [`background:${on ? 'rgba(102,170,232,.2)' : 'rgba(255,255,255,.06)'}`, `color:${on ? '#66AAE8' : '#a0a8b8'}`, `border:1px solid ${on ? '#66AAE8' : '#3a3f4a'}`].join(';');
  }
  if (!document.getElementById('mc-sw-style')) {
    const _ss = document.createElement('style'); _ss.id = 'mc-sw-style';
    _ss.textContent = `.mc-sw{display:inline-flex;position:relative;width:36px;height:20px;cursor:pointer}.mc-sw input{opacity:0;width:0;height:0;position:absolute}.mc-sw-track{position:absolute;inset:0;border-radius:10px;background:rgba(255,255,255,.08);border:1px solid #3a3f4a;transition:background .2s,border-color .2s}.mc-sw-track::before{content:'';position:absolute;width:14px;height:14px;border-radius:50%;left:2px;top:2px;background:#6a7080;transition:transform .2s,background .2s}.mc-sw input:checked+.mc-sw-track{background:#66AAE8;border-color:#66AAE8}.mc-sw input:checked+.mc-sw-track::before{transform:translateX(16px);background:#fff}`;
    document.head.appendChild(_ss);
  }
  function _mkSw(checked, onChange) {
    const lbl = document.createElement('label'); lbl.className = 'mc-sw';
    const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = checked;
    const trk = document.createElement('span'); trk.className = 'mc-sw-track';
    inp.addEventListener('change', e => { e.stopPropagation(); onChange(inp.checked); });
    lbl.append(inp, trk); return lbl;
  }
  function _swRow(text, checked, mb, onChange) {
    const row = document.createElement('div');
    row.style.cssText = `display:flex;align-items:center;justify-content:space-between;margin-bottom:${mb}px`;
    const sp = document.createElement('span'); sp.style.cssText = 'font-size:12px;color:#a0a8b8;font-weight:600'; sp.textContent = text;
    const sw = _mkSw(checked, onChange);
    row.append(sp, sw); _cur.appendChild(row); return sw;
  }

  // ═══ Style tab ═══════════════════════════════════════════
  _cur = _secs[0];

  _lbl('Font size');
  const fsRow = _row(6, 14);
  _CIJ_FONT_SIZES.forEach((sz, i) => {
    const btn = document.createElement('button');
    btn.dataset.sz = sz; btn.textContent = i + 1;
    btn.style.cssText = `padding:7px 4px;font-size:13px;font-weight:600;${_btnBase};${_active(sz === _cijFontSize)}`;
    btn.addEventListener('click', e => {
      e.stopPropagation(); _cijFontSize = sz;
      fsRow.querySelectorAll('[data-sz]').forEach(b => { b.style.cssText = `padding:7px 4px;font-size:13px;font-weight:600;${_btnBase};${_active(+b.dataset.sz === _cijFontSize)}`; });
      const w = _cijSubOverlay?.querySelector('span'); if (w) w.style.fontSize = `${_cijFontSize}px`;
      _cijSaveSettings();
    });
    fsRow.appendChild(btn);
  });

  _lbl('Font weight');
  const fwRow = _row(6, 14);
  _CIJ_FONT_WEIGHTS.forEach(({ label, value }) => {
    const btn = document.createElement('button');
    btn.dataset.fw = value; btn.textContent = label;
    btn.style.cssText = `padding:7px 4px;font-size:12px;font-weight:${value};${_btnBase};${_active(value === _cijFontWeight)}`;
    btn.addEventListener('click', e => {
      e.stopPropagation(); _cijFontWeight = value;
      fwRow.querySelectorAll('[data-fw]').forEach(b => { b.style.cssText = `padding:7px 4px;font-size:12px;font-weight:${b.dataset.fw};${_btnBase};${_active(+b.dataset.fw === _cijFontWeight)}`; });
      const w = _cijSubOverlay?.querySelector('span'); if (w) w.style.fontWeight = `${_cijFontWeight}`;
      _cijSaveSettings();
    });
    fwRow.appendChild(btn);
  });

  _lbl('Color mode');
  const cmRow = _row(6, 6);
  [{ label: 'Blue / Red', cb: false }, { label: 'Blue / Orange', cb: true }].forEach(({ label, cb }) => {
    const btn = document.createElement('button');
    btn.dataset.cb = cb; btn.textContent = label;
    btn.style.cssText = `padding:7px 4px;font-size:12px;font-weight:600;${_btnBase};${_active(cb === _cijColorblind)}`;
    btn.addEventListener('click', e => {
      e.stopPropagation(); _cijColorblind = cb;
      cmRow.querySelectorAll('[data-cb]').forEach(b => { b.style.cssText = `padding:7px 4px;font-size:12px;font-weight:600;${_btnBase};${_active((b.dataset.cb === 'true') === _cijColorblind)}`; });
      _cijRecolorOverlay(); _cijLastCueIdx = -2; _cijSaveSettings();
    });
    cmRow.appendChild(btn);
  });
  const cmHint = document.createElement('div');
  cmHint.style.cssText = 'font-size:11px;color:#6a7080;margin-top:5px;margin-bottom:14px';
  cmHint.textContent = 'Blue = known · Red/Orange = unknown';
  _cur.appendChild(cmHint);

  _lbl('Style');
  let _cijBgSection, _cijOtSection;
  const stRow = _row(6, 0);
  [{ label: 'Box', val: 'box' }, { label: 'Outline', val: 'outline' }].forEach(({ label, val }) => {
    const btn = document.createElement('button');
    btn.dataset.st = val; btn.textContent = label;
    btn.style.cssText = `padding:7px 4px;font-size:12px;font-weight:600;${_btnBase};${_active(val === _cijSubStyle)}`;
    btn.addEventListener('click', e => {
      e.stopPropagation(); _cijSubStyle = val;
      stRow.querySelectorAll('[data-st]').forEach(b => { b.style.cssText = `padding:7px 4px;font-size:12px;font-weight:600;${_btnBase};${_active(b.dataset.st === _cijSubStyle)}`; });
      _cijBgSection.style.display = val === 'box' ? 'block' : 'none';
      _cijOtSection.style.display = val === 'outline' ? 'block' : 'none';
      _cijLastCueIdx = -2; _cijSaveSettings();
    });
    stRow.appendChild(btn);
  });

  const _sLbl = 'font-size:11px;color:#aab0bc;margin:10px 0 6px;letter-spacing:.4px;text-transform:uppercase';
  const _sRow = 'display:flex;align-items:center;gap:10px';
  const _sVal = 'font-size:12px;color:#66AAE8;min-width:34px;text-align:right';

  _cijBgSection = document.createElement('div');
  _cijBgSection.style.display = _cijSubStyle === 'box' ? 'block' : 'none';
  const bgLblEl = document.createElement('div'); bgLblEl.style.cssText = _sLbl; bgLblEl.textContent = 'Background opacity'; _cijBgSection.appendChild(bgLblEl);
  const bgRow = document.createElement('div'); bgRow.style.cssText = _sRow;
  const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.value = Math.round(_cijBgOpacity * 100); slider.style.cssText = 'flex:1;cursor:pointer;accent-color:#66AAE8';
  const bgVal = document.createElement('span'); bgVal.style.cssText = _sVal; bgVal.textContent = `${slider.value}%`;
  slider.addEventListener('click', e => e.stopPropagation());
  slider.addEventListener('input', e => { e.stopPropagation(); _cijBgOpacity = slider.value / 100; bgVal.textContent = `${slider.value}%`; const w = _cijSubOverlay?.querySelector('span'); if (w) w.style.background = `rgba(0,0,0,${_cijBgOpacity})`; _cijSaveSettings(); });
  bgRow.appendChild(slider); bgRow.appendChild(bgVal); _cijBgSection.appendChild(bgRow); _cur.appendChild(_cijBgSection);

  _cijOtSection = document.createElement('div');
  _cijOtSection.style.display = _cijSubStyle === 'outline' ? 'block' : 'none';
  const otLblEl = document.createElement('div'); otLblEl.style.cssText = _sLbl; otLblEl.textContent = 'Outline thickness'; _cijOtSection.appendChild(otLblEl);
  const otRow = document.createElement('div'); otRow.style.cssText = _sRow;
  const otSlider = document.createElement('input'); otSlider.type = 'range'; otSlider.min = '1'; otSlider.max = '5'; otSlider.step = '1'; otSlider.value = _cijOutlineThickness; otSlider.style.cssText = 'flex:1;cursor:pointer;accent-color:#66AAE8';
  const otVal = document.createElement('span'); otVal.style.cssText = _sVal; otVal.textContent = `${_cijOutlineThickness}px`;
  otSlider.addEventListener('click', e => e.stopPropagation());
  otSlider.addEventListener('input', e => { e.stopPropagation(); _cijOutlineThickness = +otSlider.value; otVal.textContent = `${_cijOutlineThickness}px`; const w = _cijSubOverlay?.querySelector('span'); if (w && _cijSubStyle === 'outline') { const t = _cijOutlineThickness; w.style.textShadow = `-${t}px -${t}px ${t*2}px #000,${t}px -${t}px ${t*2}px #000,-${t}px ${t}px ${t*2}px #000,${t}px ${t}px ${t*2}px #000`; } _cijLastCueIdx = -2; _cijSaveSettings(); });
  otRow.appendChild(otSlider); otRow.appendChild(otVal); _cijOtSection.appendChild(otRow); _cur.appendChild(_cijOtSection);

  // ── Furigana ──────────────────────────────────────────────
  _lbl('Furigana');
  const fgRow = document.createElement('div');
  fgRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:14px';
  fgRow.appendChild(_mkSw(_cijFurigana, v => { _cijFurigana = v; _cijLastCueIdx = -2; _cijSaveSettings(); }));
  const fgOpSl = document.createElement('input'); fgOpSl.type = 'range'; fgOpSl.min = '10'; fgOpSl.max = '100'; fgOpSl.step = '5'; fgOpSl.value = Math.round(_cijFuriganaOpacity * 100); fgOpSl.style.cssText = 'flex:1;cursor:pointer;accent-color:#66AAE8';
  const fgOpVal = document.createElement('span'); fgOpVal.style.cssText = 'font-size:12px;color:#66AAE8;min-width:34px;text-align:right'; fgOpVal.textContent = `${fgOpSl.value}%`;
  fgOpSl.addEventListener('click', e => e.stopPropagation());
  fgOpSl.addEventListener('input', e => {
    e.stopPropagation(); _cijFuriganaOpacity = fgOpSl.value / 100; fgOpVal.textContent = `${fgOpSl.value}%`;
    _cijSubOverlay?.style.setProperty('--mc-rt-opacity', _cijFuriganaOpacity); _cijSaveSettings();
  });
  fgRow.append(fgOpSl, fgOpVal); _cur.appendChild(fgRow);

  // ═══ Layout tab ══════════════════════════════════════════
  _cur = _secs[1];

  _lbl('Vertical position');
  const vpRow = document.createElement('div');
  vpRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:14px';
  const vpSlider = document.createElement('input');
  vpSlider.type = 'range'; vpSlider.min = '2'; vpSlider.max = '80'; vpSlider.step = '1';
  vpSlider.value = _cijSubPosition;
  vpSlider.style.cssText = 'flex:1;cursor:pointer;accent-color:#66AAE8';
  vpSlider.addEventListener('click', e => e.stopPropagation());
  const vpVal = document.createElement('span');
  vpVal.style.cssText = 'font-size:12px;color:#66AAE8;min-width:34px;text-align:right';
  vpVal.textContent = `${_cijSubPosition}%`;
  vpSlider.addEventListener('input', e => {
    e.stopPropagation();
    _cijSubPosition = +vpSlider.value; vpVal.textContent = `${_cijSubPosition}%`;
    if (_cijSubOverlay) _cijSubOverlay.style.bottom = `${_cijSubPosition}%`;
    _cijSaveSettings();
  });
  vpRow.appendChild(vpSlider); vpRow.appendChild(vpVal); _cur.appendChild(vpRow);

  _lbl('Max width');
  const mwRow = document.createElement('div');
  mwRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:0';
  const mwSlider = document.createElement('input');
  mwSlider.type = 'range'; mwSlider.min = '30'; mwSlider.max = '100'; mwSlider.step = '5';
  mwSlider.value = _cijSubMaxWidth;
  mwSlider.style.cssText = 'flex:1;cursor:pointer;accent-color:#66AAE8';
  mwSlider.addEventListener('click', e => e.stopPropagation());
  const mwVal = document.createElement('span');
  mwVal.style.cssText = 'font-size:12px;color:#66AAE8;min-width:34px;text-align:right';
  mwVal.textContent = `${_cijSubMaxWidth}%`;
  mwSlider.addEventListener('input', e => {
    e.stopPropagation();
    _cijSubMaxWidth = +mwSlider.value; mwVal.textContent = `${_cijSubMaxWidth}%`;
    if (_cijSubOverlay) { const w = _cijSubOverlay.querySelector('span'); if (w) w.style.maxWidth = `${_cijSubMaxWidth}%`; }
    _cijSaveSettings();
  });
  mwRow.appendChild(mwSlider); mwRow.appendChild(mwVal); _cur.appendChild(mwRow);

  // ═══ Playback tab ════════════════════════════════════════
  _cur = _secs[2];

  _swRow('Pause on hover', _cijPauseOnHover, 4, v => {
    _cijPauseOnHover = v;
    if (!v && _cijPausedByHover) { _cijPausedByHover = false; document.querySelector('video')?.play().catch(() => {}); }
    _cijSaveSettings();
  });
  const phHint = document.createElement('div');
  phHint.style.cssText = 'font-size:11px;color:#6a7080;margin-top:-2px;margin-bottom:14px';
  phHint.textContent = 'Pauses playback while hovering a subtitle';
  _cur.appendChild(phHint);

  _lbl('Subtitle delay');
  const dlRow = _row(6, 14);
  const dlMinus = document.createElement('button');
  dlMinus.textContent = '−'; dlMinus.style.cssText = `padding:5px 10px;font-size:16px;font-weight:700;${_btnBase};${_active(false)}`;
  const dlPlus = document.createElement('button');
  dlPlus.textContent = '+'; dlPlus.style.cssText = dlMinus.style.cssText;
  const dlVal = document.createElement('span');
  dlVal.style.cssText = 'flex:1;text-align:center;font-size:13px;color:#66AAE8;font-weight:600';
  const _dlFmt = v => v === 0 ? '0.0s' : (v > 0 ? `+${(v/1000).toFixed(1)}s` : `${(v/1000).toFixed(1)}s`);
  dlVal.textContent = _dlFmt(_cijSubDelay);
  dlMinus.addEventListener('click', e => { e.stopPropagation(); _cijSubDelay = Math.max(-5000, _cijSubDelay - 100); dlVal.textContent = _dlFmt(_cijSubDelay); _cijLastCueIdx = -2; _cijSaveSettings(); });
  dlPlus.addEventListener('click',  e => { e.stopPropagation(); _cijSubDelay = Math.min(5000,  _cijSubDelay + 100); dlVal.textContent = _dlFmt(_cijSubDelay); _cijLastCueIdx = -2; _cijSaveSettings(); });
  dlRow.appendChild(dlMinus); dlRow.appendChild(dlVal); dlRow.appendChild(dlPlus);
  const dlHint = document.createElement('div');
  dlHint.style.cssText = 'font-size:11px;color:#6a7080;margin-top:-10px;margin-bottom:14px';
  dlHint.textContent = 'Steps of 0.1s — shift subtitles earlier (−) or later (+)';
  _cur.appendChild(dlHint);

  _swRow('Auto-pause at cue end', _cijAutoPause, 4, v => { _cijAutoPause = v; _cijSaveSettings(); });
  const apHint = document.createElement('div');
  apHint.style.cssText = 'font-size:11px;color:#6a7080;margin-top:-2px;margin-bottom:14px';
  apHint.textContent = 'Pauses at the end of each subtitle cue';
  _cur.appendChild(apHint);

  _swRow('Unknown words only', _cijUnknownOnly, 4, v => { _cijUnknownOnly = v; _cijRecolorOverlay(); _cijSaveSettings(); });
  const uoHint = document.createElement('div');
  uoHint.style.cssText = 'font-size:11px;color:#6a7080;margin-top:-2px';
  uoHint.textContent = 'Hides known words, shows only unknowns';
  _cur.appendChild(uoHint);

  document.body.appendChild(pnl);
  _cijSettingsPnl = pnl;
  _cijReposSettingsPnl();
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
  scoreEl.style.cssText = 'padding:9px 10px;font-size:13px;font-weight:700;color:#fff;border-right:1px solid rgba(255,255,255,.12);display:flex;align-items:center';
  scoreEl.textContent = score !== null ? `${score}%` : '–';
  bar.appendChild(scoreEl);

  // 字幕 button
  _cijSubBtn = document.createElement('button');
  _cijSubBtn.id = 'mc-cij-btn';
  _cijSubBtn.textContent = '字幕';
  _cijSubBtn.style.cssText = 'padding:9px 10px;font-size:13px;font-weight:600;color:#888;background:none;border:none;border-right:1px solid rgba(255,255,255,.12);cursor:pointer;letter-spacing:.3px;transition:color .15s';
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
      if (!_transcriptHoverActive) hoverDisable();
    } else {
      _cijEnsureOverlay(player);
      if (!_hoverEnabled) await hoverEnable(() => _cijSubOverlay);
      _cijSubCleanup?.(); _cijSubCleanup = _cijStartTimeSync();
      _cijSetSubActive(true);
    }
  });
  bar.appendChild(_cijSubBtn);

  // ⚙ settings button
  _cijSettingsBtn = document.createElement('button');
  _cijSettingsBtn.id = 'mc-cij-settings-btn';
  _cijSettingsBtn.textContent = '⚙';
  _cijSettingsBtn.style.cssText = 'padding:9px 8px;font-size:12px;color:#888;background:none;border:none;cursor:pointer;display:none';
  _cijSettingsBtn.addEventListener('click', e => { e.stopPropagation(); _cijToggleSettings(player); });
  bar.appendChild(_cijSettingsBtn);

  // ⛶ fullscreen button
  const fsBtn = document.createElement('button');
  fsBtn.id = 'mc-cij-fs-btn';
  fsBtn.title = 'Fullscreen';
  fsBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor"><path d="M0 0h4v1.5H1.5V4H0zm9 0h4v4h-1.5V1.5H9zM0 9h1.5v2.5H4V13H0zm11.5 2.5V9H13v4H9v-1.5z"/></svg>';
  fsBtn.style.cssText = 'padding:9px 10px;color:#888;background:none;border:none;border-left:1px solid rgba(255,255,255,.12);cursor:pointer;display:flex;align-items:center';
  fsBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else player.requestFullscreen().catch(() => {});
  });
  bar.appendChild(fsBtn);

  // Transparent overlay over the native fullscreen button (bottom-right of video).
  // Intercepts the click so the wrap—not the bare video—goes fullscreen.
  const fsOverlay = document.createElement('div');
  fsOverlay.style.cssText = 'position:absolute;bottom:0;right:0;width:60px;height:60px;z-index:9998;cursor:pointer;';
  fsOverlay.title = 'Fullscreen';
  fsOverlay.addEventListener('click', e => {
    e.stopPropagation();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else player.requestFullscreen().catch(() => {});
  });
  player.appendChild(fsOverlay);

  // F key shortcut
  document.addEventListener('keydown', e => {
    if ((e.key === 'f' || e.key === 'F') && !e.target.matches('input,textarea')) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else player.requestFullscreen().catch(() => {});
    }
  });

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
    chrome.storage.local.get('videoToolEnabled', ({ videoToolEnabled }) => {
      if (videoToolEnabled === false && _cijControlBar) _cijControlBar.style.display = 'none';
    });
  } else if (video) {
    showBadge(video.parentElement || document.body, res?.score ?? null, { top: '12px', left: '12px' });
  }
  return res;
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === 'enableHover') {
    _transcriptHoverActive = true;
    hoverEnable(cijFindTranscriptElement).then(reply); return true;
  }
  if (msg.action === 'disableHover') {
    _transcriptHoverActive = false;
    // Only fully tear down hover if subtitle overlay is not running;
    // otherwise the overlay still needs hover.js for tokenization + tooltips.
    if (!_cijSubCleanup) hoverDisable();
    reply({ ok: true }); return;
  }
  if (msg.action === 'hoverStatus') {
    reply({ enabled: _transcriptHoverActive }); return;
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
  if (msg.action === 'videoToolStatus') {
    reply({ enabled: !!_cijControlBar && _cijControlBar.style.display !== 'none' }); return;
  }
  if (msg.action === 'disableVideoTool') {
    _cijSubCleanup?.(); _cijSubCleanup = null;
    if (_cijSubOverlay) _cijSubOverlay.innerHTML = '';
    if (_cijSettingsPnl) _cijSettingsPnl.style.display = 'none';
    if (_cijControlBar) _cijControlBar.style.display = 'none';
    _cijCues = null; _cijLastCueIdx = -2;
    _cijSetSubActive(false);
    // Only fully disable hover if transcript hover is also off.
    if (!_transcriptHoverActive) hoverDisable();
    chrome.storage.local.set({ videoToolEnabled: false });
    reply({ ok: true }); return;
  }
  if (msg.action === 'enableVideoTool') {
    if (_cijControlBar) { _cijControlBar.style.display = 'inline-flex'; }
    else { const p = _cijGetPlayer(); if (p) _cijCreateControlBar(p, null); }
    chrome.storage.local.set({ videoToolEnabled: true });
    _cijVttCache = null; scanPage();
    reply({ ok: true }); return;
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

document.addEventListener('mc-word-marked-known', () => {
  _cijRecolorOverlay();
});

// Auto-score on load
scanPage();

// Re-tokenize transcript panel when it fills in dynamically
new MutationObserver(() => {
  if (_transcriptHoverActive) {
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
  } else if (!fs) {
    wrap.style.cssText = 'position:relative;display:block;width:100%;line-height:0;';
    if (video) { video.style.maxWidth = ''; video.style.maxHeight = ''; }
    if (fsBtn) fsBtn.title = 'Fullscreen';
    for (const id of ['jp-hover-tip', 'jp-sidebar']) {
      const el = document.getElementById(id); if (el) document.body.appendChild(el);
    }
  }
});
