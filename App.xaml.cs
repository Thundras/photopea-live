using System;
using System.Threading;
using System.Windows;

namespace PhotopeaLive;

public partial class App : Application
{
    private Mutex? _singleInstanceMutex;

    protected override void OnStartup(StartupEventArgs e)
    {
        _singleInstanceMutex = new Mutex(true, "PhotopeaLive-SingleInstance", out var createdNew);
        if (!createdNew)
        {
            // another instance is already running — just exit, no window to bring forward here
            // without extra IPC plumbing (unlike the Electron build), which isn't worth it yet.
            Shutdown();
            return;
        }
        base.OnStartup(e);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _singleInstanceMutex?.ReleaseMutex();
        base.OnExit(e);
    }
}
