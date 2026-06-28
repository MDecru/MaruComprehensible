// YouTube content script — auto-injected on youtube.com

let _lastVideoId = null;
let _scoring = false;

function currentVideoId() {
  return new URLSearchParams(location.search).get('v');
}

// Ask yt_bridge.js (main world) for the current video's Japanese caption track list.
// Returns an array of {baseUrl, languageCode, kind} objects, or [] on timeout.
function _getJaTracks() {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      document.removeEventListener('__mc_ytpr_response', handler);
      resolve([]);
    }, 3000);
    const handler = e => {
      clearTimeout(timer);
      document.removeEventListener('__mc_ytpr_response', handler);
      try { resolve(JSON.parse(e.detail || '[]')); } catch { resolve([]); }
    };
    document.addEventListener('__mc_ytpr_response', handler);
    document.dispatchEvent(new CustomEvent('__mc_get_ytpr'));
  });
}

// Extract a JSON object whose first `{` is at src[start], using bracket matching.
// Handles quoted strings (so braces/brackets inside strings are ignored).
function _extractJson(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if      (ch === '{') depth++;
    else if (ch === '}') { if (--depth === 0) return src.slice(start, i + 1); }
    else if (ch === '"') {
      // skip past the closing quote, respecting backslash escapes
      i++;
      while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i++; i++; }
    }
  }
  return null;
}

// Pull all Japanese caption track base URLs out of a ytInitialPlayerResponse script.
function _captionUrlsFromScript(src) {
  const urls = [];
  // Find every assignment: ytInitialPlayerResponse = { ... }
  const re = /ytInitialPlayerResponse\s*=\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    try {
      const brace = m.index + m[0].lastIndexOf('{');
      const jsonStr = _extractJson(src, brace);
      if (!jsonStr) continue;
      const data = JSON.parse(jsonStr);
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      for (const t of tracks) {
        if (/^ja/.test(t.languageCode) && t.baseUrl) {
          // manual tracks first
          if (t.kind !== 'asr') urls.unshift(t.baseUrl);
          else urls.push(t.baseUrl);
        }
      }
    } catch {}
  }
  return urls;
}

// Sequence counter so concurrent _bridgeFetch calls can match their responses.
let _fetchSeq = 0;

// Ask yt_bridge.js (MAIN world) to fetch a URL — gives us youtube.com origin
// and session cookies which the timedtext API requires.
function _bridgeFetch(url) {
  return new Promise(resolve => {
    const reqId = ++_fetchSeq;
    const timer = setTimeout(() => {
      document.removeEventListener('__mc_fetch_res', handler);
      resolve({ ok: false, status: 0, text: '' });
    }, 10000);
    const handler = e => {
      let data;
      try { data = JSON.parse(e.detail || '{}'); } catch { return; }
      if (data.reqId !== reqId) return;
      clearTimeout(timer);
      document.removeEventListener('__mc_fetch_res', handler);
      resolve(data);
    };
    document.addEventListener('__mc_fetch_res', handler);
    document.dispatchEvent(new CustomEvent('__mc_fetch_req', {
      detail: JSON.stringify({ url, reqId }),
    }));
  });
}

