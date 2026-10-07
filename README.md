# Photopea Live

A tiny WPF/WebView2 window around the real, always-current [photopea.com](https://www.photopea.com)
— built to fix three specific annoyances of using Photopea in a regular browser tab on large PSD
files, without touching Photopea's own code at all:

- **No "Page Unresponsive" popup.** Chrome's hang-watchdog dialog ("Wait / Exit page") is a
  browser-UI feature, not something Photopea does — it fires whenever the main thread is busy for
  a few seconds, which heavy filters/exports on big documents trigger constantly. A plain embedded
  browser control doesn't implement that dialog, so long operations just finish instead of nagging
  you.
- **Raised memory ceiling.** The Chromium engine's heap cap is raised to ~80% of the machine's RAM
  (`--js-flags=--max-old-space-size=...`, see `MainWindow.xaml.cs`) instead of the browser's
  default tab limit.
- **No dead empty strip where an ad would go.** Photopea's own layout math always reserves a
  fixed-width "ad rail" regardless of whether anything actually renders there — it's a hardcoded
  constant in their own minified bundle, not something computed from the ad element, so just
  hiding the ad (which this app also does) never reclaims that space on its own. This app
  redefines `window.innerWidth` (see "How the ad-rail fix actually works" below) so Photopea's
  hardcoded subtraction cancels out and the workspace gets the actual full window width —
  recalculated live on every resize and maximize.

Ads and Google's ad/tracking network requests are blocked (`AdHosts` in `MainWindow.xaml.cs`) —
a plain network-level blocklist, so it doesn't depend on Photopea's own (frequently-changing,
minified) code and won't break when they ship an update.

This intentionally loads the **real** site rather than an offline copy: an earlier attempt at a
fully offline, patched build of Photopea turned out to be too fragile to maintain (Photopea's
minified bundle changes often enough that string-based patches go stale and can silently break
menus/dialogs). This approach trades "fully offline" for "always works, zero maintenance."

## Why WPF/WebView2, not Electron

The first version of this app was Electron-based. Functionally it got to the same place, but the
ad-rail-width fix (`WebContents.setZoomFactor`) turned out to be unreliable in practice — the
resulting `window.innerWidth` repeatedly didn't match the requested zoom factor. The WPF rewrite
tried the equivalent WebView2 `ZoomFactor` property next, which also didn't move `innerWidth` —
see below for why neither ever could.

## How the ad-rail fix actually works

Both zoom-based approaches above were chasing the wrong lever. Inspecting the live page via the
Chrome DevTools Protocol (`Page.getLayoutMetrics` and
`Object.getOwnPropertyDescriptor(window, 'innerWidth')`) showed that Photopea's own bootstrap code
replaces the native `window.innerWidth`/`innerHeight` getters with a plain, static,
one-time-captured number — not a live getter. Meanwhile the *real* viewport
(`document.documentElement.clientWidth`, `visualViewport.width`) tracked zoom perfectly the whole
time. In other words: Photopea's own ad-rail math never reads the browser's real width at all, so
no amount of host-level zoom trickery could ever reach it.

The fix (`PreloadScript` in `MainWindow.xaml.cs`, injected via
`AddScriptToExecuteOnDocumentCreatedAsync` before any of Photopea's own code runs) redefines
`window.innerWidth` as a live getter that always returns the true current width (from
`document.documentElement.clientWidth`, which stays accurate) plus `AdGutterPx`. Since Photopea's
bootstrap finds the property already defined this way, it never gets the chance to shadow it with
its own frozen copy. A `resize` event is then dispatched on every real size change so Photopea's
own resize handler re-reads the (always-padded) value and relayouts. No zoom, no measurement loop,
no retries — verified via CDP and screenshots at default size, after an arbitrary resize, and
maximized, each time with a real document open (not just the welcome screen, whose left-aligned
layout can look deceptively fine either way).

## Run it

Grab `PhotopeaLive.exe` from [Releases](../../releases) — single file, self-contained (no .NET
install needed), just run it. Needs an internet connection (it's loading the live site) and the
WebView2 runtime, which ships with Windows 10/11 by default.

## Build from source

```sh
dotnet publish -c Release
```

→ `bin/Release/net9.0-windows/win-x64/publish/PhotopeaLive.exe`

## Configuration

- `PHOTOPEA_MAX_RAM_MB` env var overrides the auto-detected heap size (default: 80% of system RAM,
  minimum 4096).
