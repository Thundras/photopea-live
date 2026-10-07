// Photopea Live — thin Electron shell around the real, always-current photopea.com.
// Fixes the two things a plain browser tab gets wrong on big files:
//  1. V8 heap is raised to ~80% of machine RAM instead of the browser-tab default.
//  2. Electron has no "Page Unresponsive / Wait-Exit" watchdog dialog by default — unlike
//     Chrome, it just lets a long synchronous operation finish instead of nagging the user.
// No offline mirroring, no patched bundle — needs internet, but is otherwise exactly the
// real site, so every button/menu/dialog works exactly as on photopea.com.
const { app, BrowserWindow, shell, session } = require('electron');
const os = require('os'), path = require('path');
const { version } = require('./package.json');

const heapMB = parseInt(process.env.PHOTOPEA_MAX_RAM_MB || '', 10) ||
               Math.max(4096, Math.round(os.totalmem() / 1048576 * 0.8));
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=' + heapMB);

// block ad/tracking networks at the request level — robust against Photopea's own code
// changing (unlike patching their minified bundle), since it only touches which domains
// this window is allowed to talk to.
const AD_HOSTS = [
  'googlesyndication.com', 'doubleclick.net', 'googleadservices.com',
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
  'adservice.google.com', 'pagead2.googlesyndication.com', 'securepubads.g.doubleclick.net',
  'fundingchoicesmessages.google.com', 'tpc.googlesyndication.com',
];
// Photopea's shell is a two-child flexbox: .flexrow.app > [workspace, ad-rail]. Neither
// child has flex-grow, so the ad-rail reserves its own width (up to 600px, flex-shrunk to
// fit) regardless of whether an ad actually renders in it — just hiding its *contents* (by
// matching Google's ad markup, or the "ad blocking detected" fallback link) leaves that
// space dead. Instead hide the ad-rail itself structurally (it's always the 2nd child) and
// give the workspace flex-grow so it actually reclaims the freed width. Verified this keeps
// the right-side tool panels (Layers/Channels/History) intact — an earlier attempt that
// forced the workspace to width:100% instead broke them.
//
// Applied as JS (not just insertCSS) via a MutationObserver + interval, not a one-shot
// dom-ready hook: Photopea is a heavy SPA that builds this markup well after dom-ready, and
// a single injection can lose a race against that. Re-applying on every DOM mutation (and as
// a fallback, once a second for the first 20s) makes this resilient to timing instead of
// depending on catching one exact moment.
const FIX_JS = `
(function() {
  function apply() {
    var app = document.querySelector('.flexrow.app');
    if (!app || app.children.length < 2) { console.log('[adfix] no .flexrow.app with 2+ children yet'); return; }
    var main = app.children[0], adRail = app.children[1];
    main.style.setProperty('flex-grow', '1', 'important');
    adRail.style.setProperty('display', 'none', 'important');
    console.log('[adfix] applied, adRail now display=' + getComputedStyle(adRail).display);
  }
  apply();
  try {
    new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { console.log('[adfix] observer error', e); }
  var tries = 0;
  var iv = setInterval(function() { apply(); if (++tries > 20) clearInterval(iv); }, 1000);
})();
`;

let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
      const blocked = AD_HOSTS.some(h => details.url.includes(h));
      cb({ cancel: blocked });
    });
    win = new BrowserWindow({
      width: 1440, height: 900,
      icon: path.join(__dirname, 'icon.png'),
      autoHideMenuBar: true,
      title: 'Photopea Live v' + version,
    });
    win.removeMenu();
    // Photopea sets document.title itself (e.g. "Photopea | Online Photo Editor"), which
    // would otherwise overwrite our version-tagged title on every load.
    win.on('page-title-updated', (e) => e.preventDefault());
    // Jampea "Input" menu: grant Web MIDI, and auto-pick the first device for Web Bluetooth
    // (Electron has no built-in chooser UI for navigator.bluetooth.requestDevice).
    win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(true));
    win.webContents.on('select-bluetooth-device', (e, devices, cb) => {
      e.preventDefault();
      if (devices.length) cb(devices[0].deviceId);
    });
    // keep external links (About/Blog/API/...) in the system browser, not this window
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    const runFix = () => win.webContents.executeJavaScript(FIX_JS).catch((e) => console.log('[adfix] inject failed', e));
    win.webContents.on('dom-ready', runFix);
    win.webContents.on('did-finish-load', runFix);
    if (process.env.PHOTOPEA_DEBUG === '1') {
      win.webContents.on('console-message', (e, level, message) => console.log('[page]', message));
    }
    // bare "/" serves the marketing landing page with a "Start Photopea" button; a URL
    // fragment makes photopea.com's own bootstrap script skip straight to the editor.
    win.loadURL('https://www.photopea.com/#');
    win.on('closed', () => { win = null; });
  });
  app.on('window-all-closed', () => app.quit());
}
