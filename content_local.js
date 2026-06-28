// Local CIJ player (mdnas.local / cij.punchyface.synology.me)
// content_cij.js already runs first and handles all scoring, hover, sidebar,
// and message handling. This file adds one thing: re-scan when the user
// selects a different video in the SPA (the <video> element is reused,
// its src and <track> change without a page navigation).

(function () {
  const video = document.getElementById('player');
  if (!video) return;

  video.addEventListener('loadstart', () => {
    // src was just set — reset the VTT cache and re-score with the new video
    _cijVttCache = null;
    scanPage();
  });
})();