function _msToVttTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ms % 1000).padStart(3,'0')}`;
}

// Convert YouTube SRV3 XML to WebVTT
function _srv3ToVtt(xml) {
  let vtt = 'WEBVTT\n\n';
  let found = false;
  for (const m of xml.matchAll(/<p\b[^>]*\bt="(\d+)"[^>]*\bd="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
    const start = parseInt(m[1]);
    const end = start + parseInt(m[2]);
    const text = m[3].replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
    if (!text) continue;
    vtt += `${_msToVttTime(start)} --> ${_msToVttTime(end)}\n${text}\n\n`;
    found = true;
  }
  return found ? vtt : null;
}

// Convert YouTube JSON3 format to WebVTT
function _json3ToVtt(jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    let vtt = 'WEBVTT\n\n';
    let found = false;
    for (const ev of data.events || []) {
      if (!ev.segs) continue;
      const start = ev.tStartMs || 0;
      const end = start + (ev.dDurationMs || 2000);
      const text = ev.segs.map(s => s.utf8 || '').join('').trim();
      if (!text || text === '\n') continue;
      vtt += `${_msToVttTime(start)} --> ${_msToVttTime(end)}\n${text}\n\n`;
      found = true;
    }
    return found ? vtt : null;
  } catch { return null; }
}

async function _fetchVTT(url) {
  try {
    const resp = await _bridgeFetch(url);
    const t = resp?.text || '';
    console.log('[MC-yt] _fetchVTT status:', resp?.status, 'len:', t.length, 'prefix:', t.slice(0,80).replace(/\n/g,' '), '|', url.slice(0,70));
    if (!resp?.ok) return null;
    if (t.includes('-->')) return t;                             // already VTT
    if (t.includes('<timedtext') || t.startsWith('<?xml')) return _srv3ToVtt(t);  // SRV3 XML
    if (t.startsWith('{') && t.includes('"events"')) return _json3ToVtt(t);       // JSON3
    return null;
  } catch(e) {
    console.log('[MC-yt] _fetchVTT exception:', e.message);
    return null;
  }
}

async function fetchJaVTT(videoId) {
  console.log('[MC-yt] fetchJaVTT start, videoId:', videoId);

  // 1. Ask yt_bridge.js (main world) for the live caption track list.
  //    This works for both hard loads and SPA navigation.
  const jaTracks = await _getJaTracks();
  console.log('[MC-yt] step1 bridge tracks:', JSON.stringify(jaTracks));
  // Prefer manual over ASR
  const sorted = [
    ...jaTracks.filter(t => t.kind !== 'asr'),
    ...jaTracks.filter(t => t.kind === 'asr'),
  ];
  for (const track of sorted) {
    const vtt = await _fetchVTT(`${track.baseUrl}&fmt=vtt`);
    console.log('[MC-yt] step1 vtt from bridge track:', !!vtt, track.baseUrl?.slice(0, 60));
    if (vtt) return vtt;
  }

  // 2. Parse ytInitialPlayerResponse out of inline <script> tags (hard navigation fallback).
  const scriptUrls = [];
  for (const s of document.querySelectorAll('script')) {
    scriptUrls.push(..._captionUrlsFromScript(s.textContent));
  }
  console.log('[MC-yt] step2 script-parsed urls:', scriptUrls.length, scriptUrls[0]?.slice(0, 80));
  for (const baseUrl of scriptUrls) {
    const vtt = await _fetchVTT(`${baseUrl}&fmt=vtt`);
    if (vtt) return vtt;
  }

  // 3. Timedtext API — try listing available tracks first (gets the exact name parameter).
  try {
    const listResult = await _bridgeFetch(`https://www.youtube.com/api/timedtext?v=${videoId}&type=list`);
    console.log('[MC-yt] step3 timedtext list ok:', listResult?.ok, 'xml:', listResult?.text?.slice(0, 300));
    if (listResult?.ok && listResult.text) {
      const xml = listResult.text;
      for (const m of xml.matchAll(/<track\b([^>]*)>/g)) {
        const attrs = m[1];
        const langCode = attrs.match(/lang_code="([^"]*)"/)?.[1] || '';
        if (!/^ja/i.test(langCode)) continue;
        const name = attrs.match(/\bname="([^"]*)"/)?.[1] || '';
        const vtt = await _fetchVTT(
          `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${langCode}&name=${encodeURIComponent(name)}&fmt=vtt`
        );
        if (vtt) return vtt;
      }
    }
  } catch(e) { console.log('[MC-yt] step3 timedtext list error:', e.message); }

  // 4. Last resort: direct timedtext guesses
  console.log('[MC-yt] step4 trying direct timedtext guesses');
  for (const url of [
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ja&fmt=vtt`,
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ja&fmt=vtt&kind=asr`,
  ]) {
    const vtt = await _fetchVTT(url);
    console.log('[MC-yt] step4 direct guess:', !!vtt, url);
    if (vtt) return vtt;
  }

  console.log('[MC-yt] fetchJaVTT: all steps failed');
  return null;
}

