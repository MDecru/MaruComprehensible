// MaruComprehension — Local video player page

const video      = document.getElementById('video');
const dropzone   = document.getElementById('dropzone');
const playerWrap = document.getElementById('player-wrap');
const subOverlay = document.getElementById('sub-overlay');
const scoreEl    = document.getElementById('score-el');
const subBtn     = document.getElementById('sub-btn');
const sidebarBtn = document.getElementById('sidebar-btn');
const settingsBtn= document.getElementById('settings-btn');
const settingsPnl= document.getElementById('settings-pnl');
const loading    = document.getElementById('loading');

let _vtt = null;          // raw VTT text
let _cues = [];           // [{start, end, text}]
let _subActive = false;
let _subCleanup = null;
let _lastCueIdx = -2;
let _pausedByHover = false;

// Settings shared with YouTube player
let _fontSize = 20, _bgOpacity = 0.78, _fontWeight = 400;
let _colorblind = false, _pauseOnHover = false;
let _subPosition = 12;
let _subDelay    = 0;
let _subStyle    = 'box';
let _subMaxWidth = 90;
let _autoPause        = false;
let _unknownOnly      = false;
let _outlineThickness = 1;
let _furigana         = false;

const FONT_SIZES   = [20, 28, 36, 46];
const FONT_WEIGHTS = [{ label: 'Normal', value: 400 }, { label: 'Medium', value: 600 }, { label: 'Bold', value: 700 }];

chrome.storage.local.get('yt_sub_settings', ({ yt_sub_settings: s }) => {
  if (!s) return;
  if (s.fontSize    !== undefined) _fontSize    = s.fontSize;
  if (s.bgOpacity   !== undefined) _bgOpacity   = s.bgOpacity;
  if (s.fontWeight  !== undefined) _fontWeight  = s.fontWeight;
  if (s.colorblind  !== undefined) _colorblind  = s.colorblind;
  if (s.pauseOnHover !== undefined) _pauseOnHover = s.pauseOnHover;
  if (s.subPosition  !== undefined) _subPosition  = s.subPosition;
  if (s.subDelay     !== undefined) _subDelay      = s.subDelay;
  if (s.subStyle     !== undefined) _subStyle      = s.subStyle;
  if (s.subMaxWidth  !== undefined) _subMaxWidth   = s.subMaxWidth;
  if (s.autoPause    !== undefined) _autoPause     = s.autoPause;
  if (s.unknownOnly        !== undefined) _unknownOnly      = s.unknownOnly;
  if (s.outlineThickness   !== undefined) _outlineThickness = s.outlineThickness;
  if (s.furigana           !== undefined) _furigana         = s.furigana;
  subOverlay.style.bottom = _subPosition + '%';
});

function _saveSettings() {
  chrome.storage.local.set({ yt_sub_settings: {
    fontSize: _fontSize, bgOpacity: _bgOpacity, fontWeight: _fontWeight,
    colorblind: _colorblind, pauseOnHover: _pauseOnHover,
    subPosition: _subPosition, subDelay: _subDelay, subStyle: _subStyle, subMaxWidth: _subMaxWidth, autoPause: _autoPause, unknownOnly: _unknownOnly,
    outlineThickness: _outlineThickness, furigana: _furigana,
  }});
}

// ── SRT → VTT conversion ──────────────────────────────────────────────────────

