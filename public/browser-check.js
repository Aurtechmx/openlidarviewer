/*
 * browser-check.js: tell the reader plainly when their browser is too old.
 *
 * The app is built for ES2022, and its 3D view uses syntax that Safari parses
 * from 16.4 (iOS and iPadOS 16.4 on iPhone and iPad). An older browser shows
 * the page frame but can never load a scan, and its error reads like a stale
 * deploy. This classic script runs before the app and needs no modern syntax.
 *
 * CompressionStream arrived in Safari 16.4, Chrome 80 and Firefox 113;
 * structuredClone in Safari 15.4, Chrome 98 and Firefox 94. Together they mark
 * the oldest browsers the build runs in. WebGL 2 is required to draw at all.
 */
(function () {
  var ok =
    typeof window.CompressionStream === 'function' &&
    typeof window.structuredClone === 'function' &&
    typeof window.WebGL2RenderingContext === 'function';
  if (ok) return;
  document.documentElement.setAttribute('data-olv-unsupported', '');
  var box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.className = 'olv-unsupported-browser';
  var s = box.style;
  s.position = 'fixed';
  s.left = '16px';
  s.right = '16px';
  s.top = '16px';
  s.zIndex = '2147483647';
  s.padding = '16px';
  s.borderRadius = '8px';
  s.background = '#101a2e';
  s.color = '#eef2f8';
  s.font = '16px/1.4 system-ui, -apple-system, sans-serif';
  var title = document.createElement('strong');
  title.textContent = 'This browser is too old to run OpenLiDARViewer.';
  var body = document.createElement('p');
  body.style.margin = '8px 0 0';
  body.textContent =
    'It needs Safari 16.4 (iOS or iPadOS 16.4 on an iPhone or iPad), Chrome or Edge 98, ' +
    'Firefox 114, or a later version, with WebGL 2. Update the browser or the device, then reload.';
  box.appendChild(title);
  box.appendChild(body);
  document.body.appendChild(box);
})();
