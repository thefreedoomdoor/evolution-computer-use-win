param(
    [string]$Title = 'Evolution CU Holo Diagnostic',
    [string]$EventFile,
    [string]$ReadyFile,
    [int]$LifeSeconds = 60
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$code = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Text;
using System.Windows.Forms;

public class HoloDiagnostic : Form
{
    private readonly string eventFile;
    private readonly string readyFile;
    private readonly int lifeSeconds;
    private readonly Timer timer;
    private readonly DateTime started = DateTime.Now;
    private readonly Dictionary<string, Rectangle> zones = new Dictionary<string, Rectangle>();
    private readonly object gate = new object();
    private Point pressPoint;
    private string pressZone = "";
    private int ticks;
    private int events;
    private long lastMoveLog;
    private TextBox streamBox;
    private TextBox plainBox;
    private Font fontSmall;
    private Font fontLabel;
    private Font fontTitle;
    private Font fontMono;

    public HoloDiagnostic(string title, string eventFile, string readyFile, int lifeSeconds)
    {
        this.eventFile = eventFile;
        this.readyFile = readyFile;
        this.lifeSeconds = lifeSeconds;
        Text = title;
        ClientSize = new Size(900, 640);
        FormBorderStyle = FormBorderStyle.None;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(5, 9, 16);
        DoubleBuffered = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.StandardDoubleClick, true);
        KeyPreview = true;

        zones["LMB"] = new Rectangle(40, 112, 250, 100);
        zones["DBL"] = new Rectangle(290, 112, 250, 100);
        zones["RMB"] = new Rectangle(540, 112, 250, 100);
        zones["DRAG"] = new Rectangle(40, 232, 250, 100);
        zones["SCROLL"] = new Rectangle(290, 232, 250, 100);
        zones["MOVE"] = new Rectangle(540, 232, 250, 100);

        fontSmall = new Font("Consolas", 8.5f, FontStyle.Regular);
        fontLabel = new Font("Consolas", 11f, FontStyle.Bold);
        fontTitle = new Font("Consolas", 24f, FontStyle.Bold);
        fontMono = new Font("Consolas", 13f, FontStyle.Bold);

        streamBox = MakeBox(40, 410, 400, "stream");
        plainBox = MakeBox(480, 410, 380, "plain");
        Controls.Add(streamBox);
        Controls.Add(plainBox);

        timer = new Timer();
        timer.Interval = 40;
        timer.Tick += OnTick;
        timer.Start();
    }

    private TextBox MakeBox(int x, int y, int width, string source)
    {
        TextBox box = new TextBox();
        box.Location = new Point(x, y);
        box.Width = width;
        box.Font = fontMono;
        box.BackColor = Color.FromArgb(2, 18, 26);
        box.ForeColor = Color.FromArgb(90, 255, 226);
        box.BorderStyle = BorderStyle.FixedSingle;
        box.TextChanged += delegate(object sender, EventArgs args)
        {
            string text = box.Text;
            Log("{\"type\":\"text\",\"source\":\"" + source + "\",\"text\":\"" + Escape(text) + "\",\"length\":" + text.Length.ToString(CultureInfo.InvariantCulture) + "}");
        };
        return box;
    }

    private long Elapsed()
    {
        return (long)(DateTime.Now - started).TotalMilliseconds;
    }

    private static string Escape(string text)
    {
        if (text == null) return "";
        StringBuilder sb = new StringBuilder();
        foreach (char c in text)
        {
            if (c == '\\') sb.Append("\\\\");
            else if (c == '"') sb.Append("\\\"");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 32) sb.Append(' ');
            else sb.Append(c);
        }
        return sb.ToString();
    }

    private void Log(string body)
    {
        try
        {
            lock (gate)
            {
                events++;
                File.AppendAllText(eventFile, "{\"t\":" + Elapsed().ToString(CultureInfo.InvariantCulture) + "," + body.Substring(1) + "\n", new UTF8Encoding(false));
            }
        }
        catch { }
    }

    private string Zone(Point p)
    {
        foreach (KeyValuePair<string, Rectangle> pair in zones)
            if (pair.Value.Contains(p)) return pair.Key;
        return "";
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        try
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"pid\":").Append(Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"hwnd\":").Append(Handle.ToInt64().ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"width\":").Append(ClientSize.Width.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"height\":").Append(ClientSize.Height.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"zones\":{");
            bool first = true;
            foreach (KeyValuePair<string, Rectangle> pair in zones)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append("\"").Append(pair.Key).Append("\":{\"x\":").Append(pair.Value.X).Append(",\"y\":").Append(pair.Value.Y)
                  .Append(",\"w\":").Append(pair.Value.Width).Append(",\"h\":").Append(pair.Value.Height).Append('}');
            }
            sb.Append("},\"boxes\":{\"stream\":{\"x\":" + streamBox.Left + ",\"y\":" + streamBox.Top + ",\"w\":" + streamBox.Width + ",\"h\":" + streamBox.Height + "},\"plain\":{\"x\":" + plainBox.Left + ",\"y\":" + plainBox.Top + ",\"w\":" + plainBox.Width + ",\"h\":" + plainBox.Height + "}}}");
            File.WriteAllText(readyFile, sb.ToString(), new UTF8Encoding(false));
            Log("{\"type\":\"ready\"}");
        }
        catch { }
        streamBox.Focus();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        string zone = Zone(e.Location);
        if (e.Button == MouseButtons.Right)
        {
            if (zone == "RMB") Log("{\"type\":\"right\",\"zone\":\"RMB\",\"x\":" + e.X + ",\"y\":" + e.Y + "}");
            return;
        }
        if (e.Button == MouseButtons.Left)
        {
            pressPoint = e.Location;
            pressZone = zone;
        }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (e.Button != MouseButtons.Left) return;
        string zone = Zone(e.Location);
        double dx = e.X - pressPoint.X;
        double dy = e.Y - pressPoint.Y;
        double distance = Math.Sqrt(dx * dx + dy * dy);
        if (pressZone == "DRAG" && zone == "DRAG" && distance >= 40)
        {
            Log("{\"type\":\"drag\",\"zone\":\"DRAG\",\"x1\":" + pressPoint.X + ",\"y1\":" + pressPoint.Y + ",\"x2\":" + e.X + ",\"y2\":" + e.Y + ",\"distance\":" + ((int)distance).ToString(CultureInfo.InvariantCulture) + "}");
        }
        else if (pressZone == "LMB" && zone == "LMB" && distance < 12)
        {
            Log("{\"type\":\"click\",\"zone\":\"LMB\",\"button\":\"left\",\"x\":" + e.X + ",\"y\":" + e.Y + "}");
        }
    }

    protected override void OnMouseDoubleClick(MouseEventArgs e)
    {
        base.OnMouseDoubleClick(e);
        if (e.Button == MouseButtons.Left && Zone(e.Location) == "DBL")
            Log("{\"type\":\"double\",\"zone\":\"DBL\",\"x\":" + e.X + ",\"y\":" + e.Y + "}");
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (e.Button != MouseButtons.None) return;
        if (Zone(e.Location) != "MOVE") return;
        long now = Elapsed();
        if (now - lastMoveLog < 70) return;
        lastMoveLog = now;
        Log("{\"type\":\"move\",\"zone\":\"MOVE\",\"x\":" + e.X + ",\"y\":" + e.Y + "}");
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        if (Zone(e.Location) == "SCROLL")
            Log("{\"type\":\"scroll\",\"zone\":\"SCROLL\",\"delta\":" + e.Delta.ToString(CultureInfo.InvariantCulture) + ",\"x\":" + e.X + ",\"y\":" + e.Y + "}");
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        Log("{\"type\":\"key\",\"key\":\"" + e.KeyCode.ToString() + "\",\"control\":" + (e.Control ? "true" : "false") + ",\"shift\":" + (e.Shift ? "true" : "false") + ",\"alt\":" + (e.Alt ? "true" : "false") + "}");
        if (e.Control && e.KeyCode == Keys.S) e.SuppressKeyPress = true;
    }

    private void OnTick(object sender, EventArgs e)
    {
        ticks++;
        Invalidate();
        if ((DateTime.Now - started).TotalSeconds >= lifeSeconds)
        {
            timer.Stop();
            Close();
        }
    }

    private void Glow(Graphics g, string text, Font font, Point at, Color color)
    {
        using (SolidBrush faint = new SolidBrush(Color.FromArgb(35, color)))
        {
            g.DrawString(text, font, faint, at.X - 1, at.Y);
            g.DrawString(text, font, faint, at.X + 1, at.Y);
            g.DrawString(text, font, faint, at.X, at.Y - 1);
            g.DrawString(text, font, faint, at.X, at.Y + 1);
        }
        using (SolidBrush bright = new SolidBrush(color)) g.DrawString(text, font, bright, at);
    }

    private void Corner(Graphics g, Pen pen, Rectangle r, int size)
    {
        g.DrawLine(pen, r.Left, r.Top, r.Left + size, r.Top);
        g.DrawLine(pen, r.Left, r.Top, r.Left, r.Top + size);
        g.DrawLine(pen, r.Right, r.Top, r.Right - size, r.Top);
        g.DrawLine(pen, r.Right, r.Top, r.Right, r.Top + size);
        g.DrawLine(pen, r.Left, r.Bottom, r.Left + size, r.Bottom);
        g.DrawLine(pen, r.Left, r.Bottom, r.Left, r.Bottom - size);
        g.DrawLine(pen, r.Right, r.Bottom, r.Right - size, r.Bottom);
        g.DrawLine(pen, r.Right, r.Bottom, r.Right, r.Bottom - size);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        Rectangle full = ClientRectangle;

        using (LinearGradientBrush bg = new LinearGradientBrush(full, Color.FromArgb(4, 10, 18), Color.FromArgb(10, 24, 34), 90f))
            g.FillRectangle(bg, full);

        int pulse = (int)(55 + 40 * Math.Sin(ticks * 0.12));
        using (Pen grid = new Pen(Color.FromArgb(18, 40, 70), 1f))
        {
            for (int x = 0; x < ClientSize.Width; x += 24) g.DrawLine(grid, x, 82, x, 500);
            for (int y = 82; y < 500; y += 24) g.DrawLine(grid, 0, y, ClientSize.Width, y);
        }
        int scanY = 84 + (ticks * 5) % 416;
        using (LinearGradientBrush scan = new LinearGradientBrush(new Rectangle(0, scanY - 18, ClientSize.Width, 36), Color.FromArgb(0, 90, 255, 220), Color.FromArgb(70, 30, 220, 255), 90f))
            g.FillRectangle(scan, 0, scanY - 2, ClientSize.Width, 3);

        using (Pen frame = new Pen(Color.FromArgb(0, 240, 255), 1.4f))
        {
            g.DrawRectangle(frame, 18, 80, ClientSize.Width - 36, ClientSize.Height - 112);
            Corner(g, frame, new Rectangle(10, 72, ClientSize.Width - 20, ClientSize.Height - 96), 22);
        }

        Glow(g, "EVOLUTION // COMPUTER-USE DIAGNOSTIC", fontTitle, new Point(26, 18), Color.FromArgb(120, 255, 246));
        using (SolidBrush sub = new SolidBrush(Color.FromArgb(90, 210, 255)))
            g.DrawString("HOLO-INPUT ARRAY  ::  LIVE TELEMETRY  ::  BUILD 0.4.2", fontSmall, sub, 29, 56);
        using (SolidBrush status = new SolidBrush(Color.FromArgb(120, 255, 190)))
            g.DrawString("UPLINK STABLE  /  EVENTS " + events.ToString("D4", CultureInfo.InvariantCulture) + "  /  " + (lifeSeconds - (int)(DateTime.Now - started).TotalSeconds) + "s", fontSmall, status, 610, 56);

        foreach (KeyValuePair<string, Rectangle> pair in zones)
        {
            Rectangle r = pair.Value;
            bool hot = (pressZone == pair.Key);
            using (SolidBrush fill = new SolidBrush(Color.FromArgb(hot ? 30 : 12, 0, 255, 220)))
                g.FillRectangle(fill, r);
            Color stroke = hot ? Color.FromArgb(255, 255, 120) : Color.FromArgb(pulse + 110, 0, 235, 255);
            using (Pen pen = new Pen(stroke, hot ? 2.2f : 1.2f))
            {
                g.DrawRectangle(pen, r);
                Corner(g, pen, r, 16);
            }
            Glow(g, pair.Key + " // " + ZoneTitle(pair.Key), fontLabel, new Point(r.Left + 14, r.Top + 14), Color.FromArgb(110, 255, 235));
            using (SolidBrush hint = new SolidBrush(Color.FromArgb(100, 160, 220)))
                g.DrawString(ZoneHint(pair.Key), fontSmall, hint, r.Left + 15, r.Top + 42);
            using (SolidBrush coord = new SolidBrush(Color.FromArgb(70, 120, 180)))
                g.DrawString(r.Left + "," + r.Top + "  " + r.Width + "x" + r.Height, fontSmall, coord, r.Left + 15, r.Top + 74);
        }

        using (SolidBrush label = new SolidBrush(Color.FromArgb(110, 255, 235)))
        {
            g.DrawString("FLOW INPUT // STREAMING", fontSmall, label, 42, 386);
            g.DrawString("BURST INPUT // INSTANT", fontSmall, label, 482, 386);
        }
        using (Pen boxPen = new Pen(Color.FromArgb(pulse + 80, 0, 220, 255), 1.2f))
        {
            g.DrawRectangle(boxPen, 38, 408, 404, 28);
            g.DrawRectangle(boxPen, 478, 408, 384, 28);
        }

        using (SolidBrush foot = new SolidBrush(Color.FromArgb(90, 180, 220)))
        {
            g.DrawString("HOVER MATRIX ARMED", fontSmall, foot, 42, 468);
            g.DrawString("RIGHT-CLICK CONTEXT SUPPRESSED", fontSmall, foot, 42, 490);
            g.DrawString("SHORTCUT LISTENER: CTRL+S", fontSmall, foot, 42, 512);
            g.DrawString("TELEMETRY WRITE: " + Path.GetFileName(eventFile), fontSmall, foot, 42, 534);
        }
        using (Pen bottom = new Pen(Color.FromArgb(60, 0, 200, 255), 1f))
            g.DrawLine(bottom, 40, 566, ClientSize.Width - 40, 566);
        using (SolidBrush b2 = new SolidBrush(Color.FromArgb(80, 80, 255, 220)))
            g.DrawString("SYS://HOLO-DIAG  NODE 0x7F  //  ALL SYSTEMS NOMINAL", fontSmall, b2, 42, 590);
    }

    private string ZoneTitle(string key)
    {
        if (key == "LMB") return "PRIMARY";
        if (key == "DBL") return "TWIN-TAP";
        if (key == "RMB") return "CONTEXT";
        if (key == "DRAG") return "VECTOR";
        if (key == "SCROLL") return "WHEEL";
        return "HOVER";
    }

    private string ZoneHint(string key)
    {
        if (key == "LMB") return "LEFT CLICK PULSE";
        if (key == "DBL") return "DOUBLE CLICK SIGNAL";
        if (key == "RMB") return "RIGHT CLICK CONTEXT";
        if (key == "DRAG") return "PRESS + VECTOR SHIFT";
        if (key == "SCROLL") return "WHEEL DELTA";
        return "MOVE WITHOUT CLICK";
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            if (timer != null) timer.Dispose();
            if (fontSmall != null) fontSmall.Dispose();
            if (fontLabel != null) fontLabel.Dispose();
            if (fontTitle != null) fontTitle.Dispose();
            if (fontMono != null) fontMono.Dispose();
        }
        base.Dispose(disposing);
    }
}
'@

Add-Type -TypeDefinition $code -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing'

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object HoloDiagnostic($Title, $EventFile, $ReadyFile, $LifeSeconds)
[System.Windows.Forms.Application]::Run($form)