function _srtToVtt(srt) {
  const lines = srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let out = 'WEBVTT\n\n';
  let inCue = false;
  for (const line of lines) {
    const ts = line.match(/^(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/);
    if (ts) {
      out += `${ts[1]}.${ts[2]} --> ${ts[3]}.${ts[4]}\n`;
      inCue = true;
    } else if (/^\d+$/.test(line.trim()) && !inCue) {
      // sequence number — skip
    } else if (line.trim() === '') {
      out += '\n';
      inCue = false;
    } else {
      out += line + '\n';
    }
  }
  return out;
}

// ── VTT cue parser (ms) ───────────────────────────────────────────────────────

function _parseCues(vtt) {
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

// ── Subtitle time sync ────────────────────────────────────────────────────────

function _startTimeSync() {
  _lastCueIdx = -2;
  const handler = async () => {
    if (!_cues.length || !subOverlay) return;
    const ms = video.currentTime * 1000 + _subDelay;
    let idx = -1;
    for (let i = 0; i < _cues.length; i++) {
      if (ms >= _cues[i].start && ms < _cues[i].end) { idx = i; break; }
    }
    const prevIdx = _lastCueIdx;
    if (idx === _lastCueIdx) return;
    _lastCueIdx = idx;

    subOverlay.innerHTML = '';
    if (idx < 0) {
      if (_autoPause && prevIdx >= 0) video.pause();
      return;
    }

    const wrap = document.createElement('span');
    const _pT = _outlineThickness;
    const _wrapBg = _subStyle === 'outline'
      ? `background:transparent;text-shadow:-${_pT}px -${_pT}px ${_pT*2}px #000,${_pT}px -${_pT}px ${_pT*2}px #000,-${_pT}px ${_pT}px ${_pT*2}px #000,${_pT}px ${_pT}px ${_pT*2}px #000`
      : `background:rgba(0,0,0,${_bgOpacity})`;
    wrap.style.cssText = [
      _wrapBg, 'color:#fff',
      'padding:5px 18px', 'border-radius:6px', 'display:inline-block',
      `font-size:${_fontSize}px`, `font-weight:${_fontWeight}`,
      `line-height:${_furigana ? '2.4' : '1.6'}`,
      `max-width:${_subMaxWidth}%`,
    ].join(';');
    wrap.textContent = _cues[idx].text;
    subOverlay.appendChild(wrap);
    await hoverRetokenize(subOverlay);
    if (_furigana) hoverApplyFurigana(subOverlay);
    _recolorOverlay();
  };
  video.addEventListener('timeupdate', handler);
  return () => video.removeEventListener('timeupdate', handler);
}

function _recolorOverlay() {
  if (!_hoverVocab) return;
  const wrap = subOverlay.querySelector(':scope > span');
  if (wrap) wrap.style.color = _unknownOnly ? 'transparent' : '#fff';
  for (const span of subOverlay.querySelectorAll('.jp-tok')) {
    const known = _hoverVocab.has(span.dataset.basic) || _hoverVocab.has(span.dataset.word);
    span.style.color = known ? '#66AAE8' : (_colorblind ? '#FDC281' : '#ED7989');
    span.style.display = (_unknownOnly && known) ? 'none' : '';
  }
}

function _setSubActive(on) {
  subBtn.classList.toggle('active', on);
  settingsBtn.classList.toggle('visible', on);
}

// ── Load a video + optional VTT ──────────────────────────────────────────────

async function loadVideo(file) {
  const url = URL.createObjectURL(file);
  video.src = url;
  video.load();
  dropzone.classList.add('hidden');
  playerWrap.classList.add('visible');
  document.title = file.name.replace(/\.[^.]+$/, '') + ' — MaruComprehension';

  // Stop subtitles for the old video
  _subCleanup?.(); _subCleanup = null;
  _subActive = false;
  _cues = [];
  _vtt = null;
  subOverlay.innerHTML = '';
  _setSubActive(false);
  scoreEl.textContent = '–';
  if (sidebarIsOpen()) sidebarToggle(null);
}

async function loadSubtitle(file) {
  let text = await file.text();
  if (file.name.endsWith('.srt') || (!text.startsWith('WEBVTT') && text.match(/^\d+\s*\n/m))) {
    text = _srtToVtt(text);
  }
  if (!text.includes('-->')) { alert('Could not parse subtitle file.'); return; }

  _vtt = text;
  _cues = _parseCues(_vtt);

  loading.classList.add('visible');
  try {
    // Check vocab access before scoring so we can give a helpful error
    if (!chrome.runtime?.id) {
      scoreEl.textContent = '–';
      scoreEl.title = 'Extension was reloaded — please close and reopen this player tab';
      console.warn('[MaruComprehension] Extension context invalidated. Close this tab and reopen the local player from the extension popup.');
      loading.classList.remove('visible');
      return;
    }
    const vocab = await getVocab();
    if (!vocab.size) {
      scoreEl.textContent = '–';
      scoreEl.title = 'No MaruMori vocab loaded — open the extension popup and connect your account';
      console.warn('[MaruComprehension] Vocab is empty. Open the extension popup and connect your MaruMori account, then reload this page.');
      loading.classList.remove('visible');
      return;
    }

    const parsedText = parseVTT(_vtt);
    if (!parsedText.trim()) {
      scoreEl.textContent = '–';
      scoreEl.title = 'No Japanese text found in this subtitle file';
      console.warn('[MaruComprehension] parseVTT returned empty string — subtitle may be in an unsupported format or have no Japanese text.');
      loading.classList.remove('visible');
      return;
    }

    const res = await scoreVTT(_vtt);
    if (res?.score != null) {
      scoreEl.textContent = `${res.score}%`;
      scoreEl.title = `Frequency: ${res.freqKnown}/${res.freqTotal} · Unique: ${res.uniqueKnown}/${res.uniqueTotal} · Kanji: ${res.kanjiKnown}/${res.kanjiTotal}`;
    } else {
      scoreEl.textContent = '–';
      scoreEl.title = '';
    }
  } catch (e) {
    console.error('[MaruComprehension] Scoring error:', e);
    scoreEl.textContent = '?';
    scoreEl.title = e.message;
  }
  loading.classList.remove('visible');
}

// ── Drag & drop ──────────────────────────────────────────────────────────────

function _handleFiles(files) {
  const videoFile = [...files].find(f => f.type.startsWith('video/') || f.type.startsWith('audio/'));
  const subFile   = [...files].find(f => /\.(vtt|srt|ass)$/i.test(f.name));
  if (videoFile) loadVideo(videoFile);
  if (subFile)   loadSubtitle(subFile);
}

['dragenter','dragover'].forEach(evt =>
  document.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('drag-over'); })
);
['dragleave','drop'].forEach(evt =>
  document.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('drag-over'); })
);
document.addEventListener('drop', e => _handleFiles(e.dataTransfer.files));

