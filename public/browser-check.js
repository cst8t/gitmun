/* Browser compatibility check - plain ES5, runs synchronously before the module bundle.
 *
 * Uses CSS.supports() for feature detection rather than UA version sniffing.
 * WebKitGTK on Linux reports a frozen UA string (always AppleWebKit/605.1.15)
 * regardless of the actual engine version, making UA-based checks unreliable there.
 * Feature detection works correctly on all platforms.
 *
 * Required features (determined from caniuse-lite against the app's CSS/JS):
 *   CSS Grid, CSS Custom Properties, position:sticky (or -webkit-sticky)
 *
 * Chromium version is still checked via UA for WebView2 on Windows, where the
 * version string is accurate and ES module support (Chrome 61+) is the constraint.
 */
(function () {
  var unsupported = false;
  var body = '';

  /* CSS feature detection -------------------------------------------------- */
  if (typeof CSS === 'undefined' || !CSS.supports) {
    unsupported = true;
    body = 'Your browser engine is too old to run this application.';
  } else {
    var missing = [];
    if (!CSS.supports('display', 'grid')) missing.push('CSS Grid');
    if (!CSS.supports('color', 'var(--a)')) missing.push('CSS Custom Properties');
    if (!CSS.supports('position', 'sticky') && !CSS.supports('position', '-webkit-sticky')) {
      missing.push('position: sticky');
    }
    if (missing.length > 0) {
      unsupported = true;
      body = 'Missing required CSS features: <strong style="color:#e2e4eb;">' + missing.join(', ') + '</strong>.';
    }
  }

  /*
   * ES2020 syntax probes are disabled for now. Tauri's CSP can block
   * Function() even when the webview supports the syntax, which makes this
   * check report a false unsupported browser.
   *
   * function canParse(source) {
   *   try {
   *     new Function(source);
   *     return true;
   *   } catch (e) {
   *     return false;
   *   }
   * }
   *
   * if (!unsupported) {
   *   var missingJs = [];
   *   if (!canParse('var value = ({ a: 1 })?.a;')) missingJs.push('optional chaining');
   *   if (!canParse('var value = null ?? 1;')) missingJs.push('nullish coalescing');
   *   if (missingJs.length > 0) {
   *     unsupported = true;
   *     body = 'Missing required JavaScript features: <strong style="color:#e2e4eb;">' + missingJs.join(', ') + '</strong>.';
   *   }
   * }
   */

  /* Chromium version check (WebView2 on Windows only) ---------------------- */
  if (!unsupported) {
    var ua = navigator.userAgent;
    var chromeMatch = ua.match(/Chrome\/(\d+)/);
    var isChromium = !!(chromeMatch && ua.indexOf('AppleWebKit/537.36') !== -1);
    if (isChromium && chromeMatch) {
      var cv = parseInt(chromeMatch[1], 10);
      if (cv < 61) {
        unsupported = true;
        body =
          'Gitmun requires <strong style="color:#e2e4eb;">Chromium 61+</strong>.<br>' +
          'Your current version is <strong style="color:#f87171;">Chromium ' + cv + '</strong>.';
      }
    }
  }

  if (unsupported) {
    var overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:100%;' +
      'background:#0f1117;display:flex;align-items:center;justify-content:center;' +
      'z-index:99999;font-family:system-ui,-apple-system,sans-serif;';
    overlay.innerHTML =
      '<div style="max-width:480px;padding:32px;background:#161921;border:1px solid #2a2e3e;border-radius:8px;text-align:center;">' +
      /* Warning (Fill) icon from Phosphor Icons - https://phosphoricons.com - MIT License */
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 256 256" fill="#f87171" style="margin-bottom:16px;">' +
      '<path d="M236.8,188.09,149.35,36.22a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z"/>' +
      '</svg>' +
      '<h1 style="font-size:18px;font-weight:600;margin:0 0 12px;color:#f87171;">Unsupported Browser Engine</h1>' +
      '<p style="font-size:13px;color:#8b8fa3;line-height:1.6;margin:0 0 16px;">' + body + '</p>' +
      '<p style="font-size:12px;color:#555972;margin:0;">Please update your operating system to use a newer version.</p>' +
      '</div>';
    document.body.appendChild(overlay);
  }
})();
