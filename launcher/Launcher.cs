// PC Live Dash launcher (Windows).
//
// A small windowless program that starts the tray app (tray.ps1) without a
// console window appearing. It is what the Start menu shortcuts and the
// start-at-sign-in entry point to.
//
//   "PC Live Dash.exe"             start the tray app
//   "PC Live Dash.exe" --open      start it and open the dashboard
//   "PC Live Dash.exe" --settings  start it and open the settings window
//   "PC Live Dash.exe" --quit      stop a running tray app and its server
//
// Built with the C# compiler that ships with Windows (.NET Framework), so it
// sticks to C# 5 syntax. See scripts/build-launcher.ps1.

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

internal static class Launcher
{
    [STAThread]
    private static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string script = Path.Combine(dir, "tray.ps1");
        if (!File.Exists(script))
        {
            MessageBox.Show("tray.ps1 was not found next to this program:\n" + dir,
                "PC Live Dash", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        string scriptArgs = "";
        bool wait = false;
        foreach (string arg in args)
        {
            switch (arg.ToLowerInvariant())
            {
                case "--open": scriptArgs += " -OpenDashboard"; break;
                case "--settings": scriptArgs += " -Settings"; break;
                case "--quit": scriptArgs += " -Quit"; wait = true; break;
            }
        }

        string powershell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
        ProcessStartInfo info = new ProcessStartInfo();
        info.FileName = powershell;
        info.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"" + scriptArgs;
        info.WorkingDirectory = dir;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;

        try
        {
            using (Process process = Process.Start(info))
            {
                if (wait && process != null)
                {
                    process.WaitForExit(30000);
                }
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("PC Live Dash could not start:\n" + ex.Message,
                "PC Live Dash", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        return 0;
    }
}
