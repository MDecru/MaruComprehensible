// Runs in MAIN world at document_start.
console.log('[MC] content_cij_main.js loaded');

// Intercept ALL Element.requestFullscreen() calls so any element inside
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

// Intercept transcript API calls for auto-scoring.
// Must run in MAIN world at document_start before the page loads.
(function () {
  var _fetch = window.fetch;
  var done = false;

  function handleTranscript(text) {
    if (done) return;
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
        console.log('[MC] transcript found, bridging...');
        done = true;
        document._mcTranscript = transcriptText;
        document.dispatchEvent(new CustomEvent('mc-transcript', { detail: transcriptText }));
      }
    } catch (e) { console.log('[MC] transcript parse error:', e); }
  }

  // Intercept fetch()
  window.fetch = function (url, opts) {
    var p = _fetch.apply(this, arguments);
    var urlStr = typeof url === 'string' ? url : (url && url.url ? url.url : '');
    if (!done && urlStr.includes('transcript')) {
      console.log('[MC] fetch intercepted:', urlStr);
      p.then(function (r) {
        return r.clone().text().then(handleTranscript);
      }).catch(function () {});
    }
    return p;
  };

  // Also intercept XMLHttpRequest
  var _xhrOpen = XMLHttpRequest.prototype.open;
  var _xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._mcUrl = url;
    return _xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    var url = self._mcUrl || '';
    if (!done && url.includes('transcript')) {
      console.log('[MC] XHR intercepted:', url);
      self.addEventListener('load', function () {
        if (self.responseText) handleTranscript(self.responseText);
      });
    }
    return _xhrSend.apply(this, arguments);
  };
})();
