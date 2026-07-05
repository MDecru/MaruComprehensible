// Proxy Jisho API calls — background service workers bypass CORS reliably
// Also proxy YouTube timedtext fetches — content script fetches can be blocked
// by uBlock Origin via chrome.webRequest, but service worker requests are not
// associated with a tab and bypass that filtering.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.action === 'fetchText') {
    if (!sender?.tab?.id) { reply({ ok: false, status: 0, text: '', error: 'no tab context' }); return; }
    // Execute fetch inside the YouTube page (MAIN world) so the browser sends
    // YouTube's own session cookies and sets Origin: https://www.youtube.com.
    // Fetching from the service worker or content script sends a chrome-extension
    // origin that YouTube silently rejects with an empty 200 body.
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: async (url) => {
        try {
          const r = await fetch(url);
          const text = await r.text();
          return { ok: r.ok, status: r.status, text };
        } catch (e) {
          return { ok: false, status: 0, text: '', error: e.message };
        }
      },
      args: [msg.url],
    }).then(results => {
      reply(results?.[0]?.result || { ok: false, status: 0, text: '' });
    }).catch(e => reply({ ok: false, status: 0, text: '', error: String(e) }));
    return true;
  }
  if (msg.action === 'jishoLookup') {
    const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(msg.word)}`;
    fetch(url)
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(data => {
        const hit = (data.data || []).find(e =>
          e.japanese?.some(j => j.word === msg.word || j.reading === msg.word)
        ) || data.data?.[0];
        if (!hit) { reply({ ok: false }); return; }
        const reading = hit.japanese?.[0]?.reading || '';
        const senses  = (hit.senses || []).slice(0, 3).map(s => ({
          defs: s.english_definitions?.slice(0, 4) || [],
          pos:  s.parts_of_speech?.[0] || '',
        })).filter(s => s.defs.length);
        reply({ ok: true, reading, senses });
      })
      .catch(e => reply({ ok: false, error: String(e) }));
    return true; // async
  }
  return false;
});

// ── Right-click "Search on MaruMori" context menu ──────────────────────────
// onInstalled fires on every extension reload during development too (not
// just first install), and a menu id from the previous load is still
// registered at that point — removeAll() first so create() never fails with
// a duplicate-id error that would otherwise be misread as "icons
// unsupported" and quietly leave the menu missing entirely.

function _mcCreateContextMenu() {
  const props = {
    id: 'mc-search-marumori',
    title: 'Search “%s” on MaruMori',
    contexts: ['selection'],
    icons: { '16': 'icons/icon16.png' },
  };
  try {
    chrome.contextMenus.create(props, () => {
      if (chrome.runtime.lastError) {
        // Per-item icons need Chrome 133+ — fall back to an icon-less item
        // on older versions instead of losing the menu entry entirely.
        const { icons, ...withoutIcon } = props;
        try { chrome.contextMenus.create(withoutIcon); } catch {}
      }
    });
  } catch {
    // Some Chrome versions reject the unrecognized `icons` property
    // synchronously instead of via the callback — same fallback either way.
    const { icons, ...withoutIcon } = props;
    try { chrome.contextMenus.create(withoutIcon); } catch {}
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(_mcCreateContextMenu);
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== 'mc-search-marumori') return;
  const word = (info.selectionText || '').trim();
  if (!word) return;
  chrome.tabs.create({ url: `https://marumori.io/dictionary/search?q=${encodeURIComponent(word)}` });
});

// ── Stopwatch / focus timer (SRS timeslot) ─────────────────────────────────
// State lives in chrome.storage.local under `mc_stopwatch`; the alarm is the
// source of truth for "when it fires" so it survives service-worker restarts.

function bgTimerLogicalDay(ts, resetHour) {
  const d = new Date(ts - resetHour * 3600000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Self-contained — runs inside the target page via chrome.scripting.executeScript,
// so it cannot close over anything from this file.
function _mcStopwatchEffect(opts) {
  try {
    if (opts.sound) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const now = ctx.currentTime;
      [660, 880].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i * 0.16);
        gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.16 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.16 + 0.35);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(now + i * 0.16); osc.stop(now + i * 0.16 + 0.4);
      });
      setTimeout(() => ctx.close(), 1200);
    }
    if (opts.effect) {
      const flash = document.createElement('div');
      flash.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:radial-gradient(circle,rgba(114,206,157,.35),rgba(114,206,157,0) 70%);animation:mcSwPulse 1.4s ease-out;';
      const style = document.createElement('style');
      style.textContent = '@keyframes mcSwPulse{0%{opacity:0}15%{opacity:1}100%{opacity:0}}';
      document.head.appendChild(style);
      document.body.appendChild(flash);
      setTimeout(() => { flash.remove(); style.remove(); }, 1500);

      const toast = document.createElement('div');
      toast.textContent = 'Focus timer complete!';
      toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:2147483647;background:rgba(20,22,26,.92);color:#fff;font:700 14px -apple-system,sans-serif;padding:10px 18px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.35);pointer-events:none;';
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3500);
    }
  } catch {}
}

