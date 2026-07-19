using System;
using System.Diagnostics;
using System.IO;

internal static class MiniMaxTokenCounterLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            // The launcher lives next to the project root. The Electron bundle
            // lives in <root>/Runtime/.
            string root = AppContext.BaseDirectory.TrimEnd('\\', '/');
            string target = Path.Combine(root, "Runtime", "MiniMaxTokenCounter.exe");
            if (!File.Exists(target)) {
                target = Path.Combine(root, "MiniMaxTokenCounter", "MiniMaxTokenCounter.exe");
            }

            if (!File.Exists(target)) {
                System.Windows.Forms.MessageBox.Show(
                    "MiniMaxTokenCounter.exe was not found in Runtime or MiniMaxTokenCounter.\n\nRoot: " + root,
                    "MiniMax Token Counter",
                    System.Windows.Forms.MessageBoxButtons.OK,
                    System.Windows.Forms.MessageBoxIcon.Error);
                return 1;
            }

            var psi = new ProcessStartInfo {
                FileName = target,
                WorkingDirectory = Path.GetDirectoryName(target),
                UseShellExecute = true
            };
            Process.Start(psi);
            return 0;
        }
        catch (Exception ex)
        {
            System.Windows.Forms.MessageBox.Show(
                "Failed to start MiniMax Token Counter:\n" + ex.Message,
                "MiniMax Token Counter",
                System.Windows.Forms.MessageBoxButtons.OK,
                System.Windows.Forms.MessageBoxIcon.Error);
            return 2;
        }
    }
}

