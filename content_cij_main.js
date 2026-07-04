// Runs in MAIN world at document_start.
// Intercepts ALL Element.requestFullscreen() calls so any element inside
// #mc-cij-wrap (the video, the player container, etc.) fullscreens the wrap
// instead — keeping our subtitle overlay and control bar visible.
(function () {
  const _orig = Element.prototype.requestFullscreen;
  Element.prototype.requestFullscreen = function (options) {
    const wrap = document.getElementById('mc-cij-wrap');
    if (wrap && (this === wrap || wrap.contains(this) || this.tagName === 'VIDEO')) {
      return _orig.call(wrap, options);
    }
    return _orig.call(this, options);
  };
})();

// Intercept /api/v1/transcript fetch to enable auto-scoring.
// Must run in MAIN world at document_start so the interceptor is in place
// before the page's own JavaScript makes the API call.
(function () {
  var _fetch = window.fetch;
  var done = false;
  window.fetch = function (url, opts) {
    var p = _fetch.apply(this, arguments);
    if (!done && typeof url === 'string' && url.includes('/api/v1/transcript')) {
      done = true;
      p.then(function (r) {
        return r.clone().text().then(function (text) {
          try {
            var data = JSON.parse(text);
            var transcriptText = '';
            if (data.cues) {
              transcriptText = data.cues.map(function (c) { return c.text || ''; }).join('\n');
            } else if (data.transcript) {
              transcriptText = data.transcript;
            } else if (typeof data === 'string') {
              transcriptText = data;
            }
            if (transcriptText.trim()) {
              // Bridge to ISOLATED world via DOM dataset (polled by content_cij.js)
              document.documentElement.setAttribute('data-mc-transcript', transcriptText);
            }
          } catch (e) {}
        });
      }).catch(function () {});
    }
    return p;
  };
})();
