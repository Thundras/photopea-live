// Photopea Live — thin Electron shell around the real, always-current photopea.com.
// Fixes the two things a plain browser tab gets wrong on big files:
//  1. V8 heap is raised to ~80% of machine RAM instead of the browser-tab default.
//  2. Electron has no "Page Unresponsive / Wait-Exit" watchdog dialog by default — unlike
//     Chrome, it just lets a long synchronous operation finish instead of nagging the user.
// No offline mirroring, no patched bundle — needs internet, but is otherwise exactly the
// real site, so every button/menu/dialog works exactly as on photopea.com.
const { app, BrowserWindow, shell, session } = require('electron');
const os = require('os'), path = require('path'), fs = require('fs');
const { version } = require('./package.json');

// Always-on file log for the ad-rail fix: PowerShell doesn't reliably forward a GUI exe's
// console output, so console.log alone isn't enough to debug this on someone else's machine.
const LOG_PATH = path.join(os.tmpdir(), 'photopea-live-debug.log');
fs.writeFileSync(LOG_PATH, '--- Photopea Live v' + version + ' started ' + new Date().toISOString() + ' ---\n');
function logLine(s) {
  try { fs.appendFileSync(LOG_PATH, '[' + new Date().toISOString().slice(11, 23) + '] ' + s + '\n'); } catch (e) {}
}

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
// The ad-rail fix itself lives in preload.js, loaded via webPreferences.preload below — that
// runs before any of Photopea's own scripts (confirmed via logging that dom-ready/did-finish-load
// injection is too late: the ad rail is already built and visible by then, causing a ~0.4-0.5s
// flash before we catch up). A raw CDP debugger.attach() can do the same thing but hung
// indefinitely in testing; a preload script is the standard, documented way to get this timing.

let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
      const blocked = AD_HOSTS.some(h => details.url.includes(h));
      cb({ cancel: blocked });
    });
    win = new BrowserWindow({
      width: 1440, height: 900,
      icon: path.join(__dirname, 'icon.png'),
      autoHideMenuBar: true,
      title: 'Photopea Live v' + version,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: false, // preload needs to share Photopea's own `window`/`document`
      },
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
    win.webContents.on('console-message', (e, level, message) => {
      if (/\[adfix\]/.test(message)) logLine('[page] ' + message);
    });
    // Photopea's own resize math subtracts a hardcoded width for the ad rail from
    // window.innerWidth no matter whether anything is actually shown there — confirmed by
    // direct testing (dispatching 'resize' after hiding the ad rail at several widths never
    // reclaimed the space, because Photopea isn't measuring the ad element, just subtracting a
    // constant baked into their own minified bundle). Rather than resize our actual OS window
    // (which can't track live dragging/maximize without fighting the user), tell Photopea via
    // page zoom that it has AD_GUTTER_PX more width than the window really is — Photopea's
    // hardcoded subtraction then roughly cancels out, handing the workspace the actual full
    // window width. webContents.setZoomFactor() is Electron/Chromium's real page zoom (same
    // mechanism as Ctrl+scroll): zooming out genuinely increases how much CSS-pixel content
    // fits, so window.innerWidth grows accordingly, and (unlike a CSS `zoom`/`transform` style
    // on the page's own content) mouse clicks stay correctly aligned with what's drawn, since
    // the browser itself — not a page style — is doing the scaling and remapping input to match.
    const AD_GUTTER_PX = 320;
    const applyVirtualWidth = () => {
      const [w] = win.getContentSize();
      win.webContents.setZoomFactor(w / (w + AD_GUTTER_PX));
    };
    win.webContents.on('did-finish-load', applyVirtualWidth);
    win.on('resize', applyVirtualWidth);
    logLine('log file: ' + LOG_PATH);
    // bare "/" serves the marketing landing page with a "Start Photopea" button; a URL
    // fragment makes photopea.com's own bootstrap script skip straight to the editor.
    win.loadURL('https://www.photopea.com/#');
    win.on('closed', () => { win = null; });
  });
  app.on('window-all-closed', () => app.quit());
}
