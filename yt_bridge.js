// Runs in the PAGE'S main world (world: "MAIN") so it can access page globals
// and intercept network requests.

let _cachedJaTracks = null;
let _cachedCaptions = []; // {lang, kind, text} — filled by XHR/fetch intercept

// Extract Japanese tracks from any playerCaptionsTracklistRenderer object.
function _jaTracksFrom(data) {
  const all = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return all
    .filter(t => /^ja/i.test(t.languageCode) && t.baseUrl)
    .map(t => ({ baseUrl: t.baseUrl, languageCode: t.languageCode, kind: t.kind || '' }));
}

// Seed from the initial page load value (hard navigation).
_cachedJaTracks = _jaTracksFrom(window.ytInitialPlayerResponse);
console.log('[MC-bridge] init: ytInitialPlayerResponse present:', !!window.ytInitialPlayerResponse,
  '| captions present:', !!window.ytInitialPlayerResponse?.captions,
  '| seed tracks:', _cachedJaTracks.length);

// --- XHR interception ---
// YouTube player uses XHR (not fetch) for captions, so our window.fetch override
// never sees them. Intercept XHR to cache caption text as the player fetches it.
const _OrigXHROpen = XMLHttpRequest.prototype.open;
const _OrigXHRSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function(method, url, ...args) {
  if (typeof url === 'string') this._mcUrl = url;
  return _OrigXHROpen.apply(this, [method, url, ...args]);
};
XMLHttpRequest.prototype.send = function(...args) {
  if (this._mcUrl?.includes('api/timedtext')) {
    const mcUrl = this._mcUrl;
    this.addEventListener('load', function() {
      if (this.status === 200 && this.responseText?.length > 0) {
        try {
          const u = new URL(mcUrl, location.href);
          const lang = u.searchParams.get('lang') || '';
          if (/^ja/i.test(lang)) {
            const kind = u.searchParams.get('kind') || '';
            _cachedCaptions.push({ lang, kind, text: this.responseText });
            console.log('[MC-bridge] XHR cached caption lang:', lang, 'kind:', kind, 'len:', this.responseText.length);
          }
        } catch {}
      }
    });
  }
  return _OrigXHRSend.apply(this, args);
};

// Intercept fetch so we capture the /youtubei/v1/player response on SPA navigation
// and any timedtext that goes through fetch instead of XHR.
const _origFetch = window.fetch;
window.fetch = async function(input, init) {
  const url = typeof input === 'string' ? input : (input?.url || '');
  const resp = await _origFetch.apply(this, arguments);
  if (url.includes('/youtubei/v1/player')) {
    resp.clone().json().then(data => {
      const tracks = _jaTracksFrom(data);
      if (tracks.length) _cachedJaTracks = tracks;
    }).catch(() => {});
  }
  if (url.includes('api/timedtext')) {
    resp.clone().text().then(text => {
      if (text?.length > 0) {
        try {
          const u = new URL(url, location.href);
          const lang = u.searchParams.get('lang') || '';
          if (/^ja/i.test(lang)) {
            const kind = u.searchParams.get('kind') || '';
            _cachedCaptions.push({ lang, kind, text });
            console.log('[MC-bridge] fetch cached caption lang:', lang, 'len:', text.length);
          }
        } catch {}
      }
    }).catch(() => {});
  }
  return resp;
};

// Handle fetch requests from the isolated-world content script.
// First checks _cachedCaptions (filled by player's XHR/fetch).
// If cache is empty, auto-triggers the YouTube player to load Japanese captions.
// Falls back to direct _origFetch (returns empty from extension context).
document.addEventListener('__mc_fetch_req', async (e) => {
  let req;
  try { req = JSON.parse(e.detail || '{}'); } catch { return; }
  const { url, reqId } = req;

  if (url.includes('api/timedtext')) {
    // If cache is empty, ask the player to load Japanese captions so our XHR
    // interceptor can catch the response. Remember previous state to restore it.
    if (_cachedCaptions.length === 0) {
      try {
        const player = document.querySelector('#movie_player');
        if (player && typeof player.setOption === 'function') {
          let prevTrack = null;
          try { prevTrack = player.getOption('captions', 'track'); } catch {}
          player.setOption('captions', 'track', { languageCode: 'ja' });
          await new Promise(resolve => {
            const poll = setInterval(() => {
              if (_cachedCaptions.length > 0) { clearInterval(poll); resolve(); }
            }, 150);
            setTimeout(() => { clearInterval(poll); resolve(); }, 3000);
          });
          // Restore previous caption state (hide if were hidden before)
          if (!prevTrack?.languageCode) {
            try { player.setOption('captions', 'track', {}); } catch {}
          } else if (prevTrack.languageCode !== 'ja') {
            try { player.setOption('captions', 'track', prevTrack); } catch {}
          }
        }
      } catch {}
    }

    if (_cachedCaptions.length > 0) {
      try {
        const u = new URL(url, location.href);
        const reqLang = (u.searchParams.get('lang') || '').toLowerCase();
        const reqKind = u.searchParams.get('kind') || '';
        const hit = _cachedCaptions.find(c => c.lang.toLowerCase() === reqLang && c.kind === reqKind)
                 || _cachedCaptions.find(c => /^ja/i.test(c.lang));
        if (hit) {
          document.dispatchEvent(new CustomEvent('__mc_fetch_res', {
            detail: JSON.stringify({ reqId, ok: true, status: 200, text: hit.text }),
          }));
          return;
        }
      } catch {}
    }
  }

  // Direct fetch fallback (returns empty from extension context but kept for completeness)
  let result;
  try {
    const r = await _origFetch(url);
    const text = await r.text();
    result = { reqId, ok: r.ok, status: r.status, text };
  } catch (err) {
    result = { reqId, ok: false, status: 0, text: '', error: err.message };
  }
  document.dispatchEvent(new CustomEvent('__mc_fetch_res', {
    detail: JSON.stringify(result),
  }));
});

// Respond to caption-track-list requests from the isolated-world content script.
document.addEventListener('__mc_get_ytpr', () => {
  const live = _jaTracksFrom(window.ytInitialPlayerResponse);
  const ytPlayerConfig = window.ytplayer?.config;
  const configTracks = _jaTracksFrom(ytPlayerConfig);
  const result = live.length ? live
               : (configTracks.length ? configTracks
               : (_cachedJaTracks || []));

  // --- diagnostic (remove after debugging) ---
  const pr = window.ytInitialPlayerResponse;
  const allTracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  console.log('[MC-bridge] ytInitialPlayerResponse present:', !!pr);
  console.log('[MC-bridge] all captionTracks from ytInitialPlayerResponse:', allTracks.map(t => t.languageCode + '|' + (t.kind||'manual') + '|' + (t.vssId||'')));
  console.log('[MC-bridge] ytplayer.config present:', !!ytPlayerConfig, '| configTracks:', configTracks.length);
  console.log('[MC-bridge] cached tracks:', JSON.stringify(_cachedJaTracks));
  console.log('[MC-bridge] cached captions:', _cachedCaptions.length, 'entries');
  console.log('[MC-bridge] returning:', JSON.stringify(result));
  // -------------------------------------------

  document.dispatchEvent(new CustomEvent('__mc_ytpr_response', {
    detail: JSON.stringify(result),
  }));
});
