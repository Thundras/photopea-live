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
  hiding the ad (which this app also does) never reclaims that space on its own. This app tells
  Photopea, via `WebView2.ZoomFactor`, that the window has exactly that much more width than it
  really does, so Photopea's hardcoded subtraction cancels out and the workspace gets the actual
  full window width — recalculated live on every resize and maximize.

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
resulting `window.innerWidth` repeatedly didn't match the requested zoom factor, even with an
empirical self-correcting feedback loop, for reasons never fully pinned down. WebView2's own
`ZoomFactor` — Microsoft's documented property for exactly this kind of app-level content scaling
— worked correctly from the first try, verified three independent ways (the DOM's own reported
width, a DevTools-protocol screenshot, and a raw screen-region capture of the actual window, both
at default size and maximized). See the commit history for the full trail, including why
`RasterizationScale` (tried first) was the wrong tool — it's Microsoft's property for tracking
monitor DPI, not app scaling, and isn't even exposed on the convenience WPF control.

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
