using System.Runtime.InteropServices;
using System.Text.Json;
using System.Diagnostics;

// Only hosts a child HWND. Playback and all file permissions remain in Electron.
internal static class Program
{
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);

    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length != 2 || !long.TryParse(args[0], out var parent) || !int.TryParse(args[1], out var pid)) return;
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        // WinExe avoids a console; explicitly use the inherited redirected handles.
        using var input = new StreamReader(new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(GetStdHandle(-10), false), FileAccess.Read));
        using var output = new StreamWriter(new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(GetStdHandle(-11), false), FileAccess.Write)) { AutoFlush = true };
        using var host = new HostWindow(new IntPtr(parent));
        var context = new ApplicationContext();
        using var dispatcher = new Control();
        dispatcher.CreateControl();
        var timer = new System.Windows.Forms.Timer { Interval = 1000 };
        timer.Tick += (_, _) => {
            try { if (!IsWindow(new IntPtr(parent)) || Process.GetProcessById(pid).HasExited) context.ExitThread(); }
            catch { context.ExitThread(); }
        };
        timer.Start();
        output.WriteLine(JsonSerializer.Serialize(new { hwnd = host.Handle.ToInt64() }));
        _ = Task.Run(async () => {
            try {
                while (await input.ReadLineAsync() is { } line) {
                    using var json = JsonDocument.Parse(line);
                    var root = json.RootElement;
                    var x = root.GetProperty("x").GetInt32();
                    var y = root.GetProperty("y").GetInt32();
                    var width = root.GetProperty("width").GetInt32();
                    var height = root.GetProperty("height").GetInt32();
                    var visible = root.GetProperty("visible").GetBoolean();
                    dispatcher.BeginInvoke(() => {
                        // HWND_TOP is required: Chromium owns sibling HWNDs which
                        // otherwise cover this native surface with its black DOM slot.
                        SetWindowPos(host.Handle, IntPtr.Zero, x, y, width, height, 0x0010);
                        ShowWindow(host.Handle, visible && width > 0 && height > 0 ? 8 : 0);
                    });
                }
            } catch { /* Broken control pipe means the owner has gone away. */ }
            try { dispatcher.BeginInvoke(context.ExitThread); } catch { }
        });
        Application.Run(context);
        timer.Dispose();
    }

    sealed class HostWindow : NativeWindow, IDisposable
    {
        public HostWindow(IntPtr parent) => CreateHandle(new CreateParams {
            Caption = "Kaleid Video Surface", Parent = parent,
            Style = unchecked((int)(0x40000000 | 0x02000000 | 0x04000000)),
            X = 0, Y = 0, Width = 1, Height = 1
        });
        public void Dispose() => DestroyHandle();
    }
}
