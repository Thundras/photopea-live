using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace PhotopeaLive;

/// <summary>
/// Photopea Live — a thin WebView2 shell around the real, always-current photopea.com.
///
/// Why WPF/WebView2 instead of Electron: Photopea's own layout math always reserves a
/// fixed-width "ad rail" (its own hardcoded constant, not measured from the ad element — hiding
/// the ad alone never reclaims the space). The fix is to make Photopea believe the window has
/// AdGutterPx more width than it really does, via WebView2's own ZoomFactor. The Electron build
/// tried the equivalent (WebContents.setZoomFactor, the same underlying Chromium mechanism) and
/// it was unreliable there — the resulting innerWidth repeatedly didn't match the requested
/// factor, even with an empirical self-correcting feedback loop, for reasons never pinned down.
/// WebView2's own ZoomFactor — Microsoft's documented property for exactly this kind of app
/// scaling (RasterizationScale, tried first here, turned out to be the wrong tool: it's
/// documented as being for monitor-DPI tracking, and isn't even exposed on this control) —
/// behaved correctly from the first try and was verified three independent ways: the DOM's own
/// reported innerWidth, a CDP screenshot, and a raw screen-region capture (CopyFromScreen) of
/// the actual window, both at the default size and maximized.
/// </summary>
public partial class MainWindow : Window
{
    // Photopea's own ad-rail reservation, discovered by testing (not derived from anything we
    // can query) — see the Electron build's commit history for how this number was found.
    private const int AdGutterPx = 320;

    // block ad/tracking networks — robust against Photopea's own code changing (unlike patching
    // their minified bundle), since it only touches which domains this control is allowed to
    // talk to.
    private static readonly string[] AdHosts =
    {
        "googlesyndication.com", "doubleclick.net", "googleadservices.com",
        "google-analytics.com", "googletagmanager.com", "googletagservices.com",
        "adservice.google.com", "pagead2.googlesyndication.com", "securepubads.g.doubleclick.net",
        "fundingchoicesmessages.google.com", "tpc.googlesyndication.com",
    };

    // Photopea's shell is a two-child flexbox: .flexrow.app > [workspace, ad-rail]. Hide the
    // ad-rail (always the 2nd child, whether showing a real ad or nothing) and give the
    // workspace flex-grow so it claims the freed width. Runs via
    // AddScriptToExecuteOnDocumentCreatedAsync, WebView2's equivalent of a document-start
    // preload script — before any of Photopea's own scripts, confirmed necessary in the
    // Electron build (a dom-ready-equivalent hook was consistently too late, causing a visible
    // flash). Re-applied via a resize listener, a MutationObserver, and an interval fallback,
    // since Photopea's own resize handler reassigns the ad rail's inline style on every
    // resize/maximize — a plain JS style assignment there replaces our !important declaration
    // outright since it's the same inline style object.
    private const string AdRailFixScript = @"
(function() {
  if (window.__adfixInstalled) return;
  window.__adfixInstalled = true;
  function apply() {
    var appEl = document.querySelector('.flexrow.app');
    if (!appEl || appEl.children.length < 2) return;
    var main = appEl.children[0], adRail = appEl.children[1];
    main.style.setProperty('flex-grow', '1', 'important');
    adRail.style.setProperty('display', 'none', 'important');
  }
  apply();
  window.addEventListener('resize', apply);
  try {
    new MutationObserver(apply).observe(document, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class']
    });
  } catch (e) {}
  setInterval(apply, 500);
})();
";

    private readonly string _logPath = Path.Combine(Path.GetTempPath(), "photopea-live-debug.log");

    public MainWindow()
    {
        InitializeComponent();
        Title = "Photopea Live v" + (GetType().Assembly.GetName().Version?.ToString(3) ?? "dev");
        Log("started " + DateTime.Now.ToString("O"));

        SizeChanged += (_, _) => UpdateVirtualSize();
        Loaded += async (_, _) => await InitializeAsync();
    }

    private void Log(string s)
    {
        try { File.AppendAllText(_logPath, $"[{DateTime.Now:HH:mm:ss.fff}] {s}\n"); } catch { /* best-effort */ }
    }

    private async System.Threading.Tasks.Task InitializeAsync()
    {
        var heapMbOverride = Environment.GetEnvironmentVariable("PHOTOPEA_MAX_RAM_MB");
        var heapMb = long.TryParse(heapMbOverride, out var overrideMb) && overrideMb > 0
            ? overrideMb
            : Math.Max(4096, (long)(GetTotalPhysicalMemoryMb() * 0.8));
        var options = new CoreWebView2EnvironmentOptions
        {
            AdditionalBrowserArguments = $"--js-flags=--max-old-space-size={heapMb}",
        };
        var env = await CoreWebView2Environment.CreateAsync(null, null, options);
        await Browser.EnsureCoreWebView2Async(env);

        var core = Browser.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;

        // ad/tracking network blocking
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (_, args) =>
        {
            var url = args.Request.Uri;
            if (AdHosts.Any(h => url.Contains(h, StringComparison.OrdinalIgnoreCase)))
            {
                args.Response = core.Environment.CreateWebResourceResponse(
                    null, 403, "Blocked", "");
            }
        };

        // ad-rail fix: runs before Photopea's own scripts on every navigation
        await core.AddScriptToExecuteOnDocumentCreatedAsync(AdRailFixScript);

        UpdateVirtualSize();

        // bare "/" serves the marketing landing page with a "Start Photopea" button; a URL
        // fragment makes photopea.com's own bootstrap script skip straight to the editor.
        core.Navigate("https://www.photopea.com/#");
    }

    private void UpdateVirtualSize()
    {
        if (Browser.CoreWebView2 == null) return; // not initialized yet; InitializeAsync calls us again once it is
        var w = Browser.ActualWidth;
        if (w <= 0) return;
        var zoom = w / (w + AdGutterPx);
        Browser.ZoomFactor = zoom;
        Log($"UpdateVirtualSize: actualWidth={w:F0} zoomFactor={zoom:F4}");
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

    private static double GetTotalPhysicalMemoryMb()
    {
        try
        {
            var status = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
            if (GlobalMemoryStatusEx(ref status)) return status.ullTotalPhys / 1024.0 / 1024.0;
        }
        catch { /* fall through to default below */ }
        return 8192; // conservative fallback
    }
}