async function scoreVideo() {
  const videoId = currentVideoId();
  if (!videoId || !location.pathname.startsWith('/watch')) return;
  if (_scoring) return;
  if (videoId !== _lastVideoId) _ytResetForNewVideo();
  if (videoId === _lastVideoId) return;

  _scoring = true;
  _lastVideoId = videoId;

  try {
    const vtt = await fetchJaVTT(videoId);
    const res = vtt ? await scoreVTT(vtt) : null;
    const player = _ytGetPlayer();
    if (player) _ytCreateControlBar(player, res?.score ?? null);
  } catch {
    // scoring failed silently
  } finally {
    _scoring = false;
  }
}

function parseVTTCues(vttText) {
  const cues = [];
  const toMs = str => {
    const s = str.trim().replace(/,/, '.');
    const parts = s.split(':').map(Number);
    const [h, m, sec] = parts.length === 3 ? parts : [0, ...parts];
    return Math.round((h * 3600 + m * 60 + sec) * 1000);
  };
  for (const block of vttText.split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    const ti = lines.findIndex(l => l.includes('-->'));
    if (ti < 0) continue;
    const [startStr, endStr] = lines[ti].split(/\s*-->\s*/);
    const text = lines.slice(ti + 1)
      .map(l => l.replace(/<[^>]+>/g, '').trim())
      .filter(Boolean).join(' ');
    if (!text) continue;
    const start = toMs(startStr);
    const end = toMs(endStr);
    if (isNaN(start) || isNaN(end)) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

let _ytControlBar  = null;   // [%|字幕|⚙] unified bar element
let _ytSubOverlay  = null;   // subtitle div (absolute inside player)
let _ytSubBtn      = null;   // 字幕 button inside bar
let _ytSettingsBtn = null;   // ⚙ button inside bar (hidden when subs off)
let _ytSettingsPnl = null;   // settings panel
let _ytCues        = null;   // [{start, end, text}]
let _ytLastCueIdx  = -2;
let _ytSubCleanup  = null;
let _ytFontSize      = 20;
let _ytBgOpacity     = 0.78;
let _ytFontWeight    = 400;
let _ytColorblind    = false;
let _ytPauseOnHover  = false;
let _ytPausedByHover = false;

const _YT_FONT_SIZES   = [20, 28, 36, 46];
const _YT_FONT_WEIGHTS = [{ label: 'Normal', value: 400 }, { label: 'Medium', value: 600 }, { label: 'Bold', value: 700 }];

function _ytSaveSettings() {
  if (!chrome.runtime?.id) return;
  try { chrome.storage.local.set({ yt_sub_settings: {
    fontSize: _ytFontSize, bgOpacity: _ytBgOpacity,
    fontWeight: _ytFontWeight, colorblind: _ytColorblind,
    pauseOnHover: _ytPauseOnHover,
  }}); } catch {}
}

function _ytLoadSettings() {
  if (!chrome.runtime?.id) return;
  try {
    chrome.storage.local.get('yt_sub_settings', ({ yt_sub_settings: s }) => {
      if (!s || chrome.runtime.lastError) return;
      if (s.fontSize    !== undefined) _ytFontSize     = s.fontSize;
      if (s.bgOpacity   !== undefined) _ytBgOpacity    = s.bgOpacity;
      if (s.fontWeight  !== undefined) _ytFontWeight   = s.fontWeight;
      if (s.colorblind  !== undefined) _ytColorblind   = s.colorblind;
      if (s.pauseOnHover !== undefined) _ytPauseOnHover = s.pauseOnHover;
    });
  } catch {}
}
_ytLoadSettings();

function _ytGetPlayer() {
  return document.getElementById('movie_player') || document.querySelector('.html5-video-player');
}

// Sync button color and ⚙ visibility to active/inactive state.
function _ytSetSubActive(active) {
  if (_ytSubBtn)      _ytSubBtn.style.color       = active ? '#66AAE8' : '#888';
  if (_ytSettingsBtn) _ytSettingsBtn.style.display = active ? '' : 'none';
  if (!active && _ytSettingsPnl) _ytSettingsPnl.style.display = 'none';
}

// Re-color existing .jp-tok spans in overlay (after colorblind mode change).
function _ytRecolorOverlay() {
  if (!_hoverVocab) return;
  for (const span of (_ytSubOverlay?.querySelectorAll('.jp-tok') || [])) {
    const known = _hoverVocab.has(span.dataset.basic) || _hoverVocab.has(span.dataset.word);
    span.style.color = known ? '#66AAE8' : (_ytColorblind ? '#FDC281' : '#ED7989');
  }
}

// Create or return the subtitle overlay div inside the player.
function _ytEnsureOverlay(player) {
  if (_ytSubOverlay) return _ytSubOverlay;
  _ytSubOverlay = document.createElement('div');
  _ytSubOverlay.id = 'mc-yt-overlay';
  _ytSubOverlay.style.cssText = [
    'position:absolute', 'bottom:12%', 'left:0', 'right:0',
    'z-index:9996', 'display:flex', 'justify-content:center',
    'pointer-events:auto', 'text-align:center',
  ].join(';');
  _ytSubOverlay.addEventListener('mouseenter', () => {
    if (!_ytPauseOnHover) return;
    const video = document.querySelector('video');
    if (video && !video.paused) { video.pause(); _ytPausedByHover = true; }
  });
  _ytSubOverlay.addEventListener('mouseleave', () => {
    if (!_ytPausedByHover) return;
    _ytPausedByHover = false;
    document.querySelector('video')?.play().catch(() => {});
  });
  player.appendChild(_ytSubOverlay);
  return _ytSubOverlay;
}

// Full teardown (popup disableHover).
function _ytDestroyAll() {
  _ytSubCleanup?.();        _ytSubCleanup  = null;
  _ytSubOverlay?.remove();  _ytSubOverlay  = null;
  _ytControlBar?.remove();  _ytControlBar  = null;
  _ytSettingsPnl?.remove(); _ytSettingsPnl = null;
  _ytSubBtn = null; _ytSettingsBtn = null;
  _ytCues = null; _ytLastCueIdx = -2;
  _ytPausedByHover = false;
}

// Reset subtitle state for a new video (bar persists, score updates).
function _ytResetForNewVideo() {
  _ytSubCleanup?.(); _ytSubCleanup = null;
  _ytCues = null; _ytLastCueIdx = -2;
  if (_ytSubOverlay) _ytSubOverlay.innerHTML = '';
  _ytSetSubActive(false);
  if (_ytSettingsPnl) _ytSettingsPnl.style.display = 'none';
  // Reset score to dash while new video loads
  const scoreEl = document.getElementById('mc-yt-score');
  if (scoreEl) scoreEl.textContent = '–';
  // Close sidebar so it doesn't show the previous video's transcript
  if (sidebarIsOpen()) sidebarToggle(null);
}

function _ytToggleSettings(player) {
  if (_ytSettingsPnl) {
    _ytSettingsPnl.style.display = _ytSettingsPnl.style.display === 'none' ? 'block' : 'none';
    return;
  }

  const pnl = document.createElement('div');
  pnl.id = 'mc-yt-settings';
  pnl.style.cssText = [
    'position:absolute', 'top:44px', 'left:12px', 'z-index:9998',
    'background:rgba(15,15,15,.96)', 'border:1px solid #3a3f4a',
    'border-radius:10px', 'padding:14px 16px',
    'color:#d0d4e0', 'font-size:13px', 'font-family:-apple-system,sans-serif',
    'white-space:nowrap', 'min-width:240px',
    'box-shadow:0 8px 24px rgba(0,0,0,.7)',
  ].join(';');

  function _pnlLabel(text) {
    const el = document.createElement('div');
    el.style.cssText = 'font-size:11px;color:#888;margin-bottom:7px;letter-spacing:.4px;text-transform:uppercase';
    el.textContent = text;
    pnl.appendChild(el);
  }
  function _pnlBtnRow(gap, mb) {
    const row = document.createElement('div');
    row.style.cssText = `display:flex;gap:${gap}px;margin-bottom:${mb}px`;
    pnl.appendChild(row);
    return row;
  }
  function _pnlActiveStyle(on) {
    return [
      `background:${on ? 'rgba(102,170,232,.2)' : 'rgba(255,255,255,.06)'}`,
      `color:${on ? '#66AAE8' : '#888'}`,
      `border:1px solid ${on ? '#66AAE8' : '#3a3f4a'}`,
    ].join(';');
  }

  // ── Font size ──────────────────────────────────────────────
  _pnlLabel('Font size');
  const fsRow = _pnlBtnRow(6, 14);
  _YT_FONT_SIZES.forEach((sz, i) => {
    const btn = document.createElement('button');
    btn.dataset.sz = sz;
    btn.textContent = i + 1;
    btn.style.cssText = `flex:1;padding:5px 0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;transition:all .15s;${_pnlActiveStyle(sz === _ytFontSize)}`;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _ytFontSize = sz;
      fsRow.querySelectorAll('[data-sz]').forEach(b => { b.style.cssText = `flex:1;padding:5px 0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;transition:all .15s;${_pnlActiveStyle(+b.dataset.sz === _ytFontSize)}`; });
      const w = _ytSubOverlay?.querySelector('span');
      if (w) w.style.fontSize = `${_ytFontSize}px`;
      _ytSaveSettings();
    });
    fsRow.appendChild(btn);
  });

  // ── Font weight ───────────────────────────────────────────
  _pnlLabel('Font weight');
  const fwRow = _pnlBtnRow(6, 14);
  _YT_FONT_WEIGHTS.forEach(({ label, value }) => {
    const btn = document.createElement('button');
    btn.dataset.fw = value;
    btn.textContent = label;
    btn.style.cssText = `flex:1;padding:5px 0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:${value};transition:all .15s;${_pnlActiveStyle(value === _ytFontWeight)}`;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _ytFontWeight = value;
      fwRow.querySelectorAll('[data-fw]').forEach(b => { b.style.cssText = `flex:1;padding:5px 0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:${b.dataset.fw};transition:all .15s;${_pnlActiveStyle(+b.dataset.fw === _ytFontWeight)}`; });
      const w = _ytSubOverlay?.querySelector('span');
      if (w) w.style.fontWeight = `${_ytFontWeight}`;
      _ytSaveSettings();
    });
    fwRow.appendChild(btn);
  });

  // ── BG opacity ────────────────────────────────────────────
  _pnlLabel('Background opacity');
  const bgRow = document.createElement('div');
  bgRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:14px';
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = '0'; slider.max = '100';
  slider.value = Math.round(_ytBgOpacity * 100);
  slider.style.cssText = 'flex:1;cursor:pointer;accent-color:#66AAE8';
  slider.addEventListener('click', e => e.stopPropagation());
  slider.addEventListener('input', e => {
    e.stopPropagation();
    _ytBgOpacity = slider.value / 100;
    bgVal.textContent = `${slider.value}%`;
    const w = _ytSubOverlay?.querySelector('span');
    if (w) w.style.background = `rgba(0,0,0,${_ytBgOpacity})`;
    _ytSaveSettings();
  });
  const bgVal = document.createElement('span');
  bgVal.style.cssText = 'font-size:12px;color:#66AAE8;min-width:34px;text-align:right';
  bgVal.textContent = `${slider.value}%`;
  bgRow.appendChild(slider); bgRow.appendChild(bgVal);
  pnl.appendChild(bgRow);

  // ── Color mode ────────────────────────────────────────────
  _pnlLabel('Color mode');
  const cmRow = _pnlBtnRow(6, 6);
  [
    { label: 'Blue / Red',    cb: false, tip: 'Standard: known = blue, unknown = red' },
    { label: 'Blue / Orange', cb: true,  tip: 'Colorblind-friendly: known = blue, unknown = orange' },
  ].forEach(({ label, cb, tip }) => {
    const btn = document.createElement('button');
    btn.dataset.cb = cb;
    btn.textContent = label;
    btn.title = tip;
    btn.style.cssText = `flex:1;padding:5px 4px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;transition:all .15s;${_pnlActiveStyle(cb === _ytColorblind)}`;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _ytColorblind = cb;
      cmRow.querySelectorAll('[data-cb]').forEach(b => { b.style.cssText = `flex:1;padding:5px 4px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;transition:all .15s;${_pnlActiveStyle((b.dataset.cb === 'true') === _ytColorblind)}`; });
      _ytRecolorOverlay();
      _ytLastCueIdx = -2;
      _ytSaveSettings();
    });
    cmRow.appendChild(btn);
  });
  const cmHint = document.createElement('div');
  cmHint.style.cssText = 'font-size:11px;color:#555;margin-top:5px;margin-bottom:14px';
  cmHint.textContent = 'Blue = known · Red/Orange = unknown';
  pnl.appendChild(cmHint);

  // ── Pause on hover ────────────────────────────────────────
  _pnlLabel('Pause on hover');
  const phRow = _pnlBtnRow(6, 4);
  [{ label: 'Off', val: false }, { label: 'On', val: true }].forEach(({ label, val }) => {
    const btn = document.createElement('button');
    btn.dataset.ph = val;
    btn.textContent = label;
    btn.style.cssText = `flex:1;padding:5px 0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;transition:all .15s;${_pnlActiveStyle(val === _ytPauseOnHover)}`;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _ytPauseOnHover = val;
      if (!val && _ytPausedByHover) { _ytPausedByHover = false; document.querySelector('video')?.play().catch(() => {}); }
      phRow.querySelectorAll('[data-ph]').forEach(b => { b.style.cssText = `flex:1;padding:5px 0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;transition:all .15s;${_pnlActiveStyle((b.dataset.ph === 'true') === _ytPauseOnHover)}`; });
      _ytSaveSettings();
    });
    phRow.appendChild(btn);
  });
  const phHint = document.createElement('div');
  phHint.style.cssText = 'font-size:11px;color:#555;margin-top:3px';
  phHint.textContent = 'Pauses playback while hovering a subtitle';
  pnl.appendChild(phHint);

  player.appendChild(pnl);
  _ytSettingsPnl = pnl;
}