async function onStopwatchComplete() {
  const { mc_stopwatch } = await chrome.storage.local.get('mc_stopwatch');
  if (!mc_stopwatch) return;
  const durationSec = mc_stopwatch.durationSec || 0;

  if (mc_stopwatch.autoAddImmersion && durationSec > 0) {
    const { mc_timer_settings = {}, mc_timer_days = {}, mc_timer_site_totals = {}, mc_timer_source_days = {} } =
      await chrome.storage.local.get(['mc_timer_settings', 'mc_timer_days', 'mc_timer_site_totals', 'mc_timer_source_days']);
    const resetHour = mc_timer_settings.resetHour ?? 4;
    const day = bgTimerLogicalDay(Date.now(), resetHour);
    mc_timer_days[day] = (mc_timer_days[day] || 0) + durationSec;
    mc_timer_site_totals.manual = (mc_timer_site_totals.manual || 0) + durationSec;
    mc_timer_source_days.manual = mc_timer_source_days.manual || {};
    mc_timer_source_days.manual[day] = (mc_timer_source_days.manual[day] || 0) + durationSec;
    await chrome.storage.local.set({ mc_timer_days, mc_timer_site_totals, mc_timer_source_days });
  }

  await chrome.storage.local.set({ mc_stopwatch: {
    ...mc_stopwatch, running: false, paused: false, remainingSec: durationSec, endsAt: null,
  }});

  const wantSound  = mc_stopwatch.notifySound !== false;
  const wantEffect = !!mc_stopwatch.notifyEffect;
  const wantedAny = wantSound || wantEffect;
  let delivered = false;
  if (wantedAny) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: _mcStopwatchEffect,
          args: [{ sound: wantSound, effect: wantEffect }],
        });
        delivered = true;
      }
    } catch {}
  }
  if (wantedAny && !delivered) {
    try {
      chrome.notifications.create('mc-stopwatch-done', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Focus timer complete',
        message: mc_stopwatch.autoAddImmersion
          ? `Nice! ${Math.round(durationSec / 60)} min added to today's immersion.`
          : 'Your SRS session timeslot is up.',
      });
    } catch {}
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'mc_stopwatch') onStopwatchComplete();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.mc_stopwatch) return;
  const s = changes.mc_stopwatch.newValue;
  if (s?.running && s.endsAt) {
    chrome.alarms.create('mc_stopwatch', { when: s.endsAt });
  } else {
    chrome.alarms.clear('mc_stopwatch');
  }
});

// ── Cloud backup via Google Drive (appDataFolder) ──────────────────────────
// Explicit and one-directional only, triggered by the user clicking Save or
// Sync in the popup — no automatic background mirroring (an earlier version
// of this did that, and the implicit push/pull made it hard to tell what had
// actually happened to your data; explicit beats automatic here).
//
// Backed by a single JSON file in the user's Google Drive "appDataFolder" —
// a hidden per-app storage space Drive gives each OAuth-authorized app,
// invisible in the user's normal Drive file list. This replaced an earlier
// chrome.storage.sync-based version: that had hard quotas (100KB total,
// 8KB/item) that a real vocab/kanji/immersion collection can blow through;
// Drive has no such ceiling for data this size.
//
// Covers: API key, MaruMori vocab/kanji cache, manually-marked known words,
// immersion time (daily/site totals + recent session log + per-video seconds),
// and video/word watch history.
const DRIVE_FILE_NAME = 'marucomprehension-backup.json';
const DRIVE_BACKUP_KEYS = [
  'mm_token', 'mm_vocab', 'mm_kanji', 'mc_user_known',
  'mc_timer_days', 'mc_timer_site_totals', 'mc_timer_log', 'mc_video_watch_sec',
  'mc_timer_settings', 'mc_timer_tracking_enabled',
  'mc_video_history', 'mc_word_history',
];

function _getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'Google sign-in failed or was cancelled'));
      } else {
        resolve(token);
      }
    });
  });
}

// Runs fn(token) once, and once more with a freshly-forced token if the first
// attempt fails with a 401 (cached token expired/revoked) — transparent to
// callers, who never see the retry.
async function _withDriveAuth(fn) {
  const token = await _getAuthToken(true);
  try {
    return await fn(token);
  } catch (e) {
    if (!String(e.message).includes('401')) throw e;
    await new Promise(resolve => chrome.identity.removeCachedAuthToken({ token }, resolve));
    const freshToken = await _getAuthToken(true);
    return await fn(freshToken);
  }
}