document.getElementById('any-file').addEventListener('change', e => _handleFiles(e.target.files));

// ── Hover: pause on hover ────────────────────────────────────────────────────

subOverlay.addEventListener('mouseenter', () => {
  if (!_pauseOnHover) return;
  if (!video.paused) { video.pause(); _pausedByHover = true; }
});
subOverlay.addEventListener('mouseleave', () => {
  if (!_pausedByHover) return;
  _pausedByHover = false;
  video.play().catch(() => {});
});

// ── 字幕 button ───────────────────────────────────────────────────────────────

let _subLoading = false;
subBtn.addEventListener('click', async () => {
  if (_subLoading) return;
  if (!_vtt) { alert('No subtitle file loaded yet.'); return; }

  if (!_subActive) {
    _subLoading = true;
    subBtn.textContent = '…';
    if (!_hoverEnabled) await hoverEnable(() => subOverlay);
    _subCleanup?.(); _subCleanup = _startTimeSync();
    _subActive = true;
    _setSubActive(true);
    _subLoading = false;
    subBtn.textContent = '字幕';
  } else {
    _subCleanup?.(); _subCleanup = null;
    subOverlay.innerHTML = '';
    _subActive = false;
    _setSubActive(false);
  }
});

// ── Sidebar button ────────────────────────────────────────────────────────────

sidebarBtn.addEventListener('click', () => {
  if (!_vtt) { alert('No subtitle file loaded yet.'); return; }
  sidebarToggle(parseVTT(_vtt));
});

// ── Settings panel ────────────────────────────────────────────────────────────

settingsBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (settingsPnl.classList.contains('visible')) {
    settingsPnl.classList.remove('visible'); return;
  }
  _buildSettingsPanel();
  settingsPnl.classList.add('visible');
});
document.addEventListener('click', () => settingsPnl.classList.remove('visible'));
settingsPnl.addEventListener('click', e => e.stopPropagation());