function _ytStartTimeSync() {
  const video = document.querySelector('video');
  if (!video) return () => {};
  _ytLastCueIdx = -2;

  const handler = async () => {
    if (!_ytCues || !_ytSubOverlay) return;
    const ms = video.currentTime * 1000;
    let idx = -1;
    for (let i = 0; i < _ytCues.length; i++) {
      if (ms >= _ytCues[i].start && ms < _ytCues[i].end) { idx = i; break; }
    }
    if (idx === _ytLastCueIdx) return;
    _ytLastCueIdx = idx;

    _ytSubOverlay.innerHTML = '';
    if (idx < 0) return;

    const wrap = document.createElement('span');
    wrap.style.cssText = [
      `background:rgba(0,0,0,${_ytBgOpacity})`, 'color:#fff',
      'padding:5px 18px', 'border-radius:6px', 'display:inline-block',
      `font-size:${_ytFontSize}px`, `font-weight:${_ytFontWeight}`, 'line-height:1.6',
    ].join(';');
    wrap.textContent = _ytCues[idx].text;
    _ytSubOverlay.appendChild(wrap);
    await hoverRetokenize(_ytSubOverlay);
    if (_ytColorblind) _ytRecolorOverlay();
  };

  video.addEventListener('timeupdate', handler);
  return () => video.removeEventListener('timeupdate', handler);
}

