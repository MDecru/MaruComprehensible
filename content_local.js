// Local CIJ player (mdnas.local / cij.punchyface.synology.me)
// content_cij.js already runs first and handles all scoring, hover, sidebar,
// and message handling. This file adds one thing: re-scan when the user
// selects a different video in the SPA (the <video> element is reused,
// its src and <track> change without a page navigation).

(function () {
  const video = document.getElementById('player');
  if (!video) return;

  // Ensure the video element holds 16:9 space even when the poster image is
  // missing (common for YouTube-downloaded videos with no local thumbnail).
  const style = document.createElement('style');
  style.textContent = '#player { aspect-ratio: 16/9; }';
  document.head.appendChild(style);

  video.addEventListener('loadstart', () => {
    // src was just set — reset the VTT cache and re-score with the new video
    _cijVttCache = null;
    scanPage();
  });
})();
