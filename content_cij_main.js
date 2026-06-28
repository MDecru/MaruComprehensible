// Runs in MAIN world — intercepts video.requestFullscreen() calls so the
// browser's native fullscreen button redirects to #mc-cij-wrap instead of
// fullscreening the bare <video> (which would hide our subtitle overlay).
(function () {
  const _orig = HTMLVideoElement.prototype.requestFullscreen;
  HTMLVideoElement.prototype.requestFullscreen = function (options) {
    const wrap = document.getElementById('mc-cij-wrap');
    if (wrap) return wrap.requestFullscreen(options);
    return _orig.call(this, options);
  };
})();