// Create the unified [%|字幕|⚙] bar; or just update the score if already created.
function _ytCreateControlBar(player, score) {
  if (_ytControlBar) {
    const el = document.getElementById('mc-yt-score');
    if (el && score !== null) el.textContent = `${score}%`;
    return;
  }

  const bar = document.createElement('div');
  bar.id = 'mc-yt-bar';
  bar.style.cssText = [
    'position:absolute', 'top:12px', 'left:12px', 'z-index:9997',
    'display:inline-flex', 'align-items:stretch',
    'border-radius:7px', 'overflow:hidden',
    'background:rgba(0,0,0,.78)',
    'border:1px solid rgba(255,255,255,.14)',
    'font-family:-apple-system,sans-serif',
  ].join(';');

  // Score section
  const scoreEl = document.createElement('span');
  scoreEl.id = 'mc-yt-score';
  scoreEl.style.cssText = [
    'padding:5px 10px', 'font-size:13px', 'font-weight:700', 'color:#fff',
    'border-right:1px solid rgba(255,255,255,.12)',
    'display:flex', 'align-items:center',
  ].join(';');
  scoreEl.textContent = score !== null ? `${score}%` : '–';
  bar.appendChild(scoreEl);

  // 字幕 button
  _ytSubBtn = document.createElement('button');
  _ytSubBtn.id = 'mc-yt-btn';
  _ytSubBtn.textContent = '字幕';
  _ytSubBtn.title = 'Toggle Japanese subtitle coloring';
  _ytSubBtn.style.cssText = [
    'padding:5px 10px', 'font-size:13px', 'font-weight:600', 'color:#888',
    'background:none', 'border:none',
    'border-right:1px solid rgba(255,255,255,.12)',
    'cursor:pointer', 'letter-spacing:.3px', 'transition:color .15s',
  ].join(';');
  let _loading = false;
  _ytSubBtn.addEventListener('click', async e => {
    e.stopPropagation();
    if (_loading) return;
    if (!_ytCues) {
      _loading = true;
      _ytSubBtn.textContent = '…';
      const videoId = currentVideoId();
      const vtt = videoId ? await fetchJaVTT(videoId) : null;
      _loading = false;
      _ytSubBtn.textContent = '字幕';
      if (!vtt) return;
      _ytCues = parseVTTCues(vtt);
      if (!_ytCues.length) { _ytCues = null; return; }
      _ytEnsureOverlay(player);
      if (!_hoverEnabled) await hoverEnable(() => _ytSubOverlay);
      _ytSubCleanup?.(); _ytSubCleanup = _ytStartTimeSync();
      _ytSetSubActive(true);
    } else if (_ytSubCleanup) {
      _ytSubCleanup?.(); _ytSubCleanup = null;
      if (_ytSubOverlay) _ytSubOverlay.innerHTML = '';
      _ytSetSubActive(false);
    } else {
      _ytEnsureOverlay(player);
      _ytSubCleanup?.(); _ytSubCleanup = _ytStartTimeSync();
      _ytSetSubActive(true);
    }
  });
  bar.appendChild(_ytSubBtn);

  // ⚙ settings button (hidden until subtitles are active)
  _ytSettingsBtn = document.createElement('button');
  _ytSettingsBtn.id = 'mc-yt-settings-btn';
  _ytSettingsBtn.textContent = '⚙';
  _ytSettingsBtn.title = 'Subtitle settings';
  _ytSettingsBtn.style.cssText = [
    'padding:5px 8px', 'font-size:12px', 'color:#888',
    'background:none', 'border:none', 'cursor:pointer', 'display:none',
  ].join(';');
  _ytSettingsBtn.addEventListener('click', e => {
    e.stopPropagation();
    _ytToggleSettings(player);
  });
  bar.appendChild(_ytSettingsBtn);

  player.appendChild(bar);
  _ytControlBar = bar;
}

