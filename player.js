// MaruComprehensible — Local video player page

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

const FONT_SIZES   = [20, 28, 36, 46];
const FONT_WEIGHTS = [{ label: 'Normal', value: 400 }, { label: 'Medium', value: 600 }, { label: 'Bold', value: 700 }];

chrome.storage.local.get('yt_sub_settings', ({ yt_sub_settings: s }) => {
  if (!s) return;
  if (s.fontSize    !== undefined) _fontSize    = s.fontSize;
  if (s.bgOpacity   !== undefined) _bgOpacity   = s.bgOpacity;
  if (s.fontWeight  !== undefined) _fontWeight  = s.fontWeight;
  if (s.colorblind  !== undefined) _colorblind  = s.colorblind;
  if (s.pauseOnHover !== undefined) _pauseOnHover = s.pauseOnHover;
});

function _saveSettings() {
  chrome.storage.local.set({ yt_sub_settings: {
    fontSize: _fontSize, bgOpacity: _bgOpacity, fontWeight: _fontWeight,
    colorblind: _colorblind, pauseOnHover: _pauseOnHover,
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

// ── Subtitle time sync ────────────────────────────────────────────────────────

function _startTimeSync() {
  _lastCueIdx = -2;
  const handler = async () => {
    if (!_cues.length || !subOverlay) return;
    const ms = video.currentTime * 1000;
    let idx = -1;
    for (let i = 0; i < _cues.length; i++) {
      if (ms >= _cues[i].start && ms < _cues[i].end) { idx = i; break; }
    }
    if (idx === _lastCueIdx) return;
    _lastCueIdx = idx;

    subOverlay.innerHTML = '';
    if (idx < 0) return;

    const wrap = document.createElement('span');
    wrap.style.cssText = [
      `background:rgba(0,0,0,${_bgOpacity})`, 'color:#fff',
      'padding:5px 18px', 'border-radius:6px', 'display:inline-block',
      `font-size:${_fontSize}px`, `font-weight:${_fontWeight}`, 'line-height:1.6',
    ].join(';');
    wrap.textContent = _cues[idx].text;
    subOverlay.appendChild(wrap);
    await hoverRetokenize(subOverlay);
    if (_colorblind) _recolorOverlay();
  };
  video.addEventListener('timeupdate', handler);
  return () => video.removeEventListener('timeupdate', handler);
}

function _recolorOverlay() {
  if (!_hoverVocab) return;
  for (const span of subOverlay.querySelectorAll('.jp-tok')) {
    const known = _hoverVocab.has(span.dataset.basic) || _hoverVocab.has(span.dataset.word);
    span.style.color = known ? '#66AAE8' : (_colorblind ? '#FDC281' : '#ED7989');
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
  document.title = file.name.replace(/\.[^.]+$/, '') + ' — MaruComprehensible';

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
    const res = await scoreVTT(_vtt);
    scoreEl.textContent = res?.score != null ? `${res.score}%` : '–';
  } catch {
    scoreEl.textContent = '?';
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

function _pnlLabel(text) {
  const el = document.createElement('div');
  el.className = 'pnl-label';
  el.textContent = text;
  settingsPnl.appendChild(el);
}
function _pnlRow() {
  const row = document.createElement('div');
  row.className = 'pnl-row';
  settingsPnl.appendChild(row);
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

  // Font size
  _pnlLabel('Font size');
  const fsRow = _pnlRow();
  FONT_SIZES.forEach((sz, i) => {
    const btn = _pnlBtn(i + 1, sz === _fontSize, btn => {
      _fontSize = sz; _setRowActive(fsRow, btn);
      const w = subOverlay.querySelector('span');
      if (w) w.style.fontSize = `${_fontSize}px`;
      _saveSettings();
    });
    fsRow.appendChild(btn);
  });

  // Font weight
  _pnlLabel('Font weight');
  const fwRow = _pnlRow();
  FONT_WEIGHTS.forEach(({ label, value }) => {
    const btn = _pnlBtn(label, value === _fontWeight, btn => {
      _fontWeight = value; _setRowActive(fwRow, btn);
      const w = subOverlay.querySelector('span');
      if (w) w.style.fontWeight = `${_fontWeight}`;
      _saveSettings();
    });
    fwRow.appendChild(btn);
  });

  // BG opacity
  _pnlLabel('Background opacity');
  const bgRow = document.createElement('div');
  bgRow.className = 'pnl-slider-row';
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = '0'; slider.max = '100';
  slider.value = Math.round(_bgOpacity * 100);
  slider.addEventListener('input', e => {
    e.stopPropagation();
    _bgOpacity = slider.value / 100;
    bgVal.textContent = `${slider.value}%`;
    const w = subOverlay.querySelector('span');
    if (w) w.style.background = `rgba(0,0,0,${_bgOpacity})`;
    _saveSettings();
  });
  const bgVal = document.createElement('span');
  bgVal.className = 'pnl-val';
  bgVal.textContent = `${slider.value}%`;
  bgRow.appendChild(slider); bgRow.appendChild(bgVal);
  settingsPnl.appendChild(bgRow);

  // Color mode
  _pnlLabel('Color mode');
  const cmRow = _pnlRow();
  [{ label: 'Blue / Red', cb: false }, { label: 'Blue / Orange', cb: true }].forEach(({ label, cb }) => {
    const btn = _pnlBtn(label, cb === _colorblind, btn => {
      _colorblind = cb; _setRowActive(cmRow, btn);
      _recolorOverlay(); _lastCueIdx = -2;
      _saveSettings();
    });
    cmRow.appendChild(btn);
  });
  const cmHint = document.createElement('div');
  cmHint.className = 'pnl-hint'; cmHint.style.marginBottom = '14px';
  cmHint.textContent = 'Blue = known · Red/Orange = unknown';
  settingsPnl.appendChild(cmHint);

  // Pause on hover
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
  phHint.className = 'pnl-hint';
  phHint.textContent = 'Pauses playback while hovering a subtitle';
  settingsPnl.appendChild(phHint);
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
  fsBtn.textContent = document.fullscreenElement ? '✕' : '⛶';
  fsBtn.title = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
});

// Pre-warm tokenizer
getTokenizer().catch(() => {});
