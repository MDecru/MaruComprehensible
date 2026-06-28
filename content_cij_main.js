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