let _curPnl = settingsPnl;
function _pnlLabel(text) {
  const el = document.createElement('div');
  el.className = 'pnl-label';
  el.textContent = text;
  _curPnl.appendChild(el);
}
function _pnlRow() {
  const row = document.createElement('div');
  row.className = 'pnl-row';
  _curPnl.appendChild(row);
  return row;
}
function _pnlBtn(label, active, onClick) {
  const btn = document.createElement('button');
  btn.className = 'pnl-btn' + (active ? ' on' : '');
  btn.textContent = label;
  btn.addEventListener('click', e => { e.stopPropagation(); onClick(btn); });
  return btn;
}
function _setRowActive(row, activeBtn) {
  row.querySelectorAll('.pnl-btn').forEach(b => b.classList.toggle('on', b === activeBtn));
}

function _buildSettingsPanel() {
  settingsPnl.innerHTML = '';

  // ── Tab bar ───────────────────────────────────────────────
  const _secs = ['Style', 'Layout', 'Playback'].map(() => document.createElement('div'));
  let _activeTab = 0;
  const _tBase = 'background:none;border:none;border-radius:0;padding:7px 0;flex:1;cursor:pointer;font-size:11px;font-weight:700;font-family:-apple-system,sans-serif;line-height:normal;box-sizing:border-box;margin-bottom:-1px;letter-spacing:.4px;text-transform:uppercase;transition:color .15s,border-color .15s';
  const _tabOn  = `color:#66AAE8;border-bottom:2px solid #66AAE8;${_tBase}`;
  const _tabOff = `color:#555;border-bottom:2px solid transparent;${_tBase}`;
  const tabBar = document.createElement('div');
  tabBar.style.cssText = 'display:flex;gap:0;margin-bottom:12px;border-bottom:1px solid #404550;flex-shrink:0';
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
  settingsPnl.appendChild(tabBar);
  const _content = document.createElement('div');
  _content.style.cssText = 'overflow-y:auto;flex:1;min-height:0;padding-bottom:14px';
  _secs.forEach((s, i) => { s.style.display = i === 0 ? 'block' : 'none'; _content.appendChild(s); });
  settingsPnl.appendChild(_content);

  // ═══ Style tab ═══════════════════════════════════════════
  _curPnl = _secs[0];

  _pnlLabel('Font size');
  const fsRow = _pnlRow();
  FONT_SIZES.forEach((sz, i) => {
    const btn = _pnlBtn(i + 1, sz === _fontSize, btn => {
      _fontSize = sz; _setRowActive(fsRow, btn);
      const w = subOverlay.querySelector('span'); if (w) w.style.fontSize = `${_fontSize}px`;
      _saveSettings();
    });
    fsRow.appendChild(btn);
  });

  _pnlLabel('Font weight');
  const fwRow = _pnlRow();
  FONT_WEIGHTS.forEach(({ label, value }) => {
    const btn = _pnlBtn(label, value === _fontWeight, btn => {
      _fontWeight = value; _setRowActive(fwRow, btn);
      const w = subOverlay.querySelector('span'); if (w) w.style.fontWeight = `${_fontWeight}`;
      _saveSettings();
    });
    fwRow.appendChild(btn);
  });

  _pnlLabel('Color mode');
  const cmRow = _pnlRow();
  [{ label: 'Blue / Red', cb: false }, { label: 'Blue / Orange', cb: true }].forEach(({ label, cb }) => {
    const btn = _pnlBtn(label, cb === _colorblind, btn => {
      _colorblind = cb; _setRowActive(cmRow, btn);
      _recolorOverlay(); _lastCueIdx = -2; _saveSettings();
    });
    cmRow.appendChild(btn);
  });
  const cmHint = document.createElement('div');
  cmHint.className = 'pnl-hint'; cmHint.style.marginBottom = '14px';
  cmHint.textContent = 'Blue = known · Red/Orange = unknown';
  _curPnl.appendChild(cmHint);

  _pnlLabel('Style');
  let _bgSection, _otSection;
  const stRow = _pnlRow();
  stRow.style.marginBottom = '0';
  [{ label: 'Box', val: 'box' }, { label: 'Outline', val: 'outline' }].forEach(({ label, val }) => {
    const btn = _pnlBtn(label, val === _subStyle, btn => {
      _subStyle = val; _setRowActive(stRow, btn);
      _bgSection.style.display = val === 'box' ? 'block' : 'none';
      _otSection.style.display = val === 'outline' ? 'block' : 'none';
      _lastCueIdx = -2; _saveSettings();
    });
    stRow.appendChild(btn);
  });

  _bgSection = document.createElement('div');
  _bgSection.style.display = _subStyle === 'box' ? 'block' : 'none';
  const bgLblEl = document.createElement('div'); bgLblEl.className = 'pnl-label'; bgLblEl.style.marginTop = '10px'; bgLblEl.textContent = 'Background opacity'; _bgSection.appendChild(bgLblEl);
  const bgRow = document.createElement('div'); bgRow.className = 'pnl-slider-row'; bgRow.style.marginBottom = '0';
  const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.value = Math.round(_bgOpacity * 100);
  const bgVal = document.createElement('span'); bgVal.className = 'pnl-val'; bgVal.textContent = `${slider.value}%`;
  slider.addEventListener('input', e => { e.stopPropagation(); _bgOpacity = slider.value / 100; bgVal.textContent = `${slider.value}%`; const w = subOverlay.querySelector('span'); if (w) w.style.background = `rgba(0,0,0,${_bgOpacity})`; _saveSettings(); });
  bgRow.appendChild(slider); bgRow.appendChild(bgVal); _bgSection.appendChild(bgRow); _curPnl.appendChild(_bgSection);

  _otSection = document.createElement('div');
  _otSection.style.display = _subStyle === 'outline' ? 'block' : 'none';
  const otLblEl = document.createElement('div'); otLblEl.className = 'pnl-label'; otLblEl.style.marginTop = '10px'; otLblEl.textContent = 'Outline thickness'; _otSection.appendChild(otLblEl);
  const otRow = document.createElement('div'); otRow.className = 'pnl-slider-row'; otRow.style.marginBottom = '0';
  const otSlider = document.createElement('input'); otSlider.type = 'range'; otSlider.min = '1'; otSlider.max = '5'; otSlider.step = '1'; otSlider.value = _outlineThickness;
  const otVal = document.createElement('span'); otVal.className = 'pnl-val'; otVal.textContent = `${_outlineThickness}px`;
  otSlider.addEventListener('input', e => { e.stopPropagation(); _outlineThickness = +otSlider.value; otVal.textContent = `${_outlineThickness}px`; const w = subOverlay.querySelector('span'); if (w && _subStyle === 'outline') { const t = _outlineThickness; w.style.textShadow = `-${t}px -${t}px ${t*2}px #000,${t}px -${t}px ${t*2}px #000,-${t}px ${t}px ${t*2}px #000,${t}px ${t}px ${t*2}px #000`; } _lastCueIdx = -2; _saveSettings(); });
  otRow.appendChild(otSlider); otRow.appendChild(otVal); _otSection.appendChild(otRow); _curPnl.appendChild(_otSection);

  // Furigana
  _pnlLabel('Furigana');
  const fgRow = _pnlRow();
  [{ label: 'Off', val: false }, { label: 'On', val: true }].forEach(({ label, val }) => {
    const btn = _pnlBtn(label, val === _furigana, btn => {
      _furigana = val; _setRowActive(fgRow, btn); _lastCueIdx = -2; _saveSettings();
    });
    fgRow.appendChild(btn);
  });

  // ═══ Layout tab ══════════════════════════════════════════
  _curPnl = _secs[1];

  _pnlLabel('Vertical position');
  const vpSliderRow = document.createElement('div');
  vpSliderRow.className = 'pnl-slider-row';
  const vpSlider = document.createElement('input');
  vpSlider.type = 'range'; vpSlider.min = '2'; vpSlider.max = '80'; vpSlider.step = '1';
  vpSlider.value = _subPosition;
  vpSlider.addEventListener('input', e => {
    e.stopPropagation(); _subPosition = +vpSlider.value; vpValEl.textContent = `${_subPosition}%`;
    subOverlay.style.bottom = `${_subPosition}%`; _saveSettings();
  });
  const vpValEl = document.createElement('span');
  vpValEl.className = 'pnl-val'; vpValEl.textContent = `${_subPosition}%`;
  vpSliderRow.appendChild(vpSlider); vpSliderRow.appendChild(vpValEl); _curPnl.appendChild(vpSliderRow);

  _pnlLabel('Max width');
  const mwSliderRow = document.createElement('div');
  mwSliderRow.className = 'pnl-slider-row';
  const mwSlider = document.createElement('input');
  mwSlider.type = 'range'; mwSlider.min = '30'; mwSlider.max = '100'; mwSlider.step = '5';
  mwSlider.value = _subMaxWidth;
  mwSlider.addEventListener('input', e => {
    e.stopPropagation(); _subMaxWidth = +mwSlider.value; mwValEl.textContent = `${_subMaxWidth}%`;
    const w = subOverlay.querySelector('span'); if (w) w.style.maxWidth = `${_subMaxWidth}%`;
    _saveSettings();
  });
  const mwValEl = document.createElement('span');
  mwValEl.className = 'pnl-val'; mwValEl.textContent = `${_subMaxWidth}%`;
  mwSliderRow.appendChild(mwSlider); mwSliderRow.appendChild(mwValEl); _curPnl.appendChild(mwSliderRow);

  // ═══ Playback tab ════════════════════════════════════════
  _curPnl = _secs[2];

  _pnlLabel('Pause on hover');
  const phRow = _pnlRow();
  [{ label: 'Off', val: false }, { label: 'On', val: true }].forEach(({ label, val }) => {
    const btn = _pnlBtn(label, val === _pauseOnHover, btn => {
      _pauseOnHover = val; _setRowActive(phRow, btn);
      if (!val && _pausedByHover) { _pausedByHover = false; video.play().catch(() => {}); }
      _saveSettings();
    });
    phRow.appendChild(btn);
  });
  const phHint = document.createElement('div');
  phHint.className = 'pnl-hint'; phHint.style.marginBottom = '14px';
  phHint.textContent = 'Pauses playback while hovering a subtitle';
  _curPnl.appendChild(phHint);

  _pnlLabel('Subtitle delay');
  const dlRow2 = document.createElement('div'); dlRow2.className = 'pnl-row';
  const _dlFmt2 = v => v === 0 ? '0.0s' : (v > 0 ? `+${(v/1000).toFixed(1)}s` : `${(v/1000).toFixed(1)}s`);
  const dlVal2 = document.createElement('span');
  dlVal2.style.cssText = 'flex:1;text-align:center;font-size:13px;color:#66AAE8;font-weight:600;display:flex;align-items:center;justify-content:center';
  dlVal2.textContent = _dlFmt2(_subDelay);
  const dlMinus2 = _pnlBtn('−', false, () => { _subDelay = Math.max(-5000, _subDelay - 100); dlVal2.textContent = _dlFmt2(_subDelay); _lastCueIdx = -2; _saveSettings(); });
  const dlPlus2  = _pnlBtn('+', false, () => { _subDelay = Math.min(5000,  _subDelay + 100); dlVal2.textContent = _dlFmt2(_subDelay); _lastCueIdx = -2; _saveSettings(); });
  dlRow2.appendChild(dlMinus2); dlRow2.appendChild(dlVal2); dlRow2.appendChild(dlPlus2);
  _curPnl.appendChild(dlRow2);
  const dlHint2 = document.createElement('div'); dlHint2.className = 'pnl-hint';
  dlHint2.textContent = 'Steps of 0.1s — shift subtitles earlier (−) or later (+)';
  _curPnl.appendChild(dlHint2);

  _pnlLabel('Auto-pause at cue end');
  const apRow = _pnlRow();
  [{ label: 'Off', val: false }, { label: 'On', val: true }].forEach(({ label, val }) => {
    const btn = _pnlBtn(label, val === _autoPause, btn => {
      _autoPause = val; _setRowActive(apRow, btn); _saveSettings();
    });
    apRow.appendChild(btn);
  });
  const apHint = document.createElement('div');
  apHint.className = 'pnl-hint'; apHint.style.marginBottom = '14px';
  apHint.textContent = 'Pauses at the end of each subtitle cue';
  _curPnl.appendChild(apHint);

  _pnlLabel('Unknown words only');
  const uoRow = _pnlRow();
  [{ label: 'Off', val: false }, { label: 'On', val: true }].forEach(({ label, val }) => {
    const btn = _pnlBtn(label, val === _unknownOnly, btn => {
      _unknownOnly = val; _setRowActive(uoRow, btn); _recolorOverlay(); _saveSettings();
    });
    uoRow.appendChild(btn);
  });
  const uoHint = document.createElement('div');
  uoHint.className = 'pnl-hint';
  uoHint.textContent = 'Hides known words, shows only unknowns';
  _curPnl.appendChild(uoHint);
}

