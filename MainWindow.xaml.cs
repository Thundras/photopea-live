using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;

namespace PhotopeaLive;

/// <summary>
/// Photopea Live — a thin WebView2 shell around the real, always-current photopea.com.
///
/// Why WPF/WebView2 instead of Electron: Photopea's own layout math always reserves a
/// fixed-width "ad rail" (its own hardcoded constant, not measured from the ad element — hiding
/// the ad alone never reclaims the space). The original plan was to make the browser's zoom lie
/// to Photopea about the window's width (via WebView2's ZoomFactor / Electron's
/// setZoomFactor), the same way both builds tried and failed to do reliably.
///
/// Root cause found via CDP (Page.getLayoutMetrics + Object.getOwnPropertyDescriptor): Photopea's
/// own bootstrap code replaces the native `window.innerWidth`/`innerHeight` getters with plain,
/// static, one-time-captured number properties (confirmed: the descriptor is a plain
/// {value, writable} data property, not a getter) — presumably to get a stable reading immune to
/// zoom/resize jitter during its own layout math. That means Photopea's ad-rail subtraction never
/// reads the browser's real, live viewport at all, so no amount of host-level zoom trickery could
/// ever reach it — confirmed by CDP showing the *real* viewport (document.documentElement
/// .clientWidth, visualViewport.width) tracking zoom correctly the whole time, while
/// window.innerWidth stayed frozen at the original unzoomed value regardless.
///
/// The actual fix: skip zoom/scaling entirely. Since Photopea's own innerWidth is just a plain
/// writable property (not protected), InnerWidthOverrideScript redefines it as a live getter —
/// always true width + AdGutterPx — before Photopea's bootstrap ever runs and claims it for
/// itself. A resize event is then dispatched on every real size change so Photopea's own resize
/// handler re-reads the (now always-padded) value and relayouts.
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

    // Runs via AddScriptToExecuteOnDocumentCreatedAsync — WebView2's equivalent of a
    // document-start preload script, before any of Photopea's own scripts. Two independent fixes
    // in one script, both needed before Photopea's bootstrap claims innerWidth for itself:
    //
    // 1. Redefine window.innerWidth/innerHeight as live getters that always report the *true*
    //    current size (via document.documentElement.clientWidth/Height, which stays accurate —
    //    only the native innerWidth/innerHeight getters get shadowed by Photopea) plus
    //    AdGutterPx padding on width. Photopea's own ad-rail-reservation math then subtracts its
    //    320px from an already-320px-padded number and lands on the real width.
    // 2. Hide the ad-rail element itself (always the flexbox's 2nd child, whether an ad renders
    //    there or not) and give the workspace flex-grow so it visually claims the freed width.
    //    Re-applied via a resize listener, a MutationObserver, and an interval fallback, since
    //    Photopea's own resize handler reassigns the ad rail's inline style on every
    //    resize/maximize — a plain JS style assignment there replaces our !important declaration
    //    outright since it's the same inline style object.
    private static readonly string PreloadScript = @"
(function() {
  if (window.__ppLiveInstalled) return;
  window.__ppLiveInstalled = true;
  var GUTTER = " + AdGutterPx + @";

  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    enumerable: true,
    get: function() { return (document.documentElement.clientWidth || 0) + GUTTER; },
    set: function() {} // ignore writes from Photopea's own resize handler
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    enumerable: true,
    get: function() { return document.documentElement.clientHeight || 0; },
    set: function() {}
  });

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

        SizeChanged += (_, _) => DispatchResize();
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

        // innerWidth override + ad-rail fix: runs before Photopea's own scripts on every
        // navigation, so Photopea's bootstrap only ever sees the already-padded width.
        await core.AddScriptToExecuteOnDocumentCreatedAsync(PreloadScript);

        core.NavigationCompleted += (_, _) => DispatchResize();

        // bare "/" serves the marketing landing page with a "Start Photopea" button; a URL
        // fragment makes photopea.com's own bootstrap script skip straight to the editor.
        core.Navigate("https://www.photopea.com/#");
    }

    // The innerWidth getter in PreloadScript always computes live from the true DOM width, so no
    // measurement/correction loop is needed — we just need Photopea to re-read it whenever the
    // real size changes, by dispatching a resize event.
    private async void DispatchResize()
    {
        var core = Browser.CoreWebView2;
        if (core == null) return;
        try { await core.ExecuteScriptAsync("window.dispatchEvent(new Event('resize'))"); }
        catch { /* page may not be ready yet; NavigationCompleted will fire again */ }
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
