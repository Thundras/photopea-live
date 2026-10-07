# Photopea Live

A tiny Electron window around the real, always-current [photopea.com](https://www.photopea.com) —
built to fix two specific annoyances of using Photopea in a regular browser tab on large PSD
files, without touching Photopea's own code at all:

- **No "Page Unresponsive" popup.** Chrome's hang-watchdog dialog ("Wait / Exit page") is a
  browser-UI feature, not something Photopea does — it fires whenever the main thread is busy for
  a few seconds, which heavy filters/exports on big documents trigger constantly. Electron doesn't
  implement that dialog by default, so long operations just finish instead of nagging you.
- **Raised memory ceiling.** V8's heap cap is raised to ~80% of the machine's RAM
  (`--max-old-space-size`, see `main.js`) instead of the browser's default tab limit.

Ads and Google's ad/tracking network requests are blocked (see `AD_HOSTS` / `AD_CSS` in
`main.js`) — this is a plain network-level + CSS blocklist, so it doesn't depend on Photopea's own
(frequently-changing, minified) code and won't break when they ship an update.

This intentionally loads the **real** site rather than an offline copy: an earlier attempt at a
fully offline, patched build of Photopea turned out to be too fragile to maintain (Photopea's
minified bundle changes often enough that string-based patches go stale and can silently break
menus/dialogs) — see the project history if you want the details. This approach trades "fully
offline" for "always works, zero maintenance."

## Run it

Grab `PhotopeaLive-portable.exe` from [Releases](../../releases) — single file, no installer,
just run it. Needs an internet connection (it's loading the live site).

## Build from source

```sh
npm install
npm run build
```

→ `dist/PhotopeaLive-portable.exe`

## Configuration

- `PHOTOPEA_MAX_RAM_MB` env var overrides the auto-detected heap size (default: 80% of system RAM,
  minimum 4096).
