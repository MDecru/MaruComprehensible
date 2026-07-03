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