async function _driveFindFileId(token) {
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}'`);
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Drive lookup failed: HTTP ${r.status}`);
  const data = await r.json();
  return data.files?.[0]?.id || null;
}

async function _driveUpload(token, fileId, obj) {
  const body = JSON.stringify(obj);
  if (fileId) {
    const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!r.ok) throw new Error(`Drive save failed: HTTP ${r.status}`);
    return;
  }
  const metadata = { name: DRIVE_FILE_NAME, parents: ['appDataFolder'] };
  const boundary = `mc_${Date.now()}`;
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n` +
    `--${boundary}--`;
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  if (!r.ok) throw new Error(`Drive save failed: HTTP ${r.status}`);
}

async function _driveDownload(token, fileId) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Drive download failed: HTTP ${r.status}`);
  return r.json();
}

async function _saveToCloud() {
  return _withDriveAuth(async (token) => {
    const local = await chrome.storage.local.get(DRIVE_BACKUP_KEYS);
    const fileId = await _driveFindFileId(token);
    await _driveUpload(token, fileId, { savedAt: Date.now(), data: local });
    await chrome.storage.local.set({ mc_cloud_last_saved: Date.now() });
    return Object.keys(local);
  });
}

// Video history entries carry both cumulative facts (watchCount, firstWatched)
// and "current state" descriptive fields (title/url/site/lastScore) that
// should reflect whichever side saw the video more recently.
function _mergeVideoHistory(local, remote) {
  const merged = { ...local };
  for (const [key, r] of Object.entries(remote)) {
    const l = merged[key];
    if (!l) { merged[key] = r; continue; }
    const rIsNewer = (r.lastWatched || 0) >= (l.lastWatched || 0);
    merged[key] = {
      title: rIsNewer ? r.title : l.title,
      url: rIsNewer ? r.url : l.url,
      site: rIsNewer ? r.site : l.site,
      lastScore: rIsNewer ? r.lastScore : l.lastScore,
      lastWatched: Math.max(l.lastWatched || 0, r.lastWatched || 0),
      firstWatched: Math.min(l.firstWatched || Infinity, r.firstWatched || Infinity),
      watchCount: (l.watchCount || 0) + (r.watchCount || 0),
    };
  }
  return merged;
}

function _mergeWordHistory(local, remote) {
  const merged = { ...local };
  for (const [word, r] of Object.entries(remote)) {
    const l = merged[word];
    merged[word] = l
      ? { count: (l.count || 0) + (r.count || 0), lastSeen: Math.max(l.lastSeen || 0, r.lastSeen || 0) }
      : r;
  }
  return merged;
}

// mc_timer_days/mc_timer_site_totals/mc_timer_log/mc_video_history/
// mc_word_history are historical, not just current-state settings — two
// devices may have tracked time or watched videos independently, so a pull
// merges (sums seconds/watchCount per day/site/entry, unions log entries by
// id) instead of overwriting, which would silently erase whichever device
// didn't just push. mc_user_known gets the same treatment for the same
// reason. The rest (API key, vocab/kanji cache, timer settings) really is
// just "current state" and overwriting on pull is correct for those.
async function _syncFromCloud() {
  return _withDriveAuth(async (token) => {
    const fileId = await _driveFindFileId(token);
    if (!fileId) return null;
    const payload = await _driveDownload(token, fileId);
    const remote = payload?.data || {};

    const local = await chrome.storage.local.get([
      'mc_user_known', 'mc_timer_days', 'mc_timer_site_totals', 'mc_timer_log',
      'mc_video_watch_sec', 'mc_video_history', 'mc_word_history',
    ]);
    const toApply = { ...remote };

    if (remote.mc_timer_days) {
      const merged = { ...(local.mc_timer_days || {}) };
      for (const [day, sec] of Object.entries(remote.mc_timer_days)) merged[day] = (merged[day] || 0) + sec;
      toApply.mc_timer_days = merged;
    }
    if (remote.mc_timer_site_totals) {
      const merged = { ...(local.mc_timer_site_totals || {}) };
      for (const [site, sec] of Object.entries(remote.mc_timer_site_totals)) merged[site] = (merged[site] || 0) + sec;
      toApply.mc_timer_site_totals = merged;
    }
    if (remote.mc_video_watch_sec) {
      const merged = { ...(local.mc_video_watch_sec || {}) };
      for (const [key, sec] of Object.entries(remote.mc_video_watch_sec)) merged[key] = (merged[key] || 0) + sec;
      toApply.mc_video_watch_sec = merged;
    }
    if (remote.mc_timer_log) {
      const byId = new Map((local.mc_timer_log || []).map(e => [e.id, e]));
      for (const e of remote.mc_timer_log) byId.set(e.id, e);
      toApply.mc_timer_log = [...byId.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60);
    }
    if (remote.mc_user_known) {
      toApply.mc_user_known = Array.from(new Set([...(local.mc_user_known || []), ...remote.mc_user_known]));
    }
    if (remote.mc_video_history) {
      toApply.mc_video_history = _mergeVideoHistory(local.mc_video_history || {}, remote.mc_video_history);
    }
    if (remote.mc_word_history) {
      toApply.mc_word_history = _mergeWordHistory(local.mc_word_history || {}, remote.mc_word_history);
    }

    await chrome.storage.local.set(toApply);
    await chrome.storage.local.set({ mc_cloud_last_synced: Date.now() });
    return Object.keys(toApply);
  });
}

// Local file Import used to be a blind chrome.storage.local.clear() + set(data)
// — a full snapshot restore that would silently erase this device's own
// history/immersion/known-words if they weren't in the file being restored.
// That's the same clobbering risk _syncFromCloud guards against, so it gets
// the same treatment: historical/cumulative keys merge with what's already
// here instead of being overwritten, and nothing is cleared first, so any
// local-only key not present in the file is left alone rather than deleted.
// mc_timer_source_days isn't part of the Drive backup (left out as the one
// piece most likely to outgrow it) but a local export dumps everything, so
// it needs the same nested per-site-per-day merge here.
async function _mergeImport(data) {
  const local = await chrome.storage.local.get([
    'mc_user_known', 'mc_timer_days', 'mc_timer_site_totals', 'mc_timer_source_days',
    'mc_timer_log', 'mc_video_watch_sec', 'mc_video_history', 'mc_word_history',
  ]);
  const toApply = { ...data };

  if (data.mc_timer_days) {
    const merged = { ...(local.mc_timer_days || {}) };
    for (const [day, sec] of Object.entries(data.mc_timer_days)) merged[day] = (merged[day] || 0) + sec;
    toApply.mc_timer_days = merged;
  }
  if (data.mc_timer_site_totals) {
    const merged = { ...(local.mc_timer_site_totals || {}) };
    for (const [site, sec] of Object.entries(data.mc_timer_site_totals)) merged[site] = (merged[site] || 0) + sec;
    toApply.mc_timer_site_totals = merged;
  }
  if (data.mc_video_watch_sec) {
    const merged = { ...(local.mc_video_watch_sec || {}) };
    for (const [key, sec] of Object.entries(data.mc_video_watch_sec)) merged[key] = (merged[key] || 0) + sec;
    toApply.mc_video_watch_sec = merged;
  }
  if (data.mc_timer_source_days) {
    const merged = { ...(local.mc_timer_source_days || {}) };
    for (const [site, days] of Object.entries(data.mc_timer_source_days)) {
      merged[site] = { ...(merged[site] || {}) };
      for (const [day, sec] of Object.entries(days)) merged[site][day] = (merged[site][day] || 0) + sec;
    }
    toApply.mc_timer_source_days = merged;
  }
  if (data.mc_timer_log) {
    const byId = new Map((local.mc_timer_log || []).map(e => [e.id, e]));
    for (const e of data.mc_timer_log) byId.set(e.id, e);
    toApply.mc_timer_log = [...byId.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60);
  }
  if (data.mc_user_known) {
    toApply.mc_user_known = Array.from(new Set([...(local.mc_user_known || []), ...data.mc_user_known]));
  }
  if (data.mc_video_history) {
    toApply.mc_video_history = _mergeVideoHistory(local.mc_video_history || {}, data.mc_video_history);
  }
  if (data.mc_word_history) {
    toApply.mc_word_history = _mergeWordHistory(local.mc_word_history || {}, data.mc_word_history);
  }

  await chrome.storage.local.set(toApply);
  return Object.keys(toApply);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.action === 'saveToCloud') {
    _saveToCloud().then(keys => reply({ ok: true, keys })).catch(e => reply({ ok: false, error: e.message }));
    return true; // async
  }
  if (msg.action === 'syncFromCloud') {
    _syncFromCloud().then(keys => reply({ ok: true, keys })).catch(e => reply({ ok: false, error: e.message }));
    return true; // async
  }
  if (msg.action === 'importMerged') {
    _mergeImport(msg.data).then(keys => reply({ ok: true, keys })).catch(e => reply({ ok: false, error: e.message }));
    return true; // async
  }
  return false;
});
