// Runs in the PAGE'S main world (world: "MAIN") so it can access page globals
// and intercept network requests.

// YouTube prefetches player data (captions, streaming info) for sidebar/
// related videos in the background, via a mix of fetch and XHR — a single
// global "current video" cache gets clobbered by whichever prefetch happens
// to resolve last, which is often a video the user never even navigates to.
// Key everything by video ID instead, and always look up the ID we actually
// need.
let _jaTracksById = new Map(); // videoId -> [{baseUrl, languageCode, kind}]
let _captionsById = new Map(); // videoId -> [{lang, kind, text}]

// Extract Japanese tracks from any playerCaptionsTracklistRenderer object.
function _jaTracksFrom(data) {
  const all = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return all
    .filter(t => /^ja/i.test(t.languageCode) && t.baseUrl)
    .map(t => ({ baseUrl: t.baseUrl, languageCode: t.languageCode, kind: t.kind || '' }));
}

function _rememberPlayerResponse(data) {
  const vid = data?.videoDetails?.videoId;
  if (!vid) return;
  _jaTracksById.set(vid, _jaTracksFrom(data));
}

function _rememberCaption(url, text) {
  if (!text) return;
  try {
    const u = new URL(url, location.href);
    const vid = u.searchParams.get('v');
    const lang = u.searchParams.get('lang') || '';
    if (!vid || !/^ja/i.test(lang)) return;
    const kind = u.searchParams.get('kind') || '';
    if (!_captionsById.has(vid)) _captionsById.set(vid, []);
    _captionsById.get(vid).push({ lang, kind, text });
  } catch {}
}

// Seed from the initial page load value (hard navigation).
_rememberPlayerResponse(window.ytInitialPlayerResponse);

// --- XHR interception ---
// YouTube uses XHR (not just fetch) for both captions and player-data
// requests — both interceptors below are needed to keep the caches fresh
// regardless of which transport a given navigation happens to use.
const _OrigXHROpen = XMLHttpRequest.prototype.open;
const _OrigXHRSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function(method, url, ...args) {
  if (typeof url === 'string') this._mcUrl = url;
  return _OrigXHROpen.apply(this, [method, url, ...args]);
};
XMLHttpRequest.prototype.send = function(...args) {
  const url = this._mcUrl || '';
  if (url.includes('api/timedtext')) {
    this.addEventListener('load', function() {
      if (this.status === 200) _rememberCaption(url, this.responseText);
    });
  } else if (url.includes('/youtubei/v1/player')) {
    this.addEventListener('load', function() {
      if (this.status === 200 && this.responseText) {
        try { _rememberPlayerResponse(JSON.parse(this.responseText)); } catch {}
      }
    });
  }
  return _OrigXHRSend.apply(this, args);
};

// Intercept fetch for the same two endpoints, in case a given navigation
// uses fetch instead of XHR for either of them.
const _origFetch = window.fetch;
window.fetch = async function(input, init) {
  const url = typeof input === 'string' ? input : (input?.url || '');
  const resp = await _origFetch.apply(this, arguments);
  if (url.includes('/youtubei/v1/player')) {
    resp.clone().json().then(_rememberPlayerResponse).catch(() => {});
  }
  if (url.includes('api/timedtext')) {
    resp.clone().text().then(text => _rememberCaption(url, text)).catch(() => {});
  }
  return resp;
};

// Handle fetch requests from the isolated-world content script.
// First checks _captionsById for the specific video the URL asks about
// (filled by the player's own XHR/fetch for that video). If empty, auto-
// triggers the YouTube player to load Japanese captions — only useful when
// the player is currently showing that same video, which is normally the
// case since this fires shortly after content_yt.js scores it. Falls back
// to a direct fetch (returns empty from extension context, kept for
// completeness).
document.addEventListener('__mc_fetch_req', async (e) => {
  let req;
  try { req = JSON.parse(e.detail || '{}'); } catch { return; }
  const { url, reqId } = req;

  if (url.includes('api/timedtext')) {
    let expectedVid = '';
    try { expectedVid = new URL(url, location.href).searchParams.get('v') || ''; } catch {}
    const cached = () => _captionsById.get(expectedVid) || [];

    if (cached().length === 0) {
      // If cache is empty, ask the player to load Japanese captions so our XHR
      // interceptor can catch the response. Remember previous state to restore it.
      try {
        const player = document.querySelector('#movie_player');
        if (player && typeof player.setOption === 'function') {
          let prevTrack = null;
          try { prevTrack = player.getOption('captions', 'track'); } catch {}
          player.setOption('captions', 'track', { languageCode: 'ja' });
          await new Promise(resolve => {
            const poll = setInterval(() => {
              if (cached().length > 0) { clearInterval(poll); resolve(); }
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

    const list = cached();
    if (list.length > 0) {
      try {
        const u = new URL(url, location.href);
        const reqLang = (u.searchParams.get('lang') || '').toLowerCase();
        const reqKind = u.searchParams.get('kind') || '';
        // Strict kind match only — content_yt.js relies on an unspecified
        // (manual) kind never silently resolving to a cached ASR entry just
        // because it's the only Japanese track available. A looser "any
        // Japanese entry" fallback here used to defeat that distinction:
        // requesting a manual track on an ASR-only video would still get
        // asked to activate 'ja' captions below, which caches the ASR track,
        // which this fallback would then happily hand back as if it were
        // the manual track being asked for.
        const hit = list.find(c => c.lang.toLowerCase() === reqLang && c.kind === reqKind);
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
document.addEventListener('__mc_get_ytpr', (e) => {
  const expectedVideoId = e.detail;
  const result = _jaTracksById.get(expectedVideoId) || [];
  document.dispatchEvent(new CustomEvent('__mc_ytpr_response', {
    detail: JSON.stringify(result),
  }));
});
