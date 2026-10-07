// Photopea Live — thin Electron shell around the real, always-current photopea.com.
// Fixes the two things a plain browser tab gets wrong on big files:
//  1. V8 heap is raised to ~80% of machine RAM instead of the browser-tab default.
//  2. Electron has no "Page Unresponsive / Wait-Exit" watchdog dialog by default — unlike
//     Chrome, it just lets a long synchronous operation finish instead of nagging the user.
// No offline mirroring, no patched bundle — needs internet, but is otherwise exactly the
// real site, so every button/menu/dialog works exactly as on photopea.com.
const { app, BrowserWindow, shell, session } = require('electron');
const os = require('os'), path = require('path');

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
const AD_CSS = `
  iframe[id^="google_ads_iframe"], ins.adsbygoogle, div[id^="div-gpt-ad"],
  [id*="google_ads"], [class*="GoogleActiveViewElement"] { display: none !important; }
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
    });
    win.removeMenu();
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
    win.webContents.on('dom-ready', () => { win.webContents.insertCSS(AD_CSS).catch(() => {}); });
    win.loadURL('https://www.photopea.com/');
    win.on('closed', () => { win = null; });
  });
  app.on('window-all-closed', () => app.quit());
}
