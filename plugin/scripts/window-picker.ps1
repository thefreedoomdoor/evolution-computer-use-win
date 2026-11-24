<#
  枚举可捕捉的桌面窗口，供设置页的「按应用」策略选程序用。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\window-picker.ps1 [-Thumbs] [-Limit 60]

  输出（UTF-8 JSON）：
    {"windows":[{"hwnd":123456,"pid":4321,"exe":"Weixin.exe","title":"微信",
                 "minimized":false,"width":1280,"height":800,
                 "thumbnail":"data:image/png;base64,..."}]}

  说明：thumbnail 只在 -Thumbs 时生成（PrintWindow 截图缩到约 160x100）；
  截图失败或窗口最小化也照常给条目，只是 thumbnail 为空字符串。
#>
param(
  [switch]$Thumbs,
  [int]$Limit = 60
)

$ErrorActionPreference = 'Stop'
# 让中文标题按 UTF-8 输出（Node 侧用 utf8 解码）。
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public sealed class EvocuWindowInfo
{
    public long Hwnd;
    public uint Pid;
    public string Exe = "";
    public string Title = "";
    public bool Minimized;
    public int Width;
    public int Height;
    public string Thumb = "";
}

public static class EvocuWindowPicker
{
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private const int DWMWA_CLOAKED = 14;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int maxCount);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder exeName, ref int size);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int DwmGetRect(IntPtr hwnd, int attr, out RECT rect, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int DwmGetInt(IntPtr hwnd, int attr, out int value, int size);

    private static readonly string[] ClassBlocklist = new string[]
    {
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow"
    };

    public static string Enumerate(bool thumbs, int limit)
    {
        if (limit <= 0) limit = 60;
        List<IntPtr> handles = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr lparam)
        {
            handles.Add(hwnd);
            return true;
        }, IntPtr.Zero);

        int selfPid = Process.GetCurrentProcess().Id;
        List<EvocuWindowInfo> windows = new List<EvocuWindowInfo>();

        foreach (IntPtr hwnd in handles)
        {
            if (windows.Count >= limit) break;
            try
            {
                if (!IsWindowVisible(hwnd)) continue;

                int titleLength = GetWindowTextLength(hwnd);
                if (titleLength <= 0) continue;

                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (pid == 0 || (int)pid == selfPid) continue;

                int exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
                if ((exStyle & WS_EX_TOOLWINDOW) != 0) continue;

                StringBuilder cls = new StringBuilder(256);
                GetClassName(hwnd, cls, cls.Capacity);
                string className = cls.ToString();
                bool blocked = false;
                for (int i = 0; i < ClassBlocklist.Length; i++)
                {
                    if (className == ClassBlocklist[i]) { blocked = true; break; }
                }
                if (blocked) continue;

                int cloaked;
                if (DwmGetInt(hwnd, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) continue;

                RECT rect;
                if (DwmGetRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT))) != 0)
                {
                    if (!GetWindowRect(hwnd, out rect)) continue;
                }
                int width = rect.Right - rect.Left;
                int height = rect.Bottom - rect.Top;
                if (width < 80 || height < 60) continue;
                if (width > 8000 || height > 5000) continue;

                StringBuilder titleBuilder = new StringBuilder(titleLength + 2);
                GetWindowText(hwnd, titleBuilder, titleBuilder.Capacity);
                string title = titleBuilder.ToString().Trim();
                if (title.Length == 0) continue;

                string exe = ExeName(pid);
                string lowerExe = exe.ToLowerInvariant();
                string lowerTitle = title.ToLowerInvariant();
                if (lowerExe.Contains("deepseek") || lowerExe.Contains("dsh") || lowerExe.Contains("evolution-computer-use")) continue;
                if (lowerTitle.Contains("deepseek harness") || lowerTitle.StartsWith("dsh")) continue;

                EvocuWindowInfo info = new EvocuWindowInfo();
                info.Hwnd = hwnd.ToInt64();
                info.Pid = pid;
                info.Exe = exe;
                info.Title = title;
                info.Minimized = IsIconic(hwnd);
                info.Width = width;
                info.Height = height;
                info.Thumb = thumbs ? CaptureThumb(hwnd, width, height) : "";
                windows.Add(info);
            }
            catch
            {
                // 单个窗口枚举失败就跳过，不影响整次捕捉。
            }
        }

        windows.Sort(delegate(EvocuWindowInfo a, EvocuWindowInfo b)
        {
            int byExe = string.Compare(a.Exe, b.Exe, StringComparison.OrdinalIgnoreCase);
            if (byExe != 0) return byExe;
            return string.Compare(a.Title, b.Title, StringComparison.OrdinalIgnoreCase);
        });

        StringBuilder json = new StringBuilder();
        json.Append("{\"windows\":[");
        for (int i = 0; i < windows.Count; i++)
        {
            EvocuWindowInfo w = windows[i];
            if (i > 0) json.Append(',');
            json.Append("{\"hwnd\":").Append(w.Hwnd.ToString());
            json.Append(",\"pid\":").Append(w.Pid.ToString());
            json.Append(",\"exe\":").Append(JsonString(w.Exe));
            json.Append(",\"title\":").Append(JsonString(w.Title));
            json.Append(",\"minimized\":").Append(w.Minimized ? "true" : "false");
            json.Append(",\"width\":").Append(w.Width.ToString());
            json.Append(",\"height\":").Append(w.Height.ToString());
            json.Append(",\"thumbnail\":").Append(JsonString(w.Thumb));
            json.Append('}');
        }
        json.Append("]}");
        return json.ToString();
    }

    private static string ExeName(uint pid)
    {
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle != IntPtr.Zero)
        {
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                int size = sb.Capacity;
                if (QueryFullProcessImageNameW(handle, 0, sb, ref size))
                {
                    return Path.GetFileName(sb.ToString());
                }
            }
            finally
            {
                CloseHandle(handle);
            }
        }
        try
        {
            return Process.GetProcessById((int)pid).ProcessName + ".exe";
        }
        catch
        {
            return "";
        }
    }

    private static string CaptureThumb(IntPtr hwnd, int width, int height)
    {
        try
        {
            if (width <= 0 || height <= 0) return "";
            int capWidth = Math.Min(width, 1920);
            int capHeight = Math.Min(height, 1080);
            using (Bitmap full = new Bitmap(capWidth, capHeight))
            {
                using (Graphics g = Graphics.FromImage(full))
                {
                    IntPtr hdc = g.GetHdc();
                    try
                    {
                        if (!PrintWindow(hwnd, hdc, 2)) PrintWindow(hwnd, hdc, 0);
                    }
                    finally
                    {
                        g.ReleaseHdc(hdc);
                    }
                }
                int targetWidth = 160;
                int targetHeight = (int)Math.Round(100.0 * capHeight / capWidth);
                if (targetHeight > 100)
                {
                    targetHeight = 100;
                    targetWidth = (int)Math.Round(100.0 * capWidth / capHeight);
                }
                if (targetWidth < 1) targetWidth = 1;
                if (targetHeight < 1) targetHeight = 1;
                using (Bitmap small = new Bitmap(targetWidth, targetHeight))
                {
                    using (Graphics g2 = Graphics.FromImage(small))
                    {
                        g2.InterpolationMode = InterpolationMode.HighQualityBilinear;
                        g2.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        g2.DrawImage(full, 0, 0, targetWidth, targetHeight);
                    }
                    using (MemoryStream ms = new MemoryStream())
                    {
                        small.Save(ms, ImageFormat.Png);
                        return "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
                    }
                }
            }
        }
        catch
        {
            return "";
        }
    }

    private static string JsonString(string value)
    {
        if (string.IsNullOrEmpty(value)) return "\"\"";
        StringBuilder sb = new StringBuilder(value.Length + 2);
        sb.Append('"');
        foreach (char c in value)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing
[EvocuWindowPicker]::Enumerate([bool]$Thumbs.IsPresent, $Limit)