async function ytEnableHover() {
  const videoId = currentVideoId();
  if (!videoId) return { ok: false, error: 'No video playing' };

  if (!_ytCues) {
    const vtt = await fetchJaVTT(videoId);
    if (!vtt) return { ok: false, error: 'No Japanese subtitles found' };
    _ytCues = parseVTTCues(vtt);
    if (!_ytCues.length) return { ok: false, error: 'No subtitle cues found' };
  }

  const player = _ytGetPlayer();
  if (!player) return { ok: false, error: 'No player found' };

  if (!_ytControlBar) _ytCreateControlBar(player, null);
  _ytEnsureOverlay(player);
  if (!_hoverEnabled) await hoverEnable(() => _ytSubOverlay);
  _ytSubCleanup?.(); _ytSubCleanup = _ytStartTimeSync();
  _ytSetSubActive(true);

  return { ok: true };
}

// Message handler for popup
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === 'enableHover') {
    ytEnableHover().then(reply); return true;
  }
  if (msg.action === 'disableHover') {
    hoverDisable();
    _ytDestroyAll();
    reply({ ok: true }); return;
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
    const videoId = currentVideoId();
    if (!videoId || !location.pathname.startsWith('/watch')) {
      reply({ ok: false, error: 'No video playing' }); return;
    }
    fetchJaVTT(videoId).then(vtt => {
      if (!vtt) { reply({ ok: false, error: 'No Japanese subtitles found' }); return; }
      return sidebarToggle(parseVTT(vtt)).then(reply);
    }).catch(e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'sidebarStatus') {
    reply({ open: sidebarIsOpen() }); return;
  }
  if (msg.action !== 'rescore') return;
  const videoId = currentVideoId();
  if (!videoId || !location.pathname.startsWith('/watch')) {
    reply({ error: 'No video playing' }); return;
  }
  _lastVideoId = null;
  fetchJaVTT(videoId).then(vtt => {
    if (!vtt) { reply({ error: 'No Japanese subtitles found' }); return; }
    return scoreVTT(vtt).then(res => {
      const player = _ytGetPlayer();
      if (player) _ytCreateControlBar(player, res?.score ?? null);
      reply({ score: res?.score, freqKnown: res?.freqKnown, freqTotal: res?.freqTotal, uniqueKnown: res?.uniqueKnown, uniqueTotal: res?.uniqueTotal, kanjiKnown: res?.kanjiKnown, kanjiTotal: res?.kanjiTotal });
    });
  }).catch(e => reply({ error: e.message }));
  return true; // async reply
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.mm_vocab?.newValue?.length) { _lastVideoId = null; setTimeout(scoreVideo, 500); }
});

// Initial page load
setTimeout(scoreVideo, 2000);

// YouTube SPA navigation — fires when the new video's DOM is ready
document.addEventListener('yt-navigate-finish', () => {
  _lastVideoId = null;
  setTimeout(scoreVideo, 2000);
});

// Fallback: watch URL changes via MutationObserver
let _lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== _lastUrl) {
    _lastUrl = location.href;
    _lastVideoId = null;
    setTimeout(scoreVideo, 2500);
  }
}).observe(document.documentElement, { childList: true, subtree: true });

// Pre-warm the tokenizer in the background so it's ready when the user clicks score.
getTokenizer().catch(() => {});
