// Runs before any of Photopea's own scripts (contextIsolation: false, so this shares the
// same `window`/`document` the page itself gets) — see the comment in main.js for why this
// needs to run this early rather than on dom-ready/did-finish-load.
//
// Photopea's shell is a two-child flexbox: .flexrow.app > [workspace, ad-rail]. Neither child
// has flex-grow, so the ad-rail reserves its own width (up to 600px, flex-shrunk to fit)
// regardless of whether an ad actually renders in it — just hiding its *contents* leaves that
// space dead. Instead hide the ad-rail itself structurally (it's always the 2nd child) and
// give the workspace flex-grow so it actually reclaims the freed width. Verified this keeps
// the right-side tool panels (Layers/Channels/History) intact — an earlier attempt that forced
// the workspace to width:100% instead broke them.
//
// Kept re-applying indefinitely via a 'resize' listener, a MutationObserver (childList +
// style/class attributes), and an interval as a last-resort fallback: Photopea's own resize
// handler reassigns the ad rail's inline style on every resize/maximize, and a plain JS style
// assignment there replaces our !important declaration outright since it's the same inline
// style object — so a fix that only runs once (or stops retrying) can get silently clobbered
// by a later resize.
(function() {
  // Report our own innerWidth back to the main process so it can verify the zoom factor it
  // set actually produced the target width — needed because setZoomFactor(w/(w+pad)) doesn't
  // reliably land on exactly w+pad (observed ~5% off in testing, cause unconfirmed — possibly
  // OS display scaling interacting with Chromium's zoom-level quantization). Reporting
  // repeatedly for the first few seconds gives main.js's corrective loop in main.js several
  // chances to converge after each zoom adjustment, since changing zoom doesn't necessarily
  // fire a 'resize' DOM event we could otherwise hook for a single remeasurement.
  function reportWidth() { console.log('[adfix][widthreport] ' + window.innerWidth); }
  reportWidth();
  var reportTries = 0;
  var reportIv = setInterval(function() { reportWidth(); if (++reportTries > 20) clearInterval(reportIv); }, 150);
  window.addEventListener('resize', reportWidth);

  function install() {
    if (window.__adfixInstalled) return;
    window.__adfixInstalled = true;
    var lastState = null;
    function apply(trigger) {
      var appEl = document.querySelector('.flexrow.app');
      if (!appEl || appEl.children.length < 2) return;
      var main = appEl.children[0], adRail = appEl.children[1];
      main.style.setProperty('flex-grow', '1', 'important');
      adRail.style.setProperty('display', 'none', 'important');
      var state = Math.round(adRail.getBoundingClientRect().width) + '/' + adRail.children.length;
      if (state !== lastState) {
        console.log('[adfix][' + trigger + '] adRail -> ' + state + '; innerWidth=' + window.innerWidth);
        lastState = state;
      }
    }
    apply('initial');
    window.addEventListener('resize', function() { apply('resize'); });
    try {
      // Observe `document` itself, not document.documentElement — at document-start (preload
      // runs before the parser has created <html> yet) documentElement can still be null,
      // which throws; `document` is always a valid Node, and subtree:true still catches
      // everything added under it once parsing proceeds.
      new MutationObserver(function() { apply('mutation'); }).observe(document,
        { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    } catch (e) { console.log('[adfix] observer error', e); }
    setInterval(function() { apply('interval'); }, 500);
  }
  install();
})();