// ── Fullscreen ────────────────────────────────────────────────────────────────

const playerContainer = document.getElementById('player-container');
const fsBtn = document.getElementById('fs-btn');

function _toggleFullscreen() {
  if (!document.fullscreenElement) {
    playerContainer.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

fsBtn.addEventListener('click', _toggleFullscreen);
document.addEventListener('keydown', e => {
  if (e.key === 'f' || e.key === 'F') _toggleFullscreen();
});
document.addEventListener('fullscreenchange', () => {
  fsBtn.title = document.fullscreenElement ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
  // Move hover tooltip and sidebar into / out of the fullscreen container
  for (const id of ['jp-hover-tip', 'jp-sidebar']) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (document.fullscreenElement) document.fullscreenElement.appendChild(el);
    else document.body.appendChild(el);
  }
});

// Shift #player-wrap when the sidebar opens — body.marginRight has no effect
// here because html/body have overflow:hidden and the wrap is position:fixed.
new MutationObserver(() => {
  const open = !!document.getElementById('jp-sidebar');
  playerWrap.style.transition = 'right .2s ease';
  playerWrap.style.right = open ? '260px' : '';
}).observe(document.body, { childList: true });

// Pre-warm tokenizer
getTokenizer().catch(() => {});

// Allow the popup to query status and trigger scoring when player.html is the active tab.
// chrome.tabs.sendMessage reaches extension pages open as tabs (they share the tab channel).
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === 'tokStatus') {
    reply({ ready: _tokenizer !== null });
    return;
  }
  if (msg.action === 'hoverStatus') {
    reply({ enabled: typeof _hoverEnabled !== 'undefined' && _hoverEnabled });
    return;
  }
  if (msg.action === 'sidebarStatus') {
    reply({ open: sidebarIsOpen() });
    return;
  }
  if (msg.action === 'openSidebar') {
    if (!_vtt) { reply({ ok: false, error: 'No subtitle loaded' }); return; }
    sidebarToggle(parseVTT(_vtt))
      .then(r => reply(r))
      .catch(e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'rescore') {
    if (!_vtt) { reply({ error: 'No subtitle loaded yet' }); return; }
    scoreVTT(_vtt)
      .then(res => {
        if (res?.score != null) {
          scoreEl.textContent = `${res.score}%`;
          reply({ score: res.score, freqKnown: res.freqKnown, freqTotal: res.freqTotal,
                  uniqueKnown: res.uniqueKnown, uniqueTotal: res.uniqueTotal,
                  kanjiKnown: res.kanjiKnown, kanjiTotal: res.kanjiTotal });
        } else {
          reply({ error: res === null ? 'No vocab or no Japanese text' : 'No content words scored' });
        }
      })
      .catch(e => reply({ error: e.message }));
    return true;
  }
});

document.addEventListener('mc-word-marked-known', () => { _recolorOverlay(); });
