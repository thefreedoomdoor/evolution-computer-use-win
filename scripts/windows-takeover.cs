// Original Windows UI for DSH. Uses only framework APIs; no input is synthesized.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.IO.MemoryMappedFiles;
using System.Security.Principal;
#if WCU_CORE
using System.Text.Json;
#else
using System.Web.Script.Serialization;
#endif
using System.Windows.Forms;

namespace DshTakeover {
  // PowerShell 7 uses modern .NET, where System.Web's serializer is unavailable.
  // Keep the command dictionary's primitive/array shapes identical on both runtimes.
  internal sealed class CommandJson {
#if WCU_CORE
    public string Serialize(object value) { return JsonSerializer.Serialize(value); }
    public T Deserialize<T>(string text) {
      using (var document = JsonDocument.Parse(text)) return (T)ConvertValue(document.RootElement);
    }
    static object ConvertValue(JsonElement value) {
      switch (value.ValueKind) {
        case JsonValueKind.Object:
          var map = new Dictionary<string,object>();
          foreach (var entry in value.EnumerateObject()) map.Add(entry.Name, ConvertValue(entry.Value));
          return map;
        case JsonValueKind.Array:
          var items = new List<object>();
          foreach (var entry in value.EnumerateArray()) items.Add(ConvertValue(entry));
          return items.ToArray();
        case JsonValueKind.String: return value.GetString();
        case JsonValueKind.Number:
          long integer;
          if (value.TryGetInt64(out integer)) return integer;
          return value.GetDouble();
        case JsonValueKind.True: return true;
        case JsonValueKind.False: return false;
        default: return null;
      }
    }
#else
    readonly JavaScriptSerializer inner = new JavaScriptSerializer();
    public string Serialize(object value) { return inner.Serialize(value); }
    public T Deserialize<T>(string text) { return inner.Deserialize<T>(text); }
#endif
  }
  // The words drawn here arrive with each command, in the DSH interface
  // language (mcp/overlay-strings.mjs, #74). A missing key shows as itself.
  internal static class Words {
    static Dictionary<string,object> current = new Dictionary<string,object>();
    internal static void Use(object strings) { var table = strings as Dictionary<string,object>; if (table != null) current = table; }
    internal static string Get(string key) { object value; return current.TryGetValue(key, out value) && value is string ? (string)value : key; }
    internal static string Format(string key, params object[] values) {
      try { return String.Format(System.Globalization.CultureInfo.InvariantCulture, Get(key), values); }
      catch (FormatException) { return Get(key); }
    }
  }
  public static class Host {
    public static void Run(string eventName, bool testMode) {
      try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); Native.SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
      Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
      Application.EnableVisualStyles();
      using (var context = new Controller(eventName, testMode)) Application.Run(context);
    }
  }

  internal static class Native {
    internal delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] internal struct Key { public uint vk, scan, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] internal struct Point { public int x, y; public Point(int a,int b) {x=a;y=b;} }
    [StructLayout(LayoutKind.Sequential)] internal struct Size { public int cx, cy; public Size(int a,int b) {cx=a;cy=b;} }
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int left,top,right,bottom; internal Rectangle Bounds { get { return Rectangle.FromLTRB(left,top,right,bottom); } } }
    [StructLayout(LayoutKind.Sequential)] internal struct MonitorInfo { public uint size; public Rect bounds,work; public uint flags; }
    internal delegate bool MonitorCallback(IntPtr monitor,IntPtr dc,IntPtr rectangle,IntPtr data);
    [StructLayout(LayoutKind.Sequential, Pack=1)] internal struct Blend { public byte op, flags, alpha, format; }
    [StructLayout(LayoutKind.Sequential)] internal struct IconInfo { public bool icon; public int hotX, hotY; public IntPtr mask, color; }
    [DllImport("user32.dll", SetLastError=true)] internal static extern bool GetIconInfo(IntPtr icon, out IconInfo info);
    [DllImport("user32.dll")] internal static extern IntPtr LoadCursor(IntPtr instance, IntPtr name);
    [DllImport("user32.dll")] internal static extern uint GetDpiForSystem();
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError=true)] internal static extern bool SystemParametersInfo(uint action, uint param, out int value, uint ini);
    [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError=true)] internal static extern IntPtr SetWindowsHookEx(int id, Hook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] internal static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] internal static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] internal static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("imm32.dll")] internal static extern IntPtr ImmGetDefaultIMEWnd(IntPtr window);
    [DllImport("user32.dll")] internal static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    // The input method of the window in front is open in native (non-Latin)
    // conversion mode: WM_IME_CONTROL to its thread's default IME window
    // (IMC_GETOPENSTATUS, IMC_GETCONVERSIONMODE). Null when it does not answer.
    internal static bool? ImeNative() {
      IntPtr front = GetForegroundWindow();
      if (front == IntPtr.Zero) return null;
      IntPtr ime = ImmGetDefaultIMEWnd(front);
      if (ime == IntPtr.Zero) return false;
      IntPtr open, mode;
      if (SendMessageTimeout(ime, 0x283, new IntPtr(5), IntPtr.Zero, 2, 100, out open) == IntPtr.Zero) return null;
      if (open == IntPtr.Zero) return false;
      if (SendMessageTimeout(ime, 0x283, new IntPtr(1), IntPtr.Zero, 2, 100, out mode) == IntPtr.Zero) return null;
      return (mode.ToInt64() & 1) != 0;
    }
    [DllImport("user32.dll",SetLastError=true)] internal static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] internal static extern IntPtr MonitorFromPoint(Point point, uint flags);
    [DllImport("user32.dll",SetLastError=true)] internal static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,MonitorCallback callback,IntPtr data);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] internal static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
    [DllImport("shcore.dll")] internal static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
    [DllImport("user32.dll")] internal static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] internal static extern int SetWindowLong(IntPtr window,int index,int value);
    [DllImport("user32.dll")] internal static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);
    internal static bool ApplyDisplayAffinity(Form window, bool visible){if(window==null||!window.IsHandleCreated)return true;bool ok=SetWindowDisplayAffinity(window.Handle,visible?0u:0x11u);if(!ok&&!visible&&window.Visible)window.Hide();return ok;}
    [DllImport("dwmapi.dll")] internal static extern int DwmFlush();
    [DllImport("user32.dll")] internal static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);
    [DllImport("user32.dll")] internal static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
    [StructLayout(LayoutKind.Sequential)] internal struct ScrollInfo {public uint size,mask;public int minimum,maximum;public uint page;public int position,track;}
    [StructLayout(LayoutKind.Sequential,Pack=4)] internal struct ParagraphFormat {
      public uint size,mask;public short numbering,reserved;public int startIndent,rightIndent,offset;public short alignment,tabCount;
      [MarshalAs(UnmanagedType.ByValArray,SizeConst=32)] public int[] tabs;
      public int spaceBefore,spaceAfter,lineSpacing;public short style;public byte lineRule,outline;
      public short shadingWeight,shadingStyle,numberingStart,numberingStyle,numberingTab,borderSpace,borderWidth,borders;
    }
    [DllImport("user32.dll")] internal static extern bool GetScrollInfo(IntPtr window,int bar,ref ScrollInfo info);
    [DllImport("user32.dll")] internal static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
    [DllImport("user32.dll",EntryPoint="SendMessageW")] internal static extern IntPtr SendPointMessage(IntPtr window,uint message,IntPtr wParam,ref Point point);
    [DllImport("user32.dll",EntryPoint="SendMessageW")] internal static extern IntPtr SendParagraphMessage(IntPtr window,uint message,IntPtr wParam,ref ParagraphFormat format);
    [DllImport("user32.dll")] internal static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
    [DllImport("user32.dll")] internal static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] internal static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] internal static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] internal static extern IntPtr SelectObject(IntPtr dc, IntPtr value);
    [DllImport("gdi32.dll")] internal static extern bool DeleteObject(IntPtr value);
    [DllImport("gdi32.dll")] internal static extern bool DeleteDC(IntPtr dc);
    [StructLayout(LayoutKind.Sequential)] internal struct BitmapInfoHeader { public uint size; public int width, height; public ushort planes, bitCount; public uint compression, sizeImage; public int xPelsPerMeter, yPelsPerMeter; public uint clrUsed, clrImportant; }
    [StructLayout(LayoutKind.Sequential)] internal struct BitmapInfo { public BitmapInfoHeader header; public uint colors; }
    [DllImport("gdi32.dll", SetLastError=true)] internal static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("user32.dll", SetLastError=true)] internal static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr screenDc, ref Point destination, ref Size size, IntPtr sourceDc, ref Point source, uint key, ref Blend blend, uint flags);
    // Top-down 32bpp premultiplied-ARGB DIB section. Selecting the returned
    // HBITMAP into a memory DC and wrapping `bits` with a Bitmap lets GDI+ paint
    // straight into the bytes later handed to UpdateLayeredWindow, so the live
    // overlay no longer allocates a full-screen Bitmap or calls GetHbitmap on
    // every frame (the measured per-frame bottleneck).
    internal static IntPtr CreateArgbDib(int width, int height, out IntPtr bits) {
      var info = new BitmapInfo();
      info.header.size = (uint)Marshal.SizeOf(typeof(BitmapInfoHeader));
      info.header.width = width;
      info.header.height = -height; // negative height => top-down scanlines
      info.header.planes = 1;
      info.header.bitCount = 32;
      info.header.compression = 0; // BI_RGB
      return CreateDIBSection(IntPtr.Zero, ref info, 0, out bits, IntPtr.Zero, 0);
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Msg { public IntPtr window; public uint message; public IntPtr wParam, lParam; public uint time; public Point point; public uint extra; }
    [DllImport("user32.dll")] internal static extern int GetMessage(out Msg message, IntPtr window, uint first, uint last);
    [DllImport("user32.dll")] internal static extern bool PeekMessage(out Msg message, IntPtr window, uint first, uint last, uint remove);
    [DllImport("user32.dll")] internal static extern bool PostThreadMessage(uint thread, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
    internal static Rectangle[] ActiveDisplays() {
      var result=new List<Rectangle>();
      if(!EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,delegate(IntPtr monitor,IntPtr dc,IntPtr rect,IntPtr data){
        var info=new MonitorInfo {size=(uint)Marshal.SizeOf(typeof(MonitorInfo))};
        if(GetMonitorInfo(monitor,ref info)&&info.bounds.right>info.bounds.left&&info.bounds.bottom>info.bounds.top)result.Add(info.bounds.Bounds);
        return true;
      },IntPtr.Zero))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Could not enumerate active displays");
      result.Sort(delegate(Rectangle a,Rectangle b){int x=a.Left.CompareTo(b.Left);return x!=0?x:a.Top.CompareTo(b.Top);});
      return result.ToArray();
    }
    internal static Rectangle DisplayFromPoint(Point point) {
      var info=new MonitorInfo {size=(uint)Marshal.SizeOf(typeof(MonitorInfo))};
      if(!GetMonitorInfo(MonitorFromPoint(point,2),ref info))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Could not locate pointer display");
      return info.bounds.Bounds;
    }
    internal static string DisplayIdentity(Rectangle bounds) {
      IntPtr monitor=MonitorFromPoint(new Point(bounds.Left+bounds.Width/2,bounds.Top+bounds.Height/2),2);
      uint x=96,y=96;try{if(GetDpiForMonitor(monitor,0,out x,out y)!=0)x=y=96;}catch(EntryPointNotFoundException){}
      return bounds.ToString()+"/"+monitor.ToInt64()+"/"+x+"/"+y;
    }
    internal static float ScaleForDisplay(Rectangle bounds) {
      IntPtr monitor = MonitorFromPoint(new Point(bounds.Left + bounds.Width / 2, bounds.Top + bounds.Height / 2), 2);
      uint x = 96, y = 96;
      try { if (GetDpiForMonitor(monitor, 0, out x, out y) == 0 && x > 0) return Math.Max(1f, Math.Min(3f, x / 96f)); }
      catch (EntryPointNotFoundException) { }
      return Math.Max(1f, Math.Min(2f, bounds.Width / 1920f));
    }
    internal static void KeepOnTop(IntPtr window) { SetWindowPos(window,new IntPtr(-1),0,0,0,0,0x213); }
  }

  // Where the user's own mouse last moved, for the overlay's lock button. A
  // low-level hook records local and remote-desktop mouse movement. Only
  // injected movement bearing DSH's input marker is skipped; remote tools
  // also set LLMHF_INJECTED. SetCursorPos never reaches the hook.
  // The hook stores one number, so system input never waits on the overlay.
  internal sealed class PointerWatch : IDisposable {
    readonly Native.Hook callback;
    readonly ManualResetEvent ready = new ManualResetEvent(false);
    IntPtr hook; volatile uint threadId; long packed; volatile bool seen, testFed, disposed;
    internal PointerWatch() {
      callback = OnMouse;
      new Thread(Run) { IsBackground = true, Name = "DSH overlay pointer" }.Start();
      ready.WaitOne(2000);
    }
    internal bool Active { get { return hook != IntPtr.Zero; } }
    void Run() {
      Native.Msg message; Native.PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
      threadId = Native.GetCurrentThreadId();
      if (disposed) { ready.Set(); return; }
      hook = Native.SetWindowsHookEx(14, callback, Native.GetModuleHandle(null), 0);
      ready.Set();
      if (hook == IntPtr.Zero) return;
      try { if (!disposed) while (Native.GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { } }
      finally { Native.UnhookWindowsHookEx(hook); hook = IntPtr.Zero; }
    }
    IntPtr OnMouse(int code, IntPtr message, IntPtr data) {
      if (code >= 0 && !testFed) Record(message.ToInt32(), data);
      return Native.CallNextHookEx(hook, code, message, data);
    }
    // MSLLHOOKSTRUCT: pt.x at 0, pt.y at 4, flags at 12 (1 = injected, 2 = injected from a lower integrity level).
    void Record(int kind, IntPtr data) {
      if (kind != 0x200) return;
      int flags=Marshal.ReadInt32(data,12);
      ulong extra=IntPtr.Size==8?unchecked((ulong)Marshal.ReadInt64(data,24)):unchecked((uint)Marshal.ReadInt32(data,20));
      if((flags&0x03)==1&&extra==(ulong)KeyboardWatch.InputMarker){seen=false;return;}
      Interlocked.Exchange(ref packed, ((long)Marshal.ReadInt32(data, 0) << 32) | (uint)Marshal.ReadInt32(data, 4));
      seen = true;
    }
    // Tests feed the same parser a hook record built in memory, so no real input is needed.
    internal void TestFeed(int x, int y, int flags, ulong extra) {
      testFed = true; IntPtr data = Marshal.AllocHGlobal(32);
      try { for (int offset = 0; offset < 32; offset += 4) Marshal.WriteInt32(data, offset, 0); Marshal.WriteInt32(data, 0, x); Marshal.WriteInt32(data, 4, y); Marshal.WriteInt32(data, 12, flags); if(IntPtr.Size==8)Marshal.WriteInt64(data,24,unchecked((long)extra));else Marshal.WriteInt32(data,20,unchecked((int)extra)); Record(0x200, data); }
      finally { Marshal.FreeHGlobal(data); }
    }
    internal bool Latest(out Native.Point point) {
      long value = Interlocked.Read(ref packed); point = new Native.Point((int)(value >> 32), (int)value);
      return seen;
    }
    public void Dispose() { disposed = true; if (threadId != 0) Native.PostThreadMessage(threadId, 0x12, IntPtr.Zero, IntPtr.Zero); }
  }


  // The keyboard callback owns a dedicated message pump. Drawing and pipe
  // writes never run on this thread. Session changes reinstall the hook via
  // Reinstall(); readiness is cleared if replacement fails.
  internal sealed class KeyboardWatch : IDisposable {
    internal static readonly uint InputMarker = ParseInputMarker();
    static uint ParseInputMarker() {
      string raw = Environment.GetEnvironmentVariable("WCU_INPUT_MARKER");
      if (!String.IsNullOrEmpty(raw)) {
        string s = raw.Trim();
        uint parsed;
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
          if (uint.TryParse(s.Substring(2), System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out parsed) && parsed != 0u) return parsed;
        } else if (uint.TryParse(s, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out parsed) && parsed != 0u) return parsed;
      }
      return 0x44534857u;
    }
    internal static bool OwnInput(uint flags, UIntPtr extra){return (flags&0x10u)!=0&&(flags&0x02u)==0&&extra.ToUInt64()==(ulong)InputMarker;}
    readonly Native.Hook callback;
    readonly EventWaitHandle available;
    readonly ManualResetEvent started = new ManualResetEvent(false);
    readonly Func<int,bool,bool,bool> handle;
    readonly Action testStop;
    IntPtr hook; uint threadId; volatile bool disposed;
    internal KeyboardWatch(string eventName, Func<int,bool,bool,bool> onKey, Action onTestStop=null) {
      handle=onKey;testStop=onTestStop;callback=OnKey;
      available=new EventWaitHandle(false,EventResetMode.ManualReset,eventName+"-ready");
      new Thread(Run){IsBackground=true,Name="DSH stop keyboard"}.Start();
      if(!started.WaitOne(3000)||!Active)throw new InvalidOperationException("Could not start the stop keyboard listener");
    }
    internal bool Active {get{return hook!=IntPtr.Zero&&!disposed;}}
    void ReplaceHook(){
      var next=Native.SetWindowsHookEx(13,callback,Native.GetModuleHandle(null),0);
      if(next==IntPtr.Zero){available.Reset();return;}
      var old=hook;hook=next;available.Set();
      if(old!=IntPtr.Zero)Native.UnhookWindowsHookEx(old);
    }
    void Run(){
      Native.Msg message;Native.PeekMessage(out message,IntPtr.Zero,0,0,0);threadId=Native.GetCurrentThreadId();
      try{
        ReplaceHook();started.Set();
        while(!disposed&&Native.GetMessage(out message,IntPtr.Zero,0,0)>0){if(message.message==0x8001)ReplaceHook();else if(message.message==0x8002){if(testStop!=null)testStop();}}
      }finally{available.Reset();if(hook!=IntPtr.Zero)Native.UnhookWindowsHookEx(hook);hook=IntPtr.Zero;}
    }
    IntPtr OnKey(int code,IntPtr message,IntPtr data){
      if(code>=0){int kind=message.ToInt32();if(kind==0x100||kind==0x104||kind==0x101||kind==0x105){
        var key=(Native.Key)Marshal.PtrToStructure(data,typeof(Native.Key));
        if(handle((int)key.vk,OwnInput(key.flags,key.extra),kind==0x100||kind==0x104))return new IntPtr(1);
      }}
      return Native.CallNextHookEx(hook,code,message,data);
    }
    internal void Reinstall(){if(threadId!=0&&!disposed)Native.PostThreadMessage(threadId,0x8001,IntPtr.Zero,IntPtr.Zero);}
    internal void TestStop(){Native.PostThreadMessage(threadId,0x8002,IntPtr.Zero,IntPtr.Zero);}
    public void Dispose(){disposed=true;available.Reset();if(threadId!=0)Native.PostThreadMessage(threadId,0x12,IntPtr.Zero,IntPtr.Zero);}
  }

  // A generation counter cannot be cleared by another helper starting a new
  // operation. Every live helper retains the mapping and polls on its own thread.
  // Local keyboard cancellation never waits for this cross-process publication.
  internal sealed class StopBus : IDisposable {
    readonly Mutex mutex;
    readonly MemoryMappedFile mapping;
    readonly MemoryMappedViewAccessor view;
    readonly ManualResetEvent closing = new ManualResetEvent(false);
    readonly object gate = new object();
    readonly Thread thread;
    readonly Action stopped;
    long seen;
    bool disposed;
    internal StopBus(string name, Action onStop) {
      stopped=onStop;
      mutex=new Mutex(false,name+"-lock");
      mapping=MemoryMappedFile.CreateOrOpen(name,8);
      view=mapping.CreateViewAccessor(0,8);
      if(!Read(false))throw new InvalidOperationException("Could not initialize shared stop listener");
      thread=new Thread(Run){IsBackground=true,Name="DSH shared stop"};thread.Start();
    }
    bool Acquire(int timeout) {
      try{return mutex.WaitOne(timeout);}catch(AbandonedMutexException){return true;}
    }
    bool Read(bool notify) {
      bool changed=false;
      lock(gate){
        if(disposed||!Acquire(250))return false;
        try{long next=view.ReadInt64(0);changed=next!=seen;seen=next;}
        finally{mutex.ReleaseMutex();}
      }
      if(changed&&notify)stopped();
      return true;
    }
    void Run(){
      while(!closing.WaitOne(40)){
        try{if(!Read(true))stopped();}catch{stopped();return;}
      }
    }
    internal void Publish(){
      ThreadPool.QueueUserWorkItem(_=>{
        try{
          lock(gate){
            if(disposed)return;
            if(!Acquire(250)){stopped();return;}
            try{seen=unchecked(view.ReadInt64(0)+1);view.Write(0,seen);}
            finally{mutex.ReleaseMutex();}
          }
        }catch{stopped();}
      });
    }
    public void Dispose(){
      closing.Set();thread.Join(2000);
      lock(gate){disposed=true;view.Dispose();mapping.Dispose();mutex.Dispose();}
      closing.Dispose();
    }
  }

  internal sealed class Controller : ApplicationContext {
    readonly Control dispatcher = new Control();
    readonly EventWaitHandle cancel;
    readonly KeyboardWatch keyboard;
    readonly StopBus stopBus;
    readonly object keyState=new object();
    // The user's last letter (pinyin and other input-method text) and last key
    // that commits or cancels it (space, Enter, a digit, punctuation, Esc,
    // Tab), as positions in the stream of their keys; when that letter came,
    // in milliseconds of composeClock.
    readonly System.Diagnostics.Stopwatch composeClock = System.Diagnostics.Stopwatch.StartNew();
    long keyCount, letterAt = -1, letterIndex = -1, commitIndex = -1;
    bool? testIme;
    readonly bool testMode;
    readonly CommandJson json = new CommandJson();
    readonly List<Frame> frames = new List<Frame>();
    PointerFrame pointer;
    ProgressFrame progress;
    AuditFrame audit;
    CompanionFrame companion;
    PointerWatch pointerWatch;
    Native.Point? testOverlayCursor;
    DateTime progressPreviewUntil=DateTime.MinValue;
    bool progressCloseWhenIdle;
    string lastTurnKey="",dismissedTurnKey;
    bool progressSettingEnabled=true;
    volatile bool progressAvailable;
    int progressKey,progressModifiers;
    Native.Point? testPointerPoint;
    Rectangle[] displays=new Rectangle[0],testDisplays;
    string displaySignature="";
    DateTime nextDisplayPoll=DateTime.MinValue;
    int displayRevision;
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    volatile bool armed, paused, shuttingDown;
    bool previewOnly;
    readonly HashSet<int> physicalDown = new HashSet<int>(), swallowed = new HashSet<int>();
    string stopShortcut = "";
    int stopKey, stopModifiers;
    // Pressing the stop gesture once only arms it; the second press within half
    // a second stops the turn, the same window the desktop sign uses. Two separate
    // presses are needed because a held key never leaves the swallowed set until
    // it is released.
    const long StopPressWindowMs = 500;
    int stopPressKey = -1; long stopPressAt = -1;
    DateTime hideAt = DateTime.MaxValue;
    bool indicator = true, cursorIndicator = true, remoteVisible = true;
    int captureDepth;
    int cursorError;
    string text = "", hint = "", position = "top";
    int idleMs = 800;

    internal Controller(string eventName, bool tests) {
      testMode = tests;
      cancel = new EventWaitHandle(false, EventResetMode.ManualReset, eventName);
      var handle = dispatcher.Handle;
      cancel.Reset();
      string group=tests?(Environment.GetEnvironmentVariable("WCU_TEST_STOP_GROUP")??eventName+"-test-stop"):
        "Local\\DSH-WCU-AllStop-v1-"+WindowsIdentity.GetCurrent().User.Value;
      stopBus=new StopBus(group,()=>{if(armed&&!paused&&!shuttingDown)Stop("shared-stop",false);});
      keyboard=new KeyboardWatch(eventName,HandleKey,TestStopForced);
      timer.Interval = 35;
      timer.Tick += delegate {
        // A window the user is moving or resizing goes once they are done.
        if(progress!=null&&progressPreviewUntil!=DateTime.MaxValue&&DateTime.UtcNow>progressPreviewUntil&&!progress.Adjusting){progressPreviewUntil=DateTime.MinValue;CloseProgress();}
        if(progressCloseWhenIdle&&progress!=null&&!progress.Adjusting)CloseProgress();
        TrackProgressPointer();
        AuditFollow();
        CompanionFollow();

        double elapsed = hideAt == DateTime.MaxValue ? -1 : (DateTime.UtcNow - hideAt).TotalMilliseconds;
        if (elapsed >= 160) { HideFrames(); HidePointer(); armed = false; hideAt = DateTime.MaxValue; SyncTimer(); return; }
        byte alpha = elapsed >= 0 ? (byte)Math.Max(0, 255 * (1 - elapsed / 160)) : (byte)255;
        if(armed&&!paused)RefreshDisplays(false);
        UpdatePointer(alpha);
        if (elapsed >= 0) foreach (var frame in frames) frame.Present(alpha);
        SyncTimer();
      };
      SyncTimer();
      SystemEventsSubscribe();
      new Thread(ReadCommands) { IsBackground = true, Name = "DSH takeover control" }.Start();
      RefreshDisplays(true);
      // The Windows process id: under WSL the server sees only the id of the
      // interop process that started this one (#79).
      Emit(new { kind = "ready", hookActive = keyboard.Active, monitors = displays.Length, pid = System.Diagnostics.Process.GetCurrentProcess().Id });
    }
    void SyncTimer() {
      bool active = !shuttingDown && (armed || hideAt != DateTime.MaxValue || frames.Count > 0 || pointer != null || progress != null || audit != null || companion != null);
      if (active && !timer.Enabled) timer.Start();
      else if (!active && timer.Enabled) timer.Stop();
    }

    void SystemEventsSubscribe() { Microsoft.Win32.SystemEvents.DisplaySettingsChanged += DisplaysChanged; Microsoft.Win32.SystemEvents.SessionSwitch += SessionChanged; Microsoft.Win32.SystemEvents.UserPreferenceChanged += PreferencesChanged; }
    // A pointer size or scheme change arrives as a preference change; measure the arrow again.
    void PreferencesChanged(object sender,Microsoft.Win32.UserPreferenceChangedEventArgs args) {
      if (shuttingDown) return;
      try { dispatcher.BeginInvoke((Action)PointerFrame.ForgetPointerSize); } catch (InvalidOperationException) { }
    }
    void SessionChanged(object sender,Microsoft.Win32.SessionSwitchEventArgs args) {
      lock(keyState){physicalDown.Clear();swallowed.Clear();}
      if(keyboard!=null)keyboard.Reinstall();
      DisplaysChanged(sender,EventArgs.Empty);
    }
    void DisplaysChanged(object sender, EventArgs args) {
      if (shuttingDown) return;
      try { dispatcher.BeginInvoke((Action)delegate { RefreshDisplays(true); UpdatePointer(255); SyncTimer(); }); } catch (InvalidOperationException) { }
    }
    bool RefreshDisplays(bool force) {
      if(!force&&DateTime.UtcNow<nextDisplayPoll)return false;
      nextDisplayPoll=DateTime.UtcNow.AddMilliseconds(500);
      Rectangle[] next=testMode&&testDisplays!=null?testDisplays:Native.ActiveDisplays();
      string signature=String.Join(";",Array.ConvertAll(next,delegate(Rectangle r){return Native.DisplayIdentity(r);}));
      if(signature==displaySignature){foreach(var frame in frames)Native.KeepOnTop(frame.Handle);if(pointer!=null)Native.KeepOnTop(pointer.Handle);return false;}
      displays=next;displaySignature=signature;displayRevision++;
      HideFrames();HidePointer();
      if(armed&&!paused&&indicator)ShowFrames();
      return true;
    }
    void ConfigureVisibility(bool visible) {
      remoteVisible=visible;
      ApplyCaptureVisibility();
    }
    void ApplyCaptureVisibility() {
      bool visible=remoteVisible&&captureDepth==0;
      foreach(var frame in frames)frame.SetRemoteVisible(visible);
      if(pointer!=null)pointer.SetRemoteVisible(visible);
      if(progress!=null)Native.ApplyDisplayAffinity(progress,visible);
    }
    void Emit(object value) { lock (json) { Console.Out.WriteLine(json.Serialize(value)); Console.Out.Flush(); } }
    void ReadCommands() {
      try {
        string line;
        while ((line = Console.ReadLine()) != null) {
          var command = new CommandJson().Deserialize<Dictionary<string,object>>(line);
          if(Get(command,"command","")=="cancel_input"){
            cancel.Set();object id;command.TryGetValue("id",out id);if(id!=null)Emit(new {id=id,ok=true});continue;
          }
          if(Get(command,"command","")=="input_state"){
            object id;command.TryGetValue("id",out id);Emit(new {id=id,ok=true,composing=Composing()});continue;
          }
          dispatcher.BeginInvoke((Action)(() => Dispatch(command)));
        }
      } catch (Exception error) { Console.Error.WriteLine(error.Message); }
      finally { try { cancel.Set(); } catch (ObjectDisposedException) { } try { dispatcher.BeginInvoke((Action)(() => ExitThread())); } catch (InvalidOperationException) { } }
    }
    static T Get<T>(Dictionary<string,object> command, string name, T fallback) {
      object value; return command.TryGetValue(name, out value) ? (T)Convert.ChangeType(value, typeof(T)) : fallback;
    }
    void Dispatch(Dictionary<string,object> command) {
      object id; command.TryGetValue("id", out id);
      try {
        bool consumed = false;
        string action = Get(command, "command", "");
        object strings; if (command.TryGetValue("strings", out strings)) Words.Use(strings);
        if(action=="capture_begin"){
          captureDepth++;ApplyCaptureVisibility();
          if (captureDepth == 1 && remoteVisible && (frames.Count > 0 || pointer != null || progress != null)) Native.DwmFlush();
        } else if(action=="capture_end"){
          captureDepth=Math.Max(0,captureDepth-1);ApplyCaptureVisibility();
        } else if (action == "begin" || action == "preview") {
          if (paused) throw new InvalidOperationException("COMPUTER_USE_STOPPED_BY_USER");
          string prevShortcut = stopShortcut;
          ConfigureShortcut(Get(command, "stopShortcut", stopShortcut));
          bool nextIndicator = Get(command, "indicatorEnabled", true);
          ConfigureVisibility(Get(command,"remoteIndicatorVisible",true));
          cursorIndicator = Get(command, "cursorIndicatorEnabled", true);
          string nextText = Get(command, "indicatorText", Words.Get("indicatorDefault")), nextPosition = Get(command, "indicatorPosition", "top"), nextHint = Words.Get("stopHint");
          bool rebuild = nextIndicator != indicator || nextText != text || nextHint != hint || nextPosition != position || prevShortcut != stopShortcut || frames.Count == 0;
          indicator = nextIndicator; text = nextText; hint = nextHint; position = nextPosition;
          idleMs = Math.Max(200, Math.Min(3000, Get(command, "indicatorIdleMs", 800)));
          bool alreadyArmed=armed;
          armed=true;previewOnly=action=="preview"&&!alreadyArmed;
          hideAt=previewOnly?DateTime.UtcNow.AddMilliseconds(1800):DateTime.MaxValue;
          bool displaysRebuilt=RefreshDisplays(true);
          if (!indicator) HideFrames();
          else if (rebuild&&!displaysRebuilt) { HideFrames(); ShowFrames(); }
          else foreach (var frame in frames) frame.Present(255);
          UpdatePointer(255);
        } else if (action == "progress") {
          bool enabled=Get(command,"enabled",false),preview=Get(command,"preview",false);
          object supplied;
          var data=command.TryGetValue("progress",out supplied)?supplied as Dictionary<string,object>:null;
          var settings=command.TryGetValue("settings",out supplied)?supplied as Dictionary<string,object>:null;
          bool settingEnabled=settings==null||Get(settings,"progressOverlayEnabled",true);
          if(progressSettingEnabled&&!settingEnabled){progressPreviewUntil=DateTime.MinValue;dismissedTurnKey=null;}
          progressSettingEnabled=settingEnabled;
          if(preview){dismissedTurnKey=null;progressPreviewUntil=DateTime.UtcNow.AddSeconds(60);}
          if(!enabled){lastTurnKey="";dismissedTurnKey=null;}
          else if(!preview){
            string explicitKey=Get(command,"turnKey","");
            long startedAt=ProgressFrame.Whole(data,"startedAt");
            string currentTurnKey=explicitKey!=""?explicitKey:(startedAt>0?startedAt.ToString():"active");
            lastTurnKey=currentTurnKey;
            if(dismissedTurnKey!=null&&currentTurnKey!=dismissedTurnKey)dismissedTurnKey=null;
            if(dismissedTurnKey!=null){Emit(new {id=id,ok=true,progressVisible=false});return;}
          }
          bool leavingPreview=enabled&&!preview&&progressPreviewUntil!=DateTime.MaxValue&&progressPreviewUntil!=DateTime.MinValue;
          if(enabled&&!preview)progressPreviewUntil=DateTime.MaxValue;
          if(!enabled&&(progressPreviewUntil==DateTime.MaxValue||DateTime.UtcNow>=progressPreviewUntil)){if(progress!=null&&progress.Adjusting)progressCloseWhenIdle=true;else CloseProgress();}
          else {
            progressCloseWhenIdle=false;
            bool fresh=progress==null;
            if(fresh){progress=new ProgressFrame(delegate(Dictionary<string,object> patch,Dictionary<string,object> baseline){Emit(new {kind="progress-layout",patch=patch,@base=baseline});},delegate {
              bool wasPreview=(progressPreviewUntil!=DateTime.MinValue&&progressPreviewUntil!=DateTime.MaxValue&&DateTime.UtcNow<progressPreviewUntil)||(progress!=null&&progress.IsPreview);
              progressPreviewUntil=DateTime.MinValue;
              if(!wasPreview&&lastTurnKey!="")dismissedTurnKey=lastTurnKey;
              CloseProgress();
            });progressAvailable=true;}
            progress.Configure(settings,Get(command,"remoteIndicatorVisible",true));
            lock(keyState){int savedKey=stopKey,savedModifiers=stopModifiers;string savedShortcut=stopShortcut;
            ConfigureShortcut(settings!=null?Get(settings,"progressLockShortcut",""):"");progressKey=stopKey;progressModifiers=stopModifiers;
            stopKey=savedKey;stopModifiers=savedModifiers;stopShortcut=savedShortcut;}
            if(enabled)progress.UpdateProgress(data);
            if(fresh||(enabled&&!progress.Visible))progress.Show();
            SyncAudit(settings);
            SyncCompanion(settings);
            // The adjustment preview unlocks only while it lasts; the saved lock
            // state is untouched unless the user toggles it themselves.
            if(preview)progress.BeginPreview();else if(leavingPreview)progress.EndPreview();
          }
        } else if(action=="test_progress_close"&&testMode){
          if(progress!=null)progress.RequestClose();
        } else if(action=="test_progress_layout"&&testMode){
          if(progress==null)throw new InvalidOperationException("No progress window");
          progress.Bounds=new Rectangle(Get(command,"x",100),Get(command,"y",100),Get(command,"width",500),Get(command,"height",350));progress.EmitLayout();
        } else if (action == "test_render_progress" && testMode) {
          if(progress==null)throw new InvalidOperationException("No progress window");
          Emit(new {id=id,ok=true,capture=progress.CaptureProgress(Get(command,"path",""),Get(command,"screen",false))});return;
        } else if(action=="test_progress_scroll"&&testMode){
          if(progress!=null){if(Get(command,"wheel",false))progress.ScrollWheel(Get(command,"delta",120));else progress.ScrollLines(Get(command,"lines",0));}
        } else if(action=="test_progress_dpi"&&testMode){
          if(progress!=null)progress.TestDpi((float)Get(command,"scale",1.0));
        } else if(action=="test_progress_scrollbar"&&testMode){
          if(progress!=null)progress.TestScrollbar(Get(command,"x",0),Get(command,"y",0),Get(command,"endY",0));
        } else if(action=="test_progress_hittest"&&testMode){
          if(progress==null)throw new InvalidOperationException("No progress window");
          Emit(new {id=id,ok=true,hit=progress.TestHitAt(Get(command,"x",20),Get(command,"y",20))});return;
        } else if(action=="test_progress_close_click"&&testMode){
          if(progress!=null)progress.TestCloseClick();
        } else if(action=="test_progress_lock_click"&&testMode){
          if(progress!=null)progress.TestLockClick();
        } else if(action=="test_progress_pointer"&&testMode){
          // Feed actual hook flags and extra-info through the real parser.
          // Existing injected test records default to the plugin's marker.
          testOverlayCursor=new Native.Point(Get(command,"x",0),Get(command,"y",0));
          int flags=Get(command,"hookFlags",-1);
          if(flags>=0){if(pointerWatch==null)pointerWatch=new PointerWatch();pointerWatch.TestFeed(Get(command,"x",0),Get(command,"y",0),flags,(ulong)Get<long>(command,"extra",(flags&1)!=0?(long)(ulong)KeyboardWatch.InputMarker:0L));}
          TrackProgressPointer();
        } else if(action=="test_progress_backdrop"&&testMode){
          if(progress!=null)progress.ShowTestBackdrop();
        } else if(action=="test_progress_resize_redraw"&&testMode){
          if(progress!=null)progress.TestResizeRedraw(Get(command,"enabled",true));
        } else if(action=="test_block_ui_stop"&&testMode){
          new Thread(()=>{Thread.Sleep(80);keyboard.TestStop();}){IsBackground=true}.Start();
          Thread.Sleep(Get(command,"milliseconds",500));
        } else if (action == "configure") {
          string prevShortcut = stopShortcut;
          ConfigureShortcut(Get(command, "stopShortcut", ""));
          ConfigureVisibility(Get(command,"remoteIndicatorVisible",remoteVisible));
          cursorIndicator = Get(command, "cursorIndicatorEnabled", cursorIndicator); UpdatePointer(255);
          if (prevShortcut != stopShortcut && armed && !paused && indicator && frames.Count > 0) { HideFrames(); ShowFrames(); }
        } else if (action == "hide") {
          HideFrames(); HidePointer();
          if (progress != null && progress.Visible) progress.Hide();
          if (audit != null && audit.Visible) audit.Hide();
          SyncTimer();
        } else if (action == "end") {
          hideAt = DateTime.UtcNow.AddMilliseconds(idleMs);
        } else if (action == "stop") {
          Stop("user");
        } else if (action == "resume") {
          paused = false; armed = false; cancel.Reset(); HideFrames(); HidePointer(); hideAt = DateTime.MaxValue;
        } else if (action == "close") {
          cancel.Set(); ExitThread();
        } else if (action == "test_key" && testMode) {
          bool injected=Get(command,"injected",false);
          uint flags=(uint)Get<long>(command,"flags",injected?0x10L:0L);
          ulong extra=(ulong)Get<long>(command,"extra",injected?(long)(ulong)KeyboardWatch.InputMarker:0L);
          consumed = HandleKey(Get(command, "vk", 0), KeyboardWatch.OwnInput(flags,new UIntPtr(extra)), Get(command, "down", true));
        } else if (action == "test_ime" && testMode) {
          object native; testIme = command.TryGetValue("native", out native) && native != null ? (bool?)Convert.ToBoolean(native) : null;
        } else if (action == "test_render" && testMode) {
          using (var image = Frame.Draw(1200, 675, Get(command, "indicatorText", text), Get(command, "indicatorPosition", "top"), Get(command, "stopShortcut", stopShortcut), 0f)) image.Save(Get(command, "path", ""), ImageFormat.Png);
        } else if (action == "test_render_pointer" && testMode) {
          float zoom=(float)Get(command,"scale",2.0);
          using (var image = PointerFrame.Draw(zoom, false, false)) {
            using (var graphics = Graphics.FromImage(image)) Cursors.Arrow.Draw(graphics, new Rectangle((int)(24*zoom),(int)(24*zoom),(int)(16*zoom),(int)(16*zoom)));
            image.Save(Get(command, "path", ""), ImageFormat.Png);
          }
        } else if (action == "test_pointer_source" && testMode) {
          testPointerPoint=new Native.Point(Get(command,"x",200),Get(command,"y",200)); UpdatePointer(255);
        } else if (action == "test_pointer_layout" && testMode) {
          var bounds = PointerFrame.LayoutForPoint(new Native.Point(Get(command,"x",0),Get(command,"y",0)), new Rectangle(Get(command,"left",0),Get(command,"top",0),Get(command,"width",1920),Get(command,"height",1080)), (float)Get(command,"scale",1.0));
          Emit(new { id=id,ok=true,left=bounds.X,top=bounds.Y,width=bounds.Width,height=bounds.Height }); return;
        } else if(action=="test_displays"&&testMode) {
          object supplied;if(!command.TryGetValue("displays",out supplied)||!(supplied is System.Collections.IEnumerable))throw new ArgumentException("Displays array required");
          var next=new List<Rectangle>();
          foreach(var item in (System.Collections.IEnumerable)supplied){var r=item as Dictionary<string,object>;if(r==null)throw new ArgumentException("Display object required");int width=Get(r,"width",0),height=Get(r,"height",0);if(width<64||height<64||width>8192||height>8192)throw new ArgumentException("Invalid test display size");next.Add(new Rectangle(Get(r,"left",0),Get(r,"top",0),width,height));}
          testDisplays=next.ToArray();nextDisplayPoll=DateTime.MinValue;
        } else if(action=="test_restore_displays"&&testMode) {
          testDisplays=null;nextDisplayPoll=DateTime.MinValue;
        } else if (action != "status") throw new InvalidOperationException("Unknown takeover command");
        ApplyCaptureVisibility();
        SyncTimer();
        if (testMode || action == "status") {
          Native.Point livePoint; bool liveCursorAvailable=Native.GetCursorPos(out livePoint);
          Emit(new { id = id, ok = true, armed = armed, paused = paused, cancelled = cancel.WaitOne(0), consumed = consumed, uiWindowCount=Application.OpenForms.Count, stopShortcut = stopShortcut, windows = frames.Count, progressVisible=progress!=null, progressWindow=progress!=null?progress.Handle.ToInt64():0, progressClickThrough=progress!=null&&progress.ClickThrough, progressContent=progress!=null?progress.Content:null, progressLocked=progress!=null&&progress.Locked, progressHover=progress!=null?progress.HoverStatus():null, pointerWatchActive=pointerWatch!=null&&pointerWatch.Active, progressReading=progress!=null?progress.ReadingStatus():null, progressOpacity=progress!=null?progress.WindowOpacity:0, progressBounds=progress!=null?new {x=progress.Left,y=progress.Top,width=progress.Width,height=progress.Height}:null, auditVisible=audit!=null&&audit.Visible, auditBounds=audit!=null?new {x=audit.Left,y=audit.Top,width=audit.Width,height=audit.Height}:null, auditOpacity=audit!=null?Math.Round(audit.WindowOpacity,3):0, auditLocked=audit!=null&&audit.Locked, auditCaptureExcluded=audit!=null&&audit.CaptureExcluded, auditRows=audit!=null?audit.MaxRows:0, auditFont=audit!=null?audit.FontDescription:"", auditLines=audit!=null?audit.LineCount:0, auditData=audit!=null?audit.DataPath:"", remoteIndicatorVisible=remoteVisible, overlayCaptureExcluded=frames.Count>0&&frames.TrueForAll(frame=>frame.CaptureExcluded), overlayClickThrough=frames.Count>0&&frames.TrueForAll(frame=>frame.ClickThrough), displayRevision=displayRevision, displays=Array.ConvertAll(displays,r=>new {left=r.Left,top=r.Top,width=r.Width,height=r.Height}), overlayBounds=frames.ConvertAll(frame=>new {left=frame.DisplayBounds.Left,top=frame.DisplayBounds.Top,width=frame.DisplayBounds.Width,height=frame.DisplayBounds.Height}), cursorError = cursorError, liveCursorAvailable = liveCursorAvailable, pointerSource = testPointerPoint.HasValue ? "test-seam" : "windows", pointerVisible = pointer != null, pointerClickThrough = pointer != null && pointer.ClickThrough, pointerCaptureExcluded = pointer != null && pointer.CaptureExcluded, foreground = Native.GetForegroundWindow().ToInt64() });
        } else {
          Emit(new { id = id, ok = true, armed = armed, paused = paused, cancelled = cancel.WaitOne(0) });
        }
      } catch (Exception error) { Emit(new { id = id, ok = false, error = error.Message }); }
    }
    // Under keyState. Shortcuts (Ctrl, Alt, Win) and Shift+letter (Latin
    // capitals) neither start nor end input-method text.
    void TrackComposition(int vk) {
      int held = 0; foreach (int key in physicalDown) if (key != vk) held |= Modifier(key);
      if ((held & 11) != 0) return;
      keyCount++;
      bool letter = (vk >= 0x41 && vk <= 0x5A) || vk == 0xDE || vk == 0xBA;
      if (letter) { if ((held & 4) == 0) { letterIndex = keyCount; letterAt = composeClock.ElapsedMilliseconds; } return; }
      bool commit = vk == 0x20 || vk == 0x0D || vk == 0x1B || vk == 0x09 || (vk >= 0x30 && vk <= 0x39) || (vk >= 0x60 && vk <= 0x69) || (vk >= 0xBB && vk <= 0xC0) || (vk >= 0xDB && vk <= 0xDD);
      if (commit) commitIndex = keyCount;
    }
    // The user is in the middle of input-method text: a letter came last,
    // within 4 s, and the window in front has its input method in native mode
    // (or does not say). Low disruption waits for it before borrowing input.
    bool Composing() {
      long letter, commit, at, now = composeClock.ElapsedMilliseconds;
      lock (keyState) { letter = letterIndex; commit = commitIndex; at = letterAt; }
      if (letter < 0 || letter < commit || now - at > 4000) return false;
      bool? native = testMode && testIme.HasValue ? testIme : Native.ImeNative();
      return native != false;
    }
    static int Modifier(int vk) {
      if (vk == 0x11 || vk == 0xA2 || vk == 0xA3) return 1;
      if (vk == 0x12 || vk == 0xA4 || vk == 0xA5) return 2;
      if (vk == 0x10 || vk == 0xA0 || vk == 0xA1) return 4;
      if (vk == 0x5B || vk == 0x5C) return 8;
      return 0;
    }
    void ConfigureShortcut(string shortcut) {
      int nextKey = 0, nextModifiers = 0;
      if (shortcut.Length > 0) {
        string[] parts = shortcut.Split('+');
        for (int i = 0; i < parts.Length - 1; i++) {
          int flag = parts[i] == "Ctrl" ? 1 : parts[i] == "Alt" ? 2 : parts[i] == "Shift" ? 4 : parts[i] == "Win" ? 8 : 0;
          if (flag == 0 || (nextModifiers & flag) != 0) throw new ArgumentException("Invalid stop shortcut modifiers");
          nextModifiers |= flag;
        }
        string key = parts[parts.Length - 1]; int number;
        if (key.Length == 1 && ((key[0] >= 'A' && key[0] <= 'Z') || (key[0] >= '0' && key[0] <= '9'))) nextKey = key[0];
        else if (key.StartsWith("F") && int.TryParse(key.Substring(1), out number) && number >= 1 && number <= 24) nextKey = 0x6F + number;
        else {
          var common = new Dictionary<string,int> { {"Space",0x20},{"Enter",0x0D},{"Tab",0x09},{"Backspace",0x08},{"Delete",0x2E},{"Insert",0x2D},{"Home",0x24},{"End",0x23},{"PageUp",0x21},{"PageDown",0x22},{"Up",0x26},{"Down",0x28},{"Left",0x25},{"Right",0x27},{"Pause",0x13},{"CapsLock",0x14},{"NumLock",0x90},{"ScrollLock",0x91} };
          if (!common.TryGetValue(key, out nextKey)) throw new ArgumentException("Invalid stop shortcut key");
        }
      }
      lock(keyState){stopShortcut = shortcut; stopKey = nextKey; stopModifiers = nextModifiers;}
    }
    bool HandleKey(int vk, bool ownInput, bool down) { lock(keyState) {
      if (ownInput) return false;
      if (!down) { physicalDown.Remove(vk); return swallowed.Remove(vk); }
      physicalDown.Add(vk);
      TrackComposition(vk);
      if (swallowed.Contains(vk)) return true;
      int modifiers = 0; foreach (int key in physicalDown) modifiers |= Modifier(key);
      if(progressAvailable&&progressKey!=0&&vk==progressKey&&modifiers==progressModifiers&&!(armed&&!paused&&vk==stopKey&&modifiers==stopModifiers)){
        swallowed.Add(vk);if(dispatcher.InvokeRequired)dispatcher.BeginInvoke((Action)(()=>{if(progress!=null)progress.SetLocked(!progress.Locked,true);}));else progress.SetLocked(!progress.Locked,true);return true;
      }
      if (!armed || paused) return false;
      if (vk != 0x1B && (stopKey == 0 || vk != stopKey || modifiers != stopModifiers)) return false;
      swallowed.Add(vk);
      long now = composeClock.ElapsedMilliseconds;
      // A single press is swallowed so it cannot reach the app being driven, and
      // only a second press of the same key inside the window stops the turn.
      if (stopPressKey != vk || stopPressAt < 0 || now - stopPressAt > StopPressWindowMs) {
        stopPressKey = vk; stopPressAt = now; return true;
      }
      stopPressKey = -1; stopPressAt = -1;
      // Signal the worker first, before any rendering or pipe activity.
      cancel.Set(); Stop(vk == 0x1B ? "escape" : "shortcut"); return true;
    }}
    // Test seam only: the real gesture needs two presses, this stops immediately.
    void TestStopForced(){ lock(keyState){ if(!armed||paused) return; } cancel.Set(); Stop("escape"); }
    void Stop(string reason, bool broadcast=true) {
      cancel.Set();paused=true;armed=false;
      if(broadcast)stopBus.Publish();
      Action draw=()=>{hideAt=DateTime.MaxValue;HideFrames();HidePointer();SyncTimer();};
      if(dispatcher.InvokeRequired){
        try{dispatcher.BeginInvoke(draw);}catch(InvalidOperationException){}
        ThreadPool.QueueUserWorkItem(_=>Emit(new {kind="stopped",reason=reason}));
      }else{draw();Emit(new {kind="stopped",reason=reason});}
    }
    void ShowFrames() {
      foreach (var bounds in displays) { var frame = new Frame(bounds, text, position, remoteVisible&&captureDepth==0, stopShortcut, Native.ScaleForDisplay(bounds)); frames.Add(frame); frame.Show(); frame.Present(255); }
    }
    void HideFrames() { foreach (var frame in frames) frame.Dispose(); frames.Clear(); }
    void UpdatePointer(byte alpha) {
      if (!armed || paused || !cursorIndicator) { HidePointer(); return; }
      Native.Point point;
      if(testMode&&testPointerPoint.HasValue)point=testPointerPoint.Value;
      else if (!Native.GetCursorPos(out point)) { cursorError=Marshal.GetLastWin32Error(); HidePointer(); return; }
      cursorError=0;
      if (pointer == null) { pointer = new PointerFrame(remoteVisible&&captureDepth==0); pointer.Update(point, alpha); pointer.Show(); }
      else pointer.Update(point, alpha);
    }
    void HidePointer() { if (pointer != null) { pointer.Dispose(); pointer = null; } }
    void CloseProgress() {
      progressAvailable=false;
      progressCloseWhenIdle=false;
      if(progress!=null){progress.Dispose();progress=null;}
      CloseAudit();
      CloseCompanion();
      if(pointerWatch!=null){pointerWatch.Dispose();pointerWatch=null;}
      SyncTimer();
    }
    // 审计窗和思考窗同显同隐：它跟着思考窗的位置走，由思考窗的 settings 配置。
    void CloseAudit() {
      if(audit!=null){audit.Dispose();audit=null;}
      SyncTimer();
    }
    void SyncAudit(Dictionary<string,object> settings) {
      bool enabled=settings==null||Get(settings,"auditOverlayEnabled",true);
      if(!enabled){CloseAudit();return;}
      if(audit==null)audit=new AuditFrame();
      audit.Configure(settings);
      if(progress!=null&&!progress.IsDisposed)audit.Follow(progress);
      if(progress!=null&&progress.Visible){if(!audit.Visible)audit.Show();}
      else if(audit.Visible)audit.Hide();
    }
    void AuditFollow() {
      if(audit==null)return;
      if(progress==null||progress.IsDisposed||!progress.Visible){if(audit.Visible)audit.Hide();return;}
      audit.Follow(progress);
      if(!audit.Visible)audit.Show();
      audit.Poll();
    }
    // Companion window follows the thinking window and is fed the same settings
    // block; it only draws when the host marked companionOverlayEnabled.
    void SyncCompanion(Dictionary<string,object> settings) {
      bool enabled = settings == null || Get(settings, "companionOverlayEnabled", false);
      if (!enabled) { CloseCompanion(); return; }
      if (companion == null) companion = new CompanionFrame();
      companion.Configure(settings);
      if (progress != null && !progress.IsDisposed) companion.Follow(progress);
      if (progress != null && progress.Visible) { if (!companion.Visible) companion.Show(); }
      else if (companion.Visible) companion.Hide();
    }
    void CompanionFollow() {
      if (companion == null) return;
      if (progress == null || progress.IsDisposed || !progress.Visible) { if (companion.Visible) companion.Hide(); return; }
      companion.Follow(progress);
      if (!companion.Visible) companion.Show();
      companion.Poll();
    }
    void CloseCompanion() {
      if (companion != null) { companion.Dispose(); companion = null; }
      SyncTimer();
    }
    // The overlay's lock button answers the user's own pointer only. The hook
    // runs only while a locked (or hover-unlocked) overlay is on screen.
    void TrackProgressPointer() {
      if(progress==null||progress.IsDisposed||!progress.IsHandleCreated)return;
      bool watching=progress.WantsPointer;
      if(watching&&pointerWatch==null)pointerWatch=new PointerWatch();
      else if(!watching&&pointerWatch!=null){pointerWatch.Dispose();pointerWatch=null;}
      if(!watching)return;
      Native.Point cursor,moved;
      if(testMode&&testOverlayCursor.HasValue)cursor=testOverlayCursor.Value;
      else if(!Native.GetCursorPos(out cursor))return;
      // The cursor must still be where the user's last local/remote move left it;
      // DSH moving it elsewhere (SetCursorPos) breaks the match.
      bool userPointer=pointerWatch.Latest(out moved)&&Math.Abs(moved.x-cursor.x)<=2&&Math.Abs(moved.y-cursor.y)<=2;
      progress.TrackPointer(cursor,userPointer);
    }
    protected override void Dispose(bool disposing) {
      if (disposing && !shuttingDown) {
        shuttingDown = true; cancel.Set(); timer.Stop(); timer.Dispose(); HideFrames(); HidePointer(); CloseProgress();
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged -= DisplaysChanged;
        Microsoft.Win32.SystemEvents.SessionSwitch -= SessionChanged;
        Microsoft.Win32.SystemEvents.UserPreferenceChanged -= PreferencesChanged;
        stopBus.Dispose();keyboard.Dispose();
        dispatcher.Dispose(); cancel.Dispose();
      }
      base.Dispose(disposing);
    }
  }

  // Independent progress window: never activates, captures input or arms Esc.
  // Per-pixel composition: the background can be translucent without fading text.
  // One physical-resolution surface also avoids opaque system scrollbars and DPI stretching.
  // appearance.json 拍平后的 settings → GDI+ 的颜色与字体。用户上传的字体放在
  // ~/.evolution-computer-use/fonts（插件负责复制），用 PrivateFontCollection 加载；
  // 家族名未知时按契约回退 Microsoft YaHei UI，再回退 Segoe UI。
  internal static class OverlayStyle {
    static PrivateFontCollection uploaded;
    static readonly HashSet<string> known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    static bool knownLoaded;
    static readonly object sync = new object();
    internal static Color Color(string text, Color fallback) {
      string value = text == null ? "" : text.Trim();
      if (value.StartsWith("#", StringComparison.Ordinal)) value = value.Substring(1);
      uint number;
      if (value.Length == 8 && uint.TryParse(value, System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out number))
        return System.Drawing.Color.FromArgb((int)((number >> 24) & 0xff), (int)((number >> 16) & 0xff), (int)((number >> 8) & 0xff), (int)(number & 0xff));
      if (value.Length == 6 && uint.TryParse(value, System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out number))
        return System.Drawing.Color.FromArgb(255, (int)((number >> 16) & 0xff), (int)((number >> 8) & 0xff), (int)(number & 0xff));
      return fallback;
    }
    internal static Color WithAlpha(Color color, int alpha) { return System.Drawing.Color.FromArgb(Math.Max(0, Math.Min(255, alpha)), color.R, color.G, color.B); }
    // 整窗透明度：每个绘制色的 alpha 都乘上它，位图整体 alpha 就是窗口 alpha。
    internal static Color Fade(Color color, double opacity) { return System.Drawing.Color.FromArgb(Math.Max(0, Math.Min(255, (int)Math.Round(color.A * opacity))), color.R, color.G, color.B); }
    static void LoadKnown() {
      lock (sync) {
        if (knownLoaded) return;
        knownLoaded = true;
        try {
          if (uploaded == null) {
            uploaded = new PrivateFontCollection();
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".evolution-computer-use", "fonts");
            if (Directory.Exists(dir)) {
              string[] files = Directory.GetFiles(dir);
              for (int i = 0; i < files.Length; i++) {
                string file = files[i];
                if (!file.EndsWith(".ttf", StringComparison.OrdinalIgnoreCase) && !file.EndsWith(".otf", StringComparison.OrdinalIgnoreCase)) continue;
                try { uploaded.AddFontFile(file); } catch (Exception) { }
              }
            }
          }
          FontFamily[] own = uploaded.Families;
          for (int i = 0; i < own.Length; i++) known.Add(own[i].Name);
          using (var installed = new InstalledFontCollection()) {
            FontFamily[] families = installed.Families;
            for (int i = 0; i < families.Length; i++) known.Add(families[i].Name);
          }
        } catch (Exception) { }
      }
    }
    internal static Font Create(string family, float pixels, FontStyle style, out string resolved) {
      LoadKnown();
      float size = Math.Max(6f, Math.Min(200f, pixels));
      if (!String.IsNullOrWhiteSpace(family)) {
        try {
          FontFamily[] own = uploaded.Families;
          for (int i = 0; i < own.Length; i++) {
            if (!String.Equals(own[i].Name, family, StringComparison.OrdinalIgnoreCase)) continue;
            try { resolved = own[i].Name; return new Font(own[i], size, style, GraphicsUnit.Pixel); } catch (Exception) { }
          }
        } catch (Exception) { }
      }
      string[] fallbacks = new string[] { family, "Microsoft YaHei UI", "Segoe UI", "Tahoma" };
      for (int i = 0; i < fallbacks.Length; i++) {
        string name = fallbacks[i];
        if (String.IsNullOrWhiteSpace(name) || !known.Contains(name)) continue;
        try { resolved = name; return new Font(name, size, style, GraphicsUnit.Pixel); } catch (Exception) { }
      }
      resolved = "Segoe UI";
      return new Font(FontFamily.GenericSansSerif, size, style, GraphicsUnit.Pixel);
    }
  }
  internal sealed class ProgressFrame : Form {
    sealed class ReadingLine { internal string text; internal bool heading; internal ReadingLine(string s,bool h){text=s;heading=h;} }
    readonly List<ReadingLine> lines=new List<ReadingLine>();
    internal string Content="";
    internal bool Locked=true;
    // appearance.json 的 thought 外观：整窗透明度 + 颜色 + 字体（见 Present/Configure）。
    internal double WindowOpacity=.6;
    Color styleBackground=Color.FromArgb(153,25,29,38),styleBorder=Color.FromArgb(140,117,161,218),styleText=Color.FromArgb(255,246,247,250),styleMuted=Color.FromArgb(245,185,198,216),styleAccent=Color.FromArgb(255,91,143,239);
    string styleFontFamily="";
    float styleTitlePixels=14f,styleBodyPixels=14.667f;
    internal string FontDescription="Microsoft YaHei UI 14/14.667";
    Font bodyFont,headingFont,titleFont,footerFont;
    string header="",subheader="",bodyText="";
    string[] headings=new string[0];
    bool followOutput=true,remoteVisible=true,configuredLocked=true,configured,presenting,draggingThumb,revealedResult,previewUnlocked,hoverUnlocked,hoverBlocked=true,sizing;
    // Resting the pointer on the lock button this long unlocks the window; it
    // locks again once the pointer has been away from the window this long.
    internal const int HoverUnlockMs=400,HoverRelockMs=1500;
    DateTime hoverSince=DateTime.MinValue,awaySince=DateTime.MinValue;
    float hoverFraction;
    // Sizes and positions this window reported itself, with when, so that their
    // echo from the settings never moves the window back (see Configure).
    readonly List<KeyValuePair<string,DateTime>> emitted=new List<KeyValuePair<string,DateTime>>();
    string geometry="";
    int paints,scrollY,wheelRemainder,dragOffset;
    float scale=1,testScale;
    Rectangle viewport,track,thumb;
    Form testBackdrop;
    Dictionary<string,object> baseline=new Dictionary<string,object>();
    readonly Action<Dictionary<string,object>,Dictionary<string,object>> changed;
    readonly Action closeRequested;
    int Px(float n){return (int)Math.Round(n*scale);}
    int LineHeight {get{return Math.Max(Px(20),(int)Math.Ceiling(bodyFont.GetHeight())+Px(2));}}
    int TotalHeight {get{return lines.Count*LineHeight;}}
    int MaxScroll {get{return Math.Max(0,TotalHeight-viewport.Height);}}
    internal ProgressFrame(Action<Dictionary<string,object>,Dictionary<string,object>> callback,Action onClose){
      changed=callback;closeRequested=onClose;AutoScaleMode=AutoScaleMode.None;FormBorderStyle=FormBorderStyle.None;
      ShowInTaskbar=false;TopMost=true;StartPosition=FormStartPosition.Manual;
      MinimumSize=new Size(240,160);MaximumSize=new Size(1600,1600);
      SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.ResizeRedraw,true);
      SetFonts(1);LayoutBody();
    }
    void SetFonts(float next){
      if(bodyFont!=null){bodyFont.Dispose();headingFont.Dispose();titleFont.Dispose();footerFont.Dispose();}
      scale=next;string resolved;
      // 字号是 96-DPI 像素，再乘窗口 DPI 缩放；家族按 OverlayStyle 的回退链解析。
      bodyFont=OverlayStyle.Create(styleFontFamily,styleBodyPixels*scale,FontStyle.Regular,out resolved);
      headingFont=OverlayStyle.Create(styleFontFamily,styleBodyPixels*scale,FontStyle.Bold,out resolved);
      titleFont=OverlayStyle.Create(styleFontFamily,styleTitlePixels*scale,FontStyle.Bold,out resolved);
      footerFont=OverlayStyle.Create(styleFontFamily,11.5f*scale,FontStyle.Regular,out resolved);
      FontDescription=resolved+" "+FormatSize(styleTitlePixels)+"/"+FormatSize(styleBodyPixels);
    }
    static string FormatSize(float pixels){return pixels.ToString("0.###",System.Globalization.CultureInfo.InvariantCulture);}
    void RefreshDpi(){
      float next=1;try{next=Native.GetDpiForWindow(Handle)/96f;}catch(EntryPointNotFoundException){}
      if(testScale>0)next=testScale;next=Math.Max(1,Math.Min(4,next));
      if(Math.Abs(next-scale)>.01f){SetFonts(next);LayoutBody();}
    }
    protected override bool ShowWithoutActivation {get{return true;}}
    protected override CreateParams CreateParams {get{var p=base.CreateParams;p.ExStyle|=0x80000|0x80|0x08000000;if(Locked)p.ExStyle|=0x20;return p;}}
    protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);RefreshDpi();Native.ApplyDisplayAffinity(this,remoteVisible);}
    protected override void OnShown(EventArgs e){base.OnShown(e);Present();}
    internal bool ClickThrough {get{return (Native.GetWindowLong(Handle,-20)&0x08000020)==0x08000020;}}
    static string TextValue(Dictionary<string,object> data,string key){object v;if(data==null||!data.TryGetValue(key,out v)||v==null)return "";string s=Convert.ToString(v);return s.Length>1200?s.Substring(s.Length-1200):s;}
    static int NumberValue(Dictionary<string,object> data,string key,int fallback){object v;return data!=null&&data.TryGetValue(key,out v)?Convert.ToInt32(v):fallback;}
    static double NumberDouble(Dictionary<string,object> data,string key,double fallback){object v;return data!=null&&data.TryGetValue(key,out v)&&v!=null?Convert.ToDouble(v,System.Globalization.CultureInfo.InvariantCulture):fallback;}
    internal void Configure(Dictionary<string,object> settings,bool visible){
      int width=Math.Max(240,Math.Min(1600,NumberValue(settings,"progressOverlayWidth",360))),height=Math.Max(160,Math.Min(1600,NumberValue(settings,"progressOverlayHeight",240)));
      int x=NumberValue(settings,"progressOverlayX",80),y=NumberValue(settings,"progressOverlayY",80),opacity=NumberValue(settings,"progressOverlayOpacity",60);
      string position=TextValue(settings,"progressOverlayPosition");if(position=="")position="top-right";
      double titleSize=NumberDouble(settings,"progressOverlayTitleSize",14),bodySize=NumberDouble(settings,"progressOverlayBodySize",14.667);
      string family=TextValue(settings,"progressOverlayFontFamily"),bgText=TextValue(settings,"progressOverlayBg"),borderText=TextValue(settings,"progressOverlayBorder"),textText=TextValue(settings,"progressOverlayText"),mutedText=TextValue(settings,"progressOverlayMuted"),accentText=TextValue(settings,"progressOverlayAccent");
      object v;bool locked=settings==null||!settings.TryGetValue("progressOverlayLocked",out v)||Convert.ToBoolean(v);
      string signature=width+","+height+","+x+","+y+","+position;
      baseline=new Dictionary<string,object>{{"progressOverlayWidth",width},{"progressOverlayHeight",height},{"progressOverlayX",x},{"progressOverlayY",y},{"progressOverlayPosition",position},{"progressOverlayLocked",locked}};
      if(signature!=geometry){
        // The settings echo each size or position this window reports, about
        // half a second later. An echo of an older report would move the window
        // back if the user has moved or resized it again since (the settings
        // keep the first of two quick reports); keep the window where it is and
        // report its current layout against the settings that just arrived.
        if(position=="custom"&&emitted.Exists(entry=>entry.Key==signature&&(DateTime.UtcNow-entry.Value).TotalSeconds<=10)){
          geometry=signature;if(!sizing&&Bounds!=new Rectangle(x,y,width,height))EmitLayout();
        } else {var area=Screen.PrimaryScreen.WorkingArea;if(position!="custom"){x=position.EndsWith("right")?area.Right-width-20:area.Left+20;y=position.StartsWith("bottom")?area.Bottom-height-20:area.Top+70;}var next=new Rectangle(x,y,width,height);if(Bounds!=next)Bounds=next;geometry=signature;}
      }
      if(!configured||configuredLocked!=locked){SetLocked(locked,false);configuredLocked=locked;}
      configured=true;remoteVisible=visible;
      // 整窗透明度：20-100 的 appearance 值映射到窗口 alpha，在 Present 的 BLENDFUNCTION 里应用。
      WindowOpacity=Math.Max(.2,Math.Min(1,opacity/100.0));
      styleBackground=OverlayStyle.Color(bgText,Color.FromArgb(153,25,29,38));
      styleBorder=OverlayStyle.Color(borderText,Color.FromArgb(140,117,161,218));
      styleText=OverlayStyle.Color(textText,Color.FromArgb(255,246,247,250));
      styleMuted=OverlayStyle.Color(mutedText,Color.FromArgb(245,185,198,216));
      styleAccent=OverlayStyle.Color(accentText,Color.FromArgb(255,91,143,239));
      bool fontsChanged=styleFontFamily!=family||Math.Abs(styleTitlePixels-(float)titleSize)>.01||Math.Abs(styleBodyPixels-(float)bodySize)>.01;
      styleFontFamily=family;styleTitlePixels=(float)titleSize;styleBodyPixels=(float)bodySize;
      if(fontsChanged){SetFonts(scale);LayoutBody();}
      if(IsHandleCreated){Native.ApplyDisplayAffinity(this,visible);RefreshDpi();}Present();
    }
    internal bool IsPreview {get{return previewUnlocked;}}
    internal void BeginPreview(){previewUnlocked=true;SetLocked(false,false);}
    internal void EndPreview(){if(!previewUnlocked)return;previewUnlocked=false;SetLocked(configuredLocked,false);}
    // After any lock the pointer must leave the button before resting on it
    // unlocks again, so clicking the open padlock (or the shortcut) holds.
    internal void SetLocked(bool locked,bool notify){if(notify)previewUnlocked=false;hoverUnlocked=false;hoverBlocked=locked;hoverSince=awaySince=DateTime.MinValue;hoverFraction=0;ApplyLock(locked);if(notify)changed(new Dictionary<string,object>{{"progressOverlayLocked",locked}},new Dictionary<string,object>{{"progressOverlayLocked",configuredLocked}});}
    void ApplyLock(bool locked){Locked=locked;draggingThumb=false;Capture=false;if(IsHandleCreated){int style=Native.GetWindowLong(Handle,-20);Native.SetWindowLong(Handle,-20,locked?style|0x20:style&~0x20);Native.SetWindowPos(Handle,IntPtr.Zero,0,0,0,0,0x37);}LayoutBody();Present();}
    // Clicking the open padlock locks the window now. A temporary unlock (hover
    // or preview) just ends; a window unlocked in the settings saves the locked
    // state, as the lock shortcut does.
    void LockNow(){bool save=!configuredLocked;previewUnlocked=false;SetLocked(true,save);}
    internal bool WantsPointer {get{return Locked||hoverUnlocked;}}
    // True while the user is adjusting the window, which then stays until they are done.
    internal bool Adjusting {get{return hoverUnlocked||sizing||draggingThumb;}}
    Rectangle LockZone {get{return new Rectangle(Width-Px(32),0,Px(32),Px(34));}}
    Rectangle CloseZone {get{return new Rectangle(Width-Px(60),0,Px(28),Px(34));}}
    // The padlock in the top-right corner is the lock button. While the window
    // passes the mouse through, resting the user's own pointer on it for a
    // moment unlocks the window, so it can be moved and resized; once the
    // pointer has been away for a while it locks again. The saved lock setting
    // is not changed, and DSH's own pointer moves never count (userPointer=false).
    internal void TrackPointer(Native.Point cursor,bool userPointer){
      if(IsDisposed)return;
      var now=DateTime.UtcNow;var at=new Point(cursor.x-Left,cursor.y-Top);
      if(Locked){
        bool over=LockZone.Contains(at);
        if(hoverBlocked){if(!over)hoverBlocked=false;return;}
        if(!(userPointer&&over)){if(hoverSince!=DateTime.MinValue){hoverSince=DateTime.MinValue;hoverFraction=0;Present();}return;}
        if(hoverSince==DateTime.MinValue)hoverSince=now;
        float fraction=(float)Math.Min(1,(now-hoverSince).TotalMilliseconds/HoverUnlockMs);
        if(fraction>=1){hoverSince=awaySince=DateTime.MinValue;hoverFraction=0;hoverUnlocked=true;ApplyLock(false);return;}
        if(fraction-hoverFraction>=.04f||hoverFraction==0){hoverFraction=Math.Max(.01f,fraction);Present();}
      } else if(hoverUnlocked){
        var near=new Rectangle(-Px(8),-Px(8),Width+Px(16),Height+Px(16));
        if(near.Contains(at)||sizing||draggingThumb){awaySince=DateTime.MinValue;return;}
        if(awaySince==DateTime.MinValue)awaySince=now;
        else if((now-awaySince).TotalMilliseconds>=HoverRelockMs)SetLocked(true,false);
      }
    }
    internal object HoverStatus(){var zone=LockZone;return new {unlocked=hoverUnlocked,preview=previewUnlocked,configuredLocked=configuredLocked,blocked=hoverBlocked,dwelling=hoverSince!=DateTime.MinValue,fraction=hoverFraction,away=awaySince!=DateTime.MinValue,sizing=sizing,lockZone=new{x=zone.X,y=zone.Y,width=zone.Width,height=zone.Height}};}
    internal void RequestClose(){closeRequested();}
    internal void EmitLayout(){
      var now=DateTime.UtcNow;string signature=Width+","+Height+","+Left+","+Top+",custom";
      emitted.RemoveAll(entry=>entry.Key==signature||(now-entry.Value).TotalSeconds>10);emitted.Add(new KeyValuePair<string,DateTime>(signature,now));
      changed(new Dictionary<string,object>{{"progressOverlayWidth",Width},{"progressOverlayHeight",Height},{"progressOverlayPosition","custom"},{"progressOverlayX",Left},{"progressOverlayY",Top},{"progressOverlayLocked",previewUnlocked||hoverUnlocked?configuredLocked:Locked}},baseline);
    }
    // The reading area holds whole lines only, so no line is ever cut in half
    // at its top or bottom edge. A locked window has no footer line.
    void LayoutBody(){
      if(bodyFont==null)return;
      int top=Px(subheader.Length==0?39:60),lineHeight=LineHeight;
      int available=Math.Max(lineHeight,ClientSize.Height-top-(Locked?Px(8):Px(26)));
      viewport=new Rectangle(Px(12),top,Math.Max(24,ClientSize.Width-Px(36)),Math.Max(1,available/lineHeight)*lineHeight);
      lines.Clear();
      using(var image=new Bitmap(1,1))using(var g=Graphics.FromImage(image))using(var format=(StringFormat)StringFormat.GenericTypographic.Clone()){
        format.FormatFlags|=StringFormatFlags.MeasureTrailingSpaces;
        int widest=Math.Max(8,(int)(viewport.Width/Math.Max(1f,bodyFont.Size*.2f)));
        foreach(string paragraph in bodyText.Replace("\r","").Split('\n')){
          bool heading=Array.IndexOf(headings,paragraph)>=0;Font font=heading?headingFont:bodyFont;
          if(paragraph.Length==0){lines.Add(new ReadingLine("",false));continue;}
          int at=0;while(at<paragraph.Length){
            int lo=1,hi=Math.Min(paragraph.Length-at,widest),best=1;
            while(lo<=hi){int mid=(lo+hi)/2;float width=g.MeasureString(paragraph.Substring(at,mid),font,Int32.MaxValue,format).Width;if(width<=viewport.Width){best=mid;lo=mid+1;}else hi=mid-1;}
            // Keep surrogate pairs and ordinary Latin words together when wrapping.
            if(at+best<paragraph.Length&&best>1&&Char.IsHighSurrogate(paragraph[at+best-1]))best--;
            if(at+best<paragraph.Length&&best>1&&"，。！？；：、）】》…,.!?;:)".IndexOf(paragraph[at+best])>=0)best--;
            if(at+best<paragraph.Length&&Char.IsLetterOrDigit(paragraph[at+best])&&paragraph[at+best]<128){int space=paragraph.LastIndexOf(' ',at+best-1,best);if(space>at+best/2)best=space-at+1;}
            lines.Add(new ReadingLine(paragraph.Substring(at,best),heading));at+=best;
          }
        }
      }
      scrollY=followOutput?MaxScroll:Snap(Math.Min(scrollY,MaxScroll));LayoutScrollbar();
    }
    int Snap(int y){int lineHeight=Math.Max(1,LineHeight);return (int)Math.Round(y/(double)lineHeight)*lineHeight;}
    void LayoutScrollbar(){track=new Rectangle(Width-Px(16),viewport.Y,Px(6),viewport.Height);int height=Math.Min(track.Height,Math.Max(Px(26),(int)((long)track.Height*viewport.Height/Math.Max(1,TotalHeight))));thumb=new Rectangle(track.X,track.Y+(MaxScroll==0?0:(int)((long)(track.Height-height)*scrollY/MaxScroll)),track.Width,height);}
    void ScrollTo(int y){scrollY=Math.Max(0,Math.Min(MaxScroll,Snap(y)));followOutput=scrollY>=MaxScroll-2;LayoutScrollbar();Present();}
    protected override void OnResize(EventArgs e){base.OnResize(e);LayoutBody();Present();}
    protected override void OnLocationChanged(EventArgs e){base.OnLocationChanged(e);if(IsHandleCreated){RefreshDpi();Present();}}
    protected override void OnResizeEnd(EventArgs e){base.OnResizeEnd(e);if(!Locked)EmitLayout();}
    protected override void OnMouseDown(MouseEventArgs e){
      if(!Locked&&e.Button==MouseButtons.Left){if(LockZone.Contains(e.Location)){LockNow();return;}if(CloseZone.Contains(e.Location)){closeRequested();return;}if(e.X>=track.X-Px(6)&&e.Y>=track.Top&&e.Y<track.Bottom&&MaxScroll>0){if(thumb.Contains(e.Location)){draggingThumb=true;dragOffset=e.Y-thumb.Top;Capture=true;}else ScrollTo(scrollY+(e.Y<thumb.Top?-viewport.Height:viewport.Height));return;}}
      base.OnMouseDown(e);
    }
    protected override void OnMouseMove(MouseEventArgs e){if(draggingThumb&&!Locked)ScrollTo((int)((long)(e.Y-dragOffset-track.Top)*MaxScroll/Math.Max(1,track.Height-thumb.Height)));base.OnMouseMove(e);}
    protected override void OnMouseUp(MouseEventArgs e){draggingThumb=false;Capture=false;base.OnMouseUp(e);}
    protected override void OnMouseCaptureChanged(EventArgs e){if(!Capture)draggingThumb=false;base.OnMouseCaptureChanged(e);}
    protected override void WndProc(ref Message m){
      if(m.Msg==0x21){m.Result=new IntPtr(3);return;}
      if(m.Msg==0x020a){if(!Locked)ScrollWheel((short)(m.WParam.ToInt64()>>16));m.Result=IntPtr.Zero;return;}
      if(m.Msg==0x02e0){base.WndProc(ref m);RefreshDpi();Present();return;}
      if(m.Msg==0x0231)sizing=true;else if(m.Msg==0x0232)sizing=false;
      if(m.Msg==0x84){if(Locked){m.Result=new IntPtr(-1);return;}long value=m.LParam.ToInt64();int x=(short)(value&0xffff)-Left,y=(short)((value>>16)&0xffff)-Top;int edge=Px(6);if(x>=Width-Px(60)&&y<Px(34)){m.Result=new IntPtr(1);return;}int hit=y<edge?(x<edge?13:x>=Width-edge?14:12):y>=Height-edge?(x<edge?16:x>=Width-edge?17:15):x<edge?10:x>=Width-edge?11:y<Px(35)?2:1;m.Result=new IntPtr(hit);return;}
      base.WndProc(ref m);
    }
    static List<Dictionary<string,object>> Items(Dictionary<string,object> data,string key){
      var items=new List<Dictionary<string,object>>();object value;
      if(data==null||!data.TryGetValue(key,out value)||value==null||value is string)return items;
      var list=value as System.Collections.IEnumerable;if(list==null)return items;
      foreach(object item in list){var entry=item as Dictionary<string,object>;if(entry!=null)items.Add(entry);}
      return items;
    }
    static bool Flag(Dictionary<string,object> data,string key){object v;if(data==null||!data.TryGetValue(key,out v)||v==null)return false;try{return Convert.ToBoolean(v);}catch(FormatException){return false;}}
    internal static long Whole(Dictionary<string,object> data,string key){object v;if(data==null||!data.TryGetValue(key,out v)||v==null)return 0;try{return Convert.ToInt64(v);}catch(FormatException){return 0;}catch(InvalidCastException){return 0;}catch(OverflowException){return 0;}}
    static string Shorten(string text,int limit){text=text.Trim();return text.Length>limit?"…"+text.Substring(text.Length-limit+1):text;}
    // DSH renders Markdown, so plain text shows the same words without the
    // marks; paragraphs follow each other without blank lines in a small window.
    static readonly System.Text.RegularExpressions.Regex RxCodeFence=new System.Text.RegularExpressions.Regex(@"(?m)^[ \t]*```[^\n]*\n?",System.Text.RegularExpressions.RegexOptions.Compiled);
    static readonly System.Text.RegularExpressions.Regex RxImage=new System.Text.RegularExpressions.Regex(@"!\[([^\]\n]*)\]\([^)\n]*\)",System.Text.RegularExpressions.RegexOptions.Compiled);
    static readonly System.Text.RegularExpressions.Regex RxLink=new System.Text.RegularExpressions.Regex(@"\[([^\]\n]+)\]\([^)\n]*\)",System.Text.RegularExpressions.RegexOptions.Compiled);
    static readonly System.Text.RegularExpressions.Regex RxBold=new System.Text.RegularExpressions.Regex(@"(\*\*|__)(?=\S)(.+?)(?<=\S)\1",System.Text.RegularExpressions.RegexOptions.Compiled);
    static readonly System.Text.RegularExpressions.Regex RxCode=new System.Text.RegularExpressions.Regex(@"`([^`\n]+)`",System.Text.RegularExpressions.RegexOptions.Compiled);
    static readonly System.Text.RegularExpressions.Regex RxHeading=new System.Text.RegularExpressions.Regex(@"(?m)^[ \t]{0,3}#{1,6}[ \t]+",System.Text.RegularExpressions.RegexOptions.Compiled);
    static readonly System.Text.RegularExpressions.Regex RxBullet=new System.Text.RegularExpressions.Regex(@"(?m)^([ \t]*)[-*+][ \t]+",System.Text.RegularExpressions.RegexOptions.Compiled);
    static readonly System.Text.RegularExpressions.Regex RxBlankLines=new System.Text.RegularExpressions.Regex(@"\n[ \t]*(?:\n[ \t]*)+",System.Text.RegularExpressions.RegexOptions.Compiled);
    static string Readable(string text){
      text=(text??"").Replace("\r","");
      text=RxCodeFence.Replace(text,"");
      text=RxImage.Replace(text,match=>match.Groups[1].Value.Trim()==""?Words.Get("image"):Words.Format("imageNamed",match.Groups[1].Value.Trim()));
      text=RxLink.Replace(text,"$1");
      text=RxBold.Replace(text,"$2");
      text=RxCode.Replace(text,"$1");
      text=RxHeading.Replace(text,"");
      text=RxBullet.Replace(text,"$1• ");
      text=RxBlankLines.Replace(text,"\n");
      return text.Trim();
    }
    // When a task ends with a reply longer than the window, show the reply from
    // its first line (the result) rather than its last; a reader who scrolled
    // away keeps their place. The reply heading is kept from the update that
    // wrote it, so a language switch cannot hide it.
    string replyHeading="";
    void RevealResult(bool finished){
      if(!finished){revealedResult=false;return;}
      if(revealedResult||!followOutput)return;
      int at=-1;for(int i=lines.Count-1;i>=0;i--)if(lines[i].heading&&lines[i].text==replyHeading){at=i;break;}
      if(at<0)return;
      revealedResult=true;
      if(TotalHeight-at*LineHeight>viewport.Height){scrollY=Math.Min(MaxScroll,at*LineHeight);followOutput=false;LayoutScrollbar();}
    }
    // One heading per model step ("Step 3 · Scroll the page"), then the text DSH
    // showed for that step. Older steps keep only their last lines; the current
    // step and the reply are shown in full.
    static string StepHeading(Dictionary<string,object> entry){
      var labels=new List<string>();
      foreach(var action in Items(entry,"actions")){string label=TextValue(action,"label");if(label!="")labels.Add(TextValue(action,"state")=="error"?Words.Format("actionError",label):label);}
      string step=TextValue(entry,"step");
      return labels.Count>0?Words.Format("stepActions",step,String.Join(Words.Get("listSeparator"),labels.ToArray())):Words.Format("stepHeading",step);
    }
    static string DoneHeaderKey(string step){long n;if(!long.TryParse(step,out n))return "headerDone";long a=Math.Abs(n),m10=a%10,m100=a%100;if(n==1)return "headerDoneOne";if(m10>=2&&m10<=4&&(m100<12||m100>14))return "headerDoneFew";return "headerDone";}
    internal void UpdateProgress(Dictionary<string,object> data){
      string status=TextValue(data,"status");
      string step=TextValue(data,"step");if(step==""||step=="0")step="1";
      long started=Whole(data,"startedAt"),ended=Whole(data,"endedAt");
      bool finished=ended>0&&(status=="done"||status=="failed"||status=="stopped");
      string took=started>0&&ended>=started?Words.Format("took",Math.Max(1,(long)Math.Round((ended-started)/1000.0))):"";
      if(finished)header=status=="done"?Words.Format(DoneHeaderKey(step),step,took):Words.Format(status=="failed"?"headerFailed":"headerStopped",step);
      else header=Words.Format("headerWorking",step,Words.Get(status=="thinking"?"statusThinking":status=="acting"?"statusActing":status=="replying"?"statusReplying":status=="stopped"?"statusStopped":"statusWorking"));
      // The plugin names each action; a bare tool name stands in for one it did not name.
      string action=TextValue(data,"action");if(action=="")action=TextValue(data,"tool");
      subheader=finished?"":action;
      replyHeading=Words.Get("replyHeading");
      var steps=Items(data,"steps");var text=new List<string>();var heads=new List<string>();
      Action<string> head=delegate(string value){text.Add(value);heads.Add(value);};
      if(TextValue(data,"displayMode")=="summary"){
        // Summary mode: the AI summaries in order, newest last. Until the first
        // one arrives (or when the model is unavailable) the step names stand in.
        var summaries=Items(data,"summaries");string latest="";
        foreach(var item in summaries){string value=Readable(TextValue(item,"text"));if(value==""||value==latest)continue;head(Flag(item,"final")?Words.Get("summaryResult"):Words.Format("summaryStep",TextValue(item,"step")));text.Add(value);latest=value;}
        bool finalSummary=summaries.Count>0&&Flag(summaries[summaries.Count-1],"final");
        if(latest==""){
          foreach(var entry in steps)head(StepHeading(entry));
          string summaryStatus=TextValue(data,"summaryStatus");
          text.Add(Words.Get(summaryStatus=="unavailable"?"summaryUnavailable":finished?"summarizingResult":"summarizing"));
        }
        string reply=Readable(steps.Count>0?TextValue(steps[steps.Count-1],"reply"):TextValue(data,"reply"));
        if(finished&&!finalSummary&&reply!=""&&TextValue(data,"summaryStatus")!="working"){head(replyHeading);text.Add(reply);}
      } else if(steps.Count>0){
        int shown=Math.Max(0,steps.Count-12);
        for(int i=shown;i<steps.Count;i++){
          var entry=steps[i];bool current=i==steps.Count-1;head(StepHeading(entry));
          string reasoning=Readable(TextValue(entry,"reasoning")),reply=Readable(TextValue(entry,"reply"));
          if(reasoning!="")text.Add(current?reasoning:Shorten(reasoning,240));
          if(reply!=""){head(replyHeading);text.Add(reply);}
        }
      } else {
        string reasoning=Readable(TextValue(data,"reasoning")),reply=Readable(TextValue(data,"reply"));
        if(reasoning!=""){head(Words.Get("thinkingHeading"));text.Add(reasoning);}
        if(reply!=""){head(replyHeading);text.Add(reply);}
      }
      bodyText=text.Count>0?String.Join("\n",text.ToArray()):Words.Get("waiting");headings=heads.ToArray();
      Content=header+"\n"+subheader+"\n\n"+bodyText;LayoutBody();RevealResult(finished);Present();
    }
    // A dark halo under light text keeps it readable when a bright page shows
    // through the translucent background.
    static void Shadowed(Graphics g,string text,Font font,Brush brush,Brush shadow,RectangleF where,StringFormat format,float offset){
      g.DrawString(text,font,shadow,new RectangleF(where.X+offset,where.Y+offset,where.Width,where.Height),format);g.DrawString(text,font,brush,where,format);
    }
    // The lock button stays in the top-right corner: a closed padlock while
    // the mouse passes through (a ring fills while the pointer rests on it),
    // an open one (click to lock) with Close beside it while unlocked.
    void DrawButtons(Graphics g,Pen closePen){
      float cx=Width-scale*19,cy=scale*18,r=scale*12;var disc=new RectangleF(cx-r,cy-r,2*r,2*r);
      using(var brush=new SolidBrush(OverlayStyle.WithAlpha(styleAccent,Locked?(hoverFraction>0?76:34):52)))g.FillEllipse(brush,disc);
      if(Locked&&hoverFraction>0)using(var ring=new Pen(OverlayStyle.WithAlpha(styleAccent,245),Math.Max(1.5f,scale*2))){g.DrawArc(ring,disc.X+scale,disc.Y+scale,disc.Width-2*scale,disc.Height-2*scale,-90,360*hoverFraction);}
      Color ink=Locked?OverlayStyle.WithAlpha(styleMuted,220):OverlayStyle.WithAlpha(styleText,245);
      float lift=Locked?0:scale*3;
      using(var pen=new Pen(ink,Math.Max(1f,scale*1.3f)))using(var fill=new SolidBrush(ink)){
        g.DrawArc(pen,cx-scale*3.5f,cy-scale*7-lift,scale*7,scale*9,180,180);
        if(lift>0)g.DrawLine(pen,cx-scale*3.5f,cy-scale*2.5f-lift,cx-scale*3.5f,cy-scale*2);
        using(var body=Frame.Rounded(new RectangleF(cx-scale*5.5f,cy-scale*2,scale*11,scale*8),Math.Max(1,scale*1.5f)))g.FillPath(fill,body);
      }
      if(!Locked){float x=Width-scale*46,y=scale*17.5f,d=scale*4.5f;g.DrawLine(closePen,x-d,y-d,x+d,y+d);g.DrawLine(closePen,x-d,y+d,x+d,y-d);}
    }
    Bitmap DrawSurface(){
      var image=new Bitmap(Math.Max(1,Width),Math.Max(1,Height),PixelFormat.Format32bppPArgb);
      using(var g=Graphics.FromImage(image)){
        g.Clear(Color.Transparent);g.SmoothingMode=SmoothingMode.AntiAlias;g.TextRenderingHint=TextRenderingHint.AntiAliasGridFit;
        using(var shape=Frame.Rounded(new RectangleF(.5f,.5f,Width-1,Height-1),Px(8)))using(var bg=new SolidBrush(styleBackground))using(var border=new Pen(styleBorder,1)){g.FillPath(bg,shape);g.DrawPath(border,shape);}
        using(var fg=new SolidBrush(styleText))using(var muted=new SolidBrush(styleMuted))using(var shadow=new SolidBrush(Color.FromArgb(150,0,0,0)))using(var pen=new Pen(OverlayStyle.WithAlpha(styleText,235),Px(1.3f)))using(var format=(StringFormat)StringFormat.GenericTypographic.Clone()){
          format.FormatFlags|=StringFormatFlags.NoWrap|StringFormatFlags.MeasureTrailingSpaces;format.Trimming=StringTrimming.EllipsisCharacter;
          float halo=Math.Max(1f,scale*.75f);
          Shadowed(g,header,titleFont,fg,shadow,new RectangleF(Px(12),Px(10),Math.Max(10,Width-Px(Locked?52:68)),Px(24)),format,halo);
          DrawButtons(g,pen);
          if(subheader!="")Shadowed(g,subheader,footerFont,muted,shadow,new RectangleF(Px(12),Px(36),Math.Max(10,Width-Px(24)),Px(21)),format,halo);
          var clip=g.Save();g.SetClip(viewport);int first=scrollY/LineHeight,last=Math.Min(lines.Count,(scrollY+viewport.Height)/LineHeight+1);
          for(int i=first;i<last;i++){var line=lines[i];Font font=line.heading?headingFont:bodyFont;Brush brush=line.heading?muted:fg;float x=viewport.X,y=viewport.Y+i*LineHeight-scrollY;g.DrawString(line.text,font,shadow,new PointF(x+halo,y+halo),format);g.DrawString(line.text,font,brush,new PointF(x,y),format);}
          g.Restore(clip);
          if(!Locked)Shadowed(g,Words.Get(hoverUnlocked?"hintUnlocked":previewUnlocked?"hintPreview":"hintAdjust"),footerFont,muted,shadow,new RectangleF(Px(12),Height-Px(22),Math.Max(10,Width-Px(24)),Px(20)),format,halo);
        }
        // The translucent scrollbar appears only when there is more to read.
        if(MaxScroll>0){
          using(var shape=Frame.Rounded(track,Math.Max(1,Px(3))))using(var brush=new SolidBrush(OverlayStyle.WithAlpha(styleMuted,32)))g.FillPath(brush,shape);
          using(var shape=Frame.Rounded(thumb,Math.Max(1,Px(3))))using(var brush=new SolidBrush(OverlayStyle.WithAlpha(styleMuted,112)))g.FillPath(brush,shape);
        }
      }return image;
    }
    void Present(){
      if(presenting||!IsHandleCreated||IsDisposed||Width<1||Height<1)return;presenting=true;
      try{using(var image=DrawSurface()){IntPtr dc=Native.CreateCompatibleDC(IntPtr.Zero),bitmap=image.GetHbitmap(Color.FromArgb(0)),previous=Native.SelectObject(dc,bitmap);try{var dest=new Native.Point(Left,Top);var origin=new Native.Point(0,0);var size=new Native.Size(Width,Height);var blend=new Native.Blend{op=0,flags=0,alpha=(byte)Math.Max(0,Math.Min(255,Math.Round(WindowOpacity*255))),format=1};if(!Native.UpdateLayeredWindow(Handle,IntPtr.Zero,ref dest,ref size,dc,ref origin,0,ref blend,2))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Could not present progress overlay");paints++;}finally{Native.SelectObject(dc,previous);Native.DeleteObject(bitmap);Native.DeleteDC(dc);}}}finally{presenting=false;}
    }
    protected override void OnPaint(PaintEventArgs e){Present();}
    internal object ReadingStatus(){return new {scrollbar=true,position=scrollY,maximum=Math.Max(0,TotalHeight-1),page=viewport.Height,atBottom=scrollY>=MaxScroll-2,following=followOutput,text=bodyText,lineHeight=LineHeight,emPixels=bodyFont.Size,viewport=new{x=viewport.X,y=viewport.Y,width=viewport.Width,height=viewport.Height},resizeRedraw=GetStyle(ControlStyles.ResizeRedraw),paints=paints,dpiScale=scale,textAlpha=255,backgroundAlpha=(int)Math.Round(styleBackground.A*WindowOpacity),windowOpacity=Math.Round(WindowOpacity,3),font=FontDescription,scrollbarTrackAlpha=MaxScroll>0?32:0,scrollbarThumbAlpha=MaxScroll>0?112:0,thumb=new{x=thumb.X,y=thumb.Y,width=thumb.Width,height=thumb.Height},wrappedLines=lines.Count};}
    internal void ScrollLines(int count){ScrollTo(scrollY+count*LineHeight);}
    internal void ScrollWheel(int delta){wheelRemainder+=delta;int notches=wheelRemainder/120;wheelRemainder%=120;if(notches!=0){int n=SystemInformation.MouseWheelScrollLines;ScrollTo(scrollY-notches*(n<0?viewport.Height:Math.Max(1,n)*LineHeight));}}
    internal int TestHitAt(int x,int y){return Native.SendMessage(Handle,0x0084,IntPtr.Zero,new IntPtr(((Top+y)&0xffff)<<16|((Left+x)&0xffff))).ToInt32();}
    internal void TestCloseClick(){Native.SendMessage(Handle,0x0201,new IntPtr(1),new IntPtr((Px(18)<<16)|(Width-Px(46))));}
    internal void TestLockClick(){Native.SendMessage(Handle,0x0201,new IntPtr(1),new IntPtr((Px(18)<<16)|(Width-Px(18))));}
    internal void TestResizeRedraw(bool enabled){SetStyle(ControlStyles.ResizeRedraw,enabled);}
    internal void TestDpi(float next){testScale=next;RefreshDpi();Present();}
    internal void TestScrollbar(int x,int y,int endY){OnMouseDown(new MouseEventArgs(MouseButtons.Left,1,x,y,0));OnMouseMove(new MouseEventArgs(MouseButtons.Left,0,x,endY,0));OnMouseUp(new MouseEventArgs(MouseButtons.Left,1,x,endY,0));}
    sealed class TestBackdrop : Form {protected override bool ShowWithoutActivation {get{return true;}}}
    internal void ShowTestBackdrop(){if(testBackdrop==null){testBackdrop=new TestBackdrop{FormBorderStyle=FormBorderStyle.None,ShowInTaskbar=false,TopMost=true,BackColor=Color.FromArgb(40,40,40),StartPosition=FormStartPosition.Manual,Bounds=new Rectangle(Left-4,Top-4,1000,900)};testBackdrop.Show();Native.KeepOnTop(Handle);}}
    internal object CaptureProgress(string path,bool screen){
      if(screen&&testBackdrop==null)throw new InvalidOperationException("Screen capture requires a synthetic backdrop");
      using(var bitmap=DrawSurface()){if(screen)using(var g=Graphics.FromImage(bitmap)){g.CompositingMode=CompositingMode.SourceCopy;g.CopyFromScreen(Left,Top,0,0,new Size(Width,Height));}int stray=0;for(int y=Px(8);y<Math.Min(Px(34),Height);y++)for(int x=Px(12);x<Width-Px(55);x++){Color c=bitmap.GetPixel(x,y);if(c.B-c.R>65&&c.B-c.G>20)stray++;}bitmap.Save(path,ImageFormat.Png);return new {strayHeaderPixels=stray,width=Width,height=Height};}
    }
    protected override void Dispose(bool disposing){if(disposing){if(testBackdrop!=null)testBackdrop.Dispose();if(bodyFont!=null){bodyFont.Dispose();headingFont.Dispose();titleFont.Dispose();footerFont.Dispose();}}base.Dispose(disposing);}
  }


  // 审计窗：读服务器写的 audit-live.tsv，展示每一步操作、原因和截图缩略图。
  // 它跟随思考窗（默认贴在左侧），不进任务栏、不抢焦点；锁定后点击穿透，并且始终从截屏里排除。
  internal sealed class AuditFrame : Form {
    internal sealed class Row {
      internal string at="",action="",app="",detail="",reason="",shot="";
      internal bool ok=true;
    }
    sealed class Block {
      internal Row row;
      internal string[] reason=new string[0];
      internal Bitmap thumb;
      internal int thumbW,thumbH,height;
      internal float textWidth,lineH;
    }
    static readonly Color Warn=Color.FromArgb(255,235,104,90);
    readonly List<Row> rows=new List<Row>();
    readonly List<Block> blocks=new List<Block>();
    readonly Dictionary<string,Bitmap> thumbCache=new Dictionary<string,Bitmap>(StringComparer.OrdinalIgnoreCase);
    readonly List<string> thumbOrder=new List<string>();
    Font bodyFont,bodyBold,titleFont,timeFont;
    internal string FontDescription="Microsoft YaHei UI 13/12.5";
    Color styleBackground=Color.FromArgb(153,25,29,38);
    Color styleBorder=Color.FromArgb(255,117,161,218);
    Color styleText=Color.FromArgb(255,246,247,250);
    Color styleMuted=Color.FromArgb(255,185,198,216);
    Color styleAccent=Color.FromArgb(255,91,143,239);
    Color styleReason=Color.FromArgb(255,185,198,216);
    Color styleShot=Color.FromArgb(255,91,143,239);
    string styleFontFamily="";
    float styleTitlePixels=13f,styleBodyPixels=12.5f;
    internal double WindowOpacity=.88;
    internal bool Locked=true;
    internal bool CaptureExcluded;
    int maxRows=12;
    bool showTime=true,showReason=true,showThumb=false;
    string position="left-of-thought";
    string dataPath="";
    int gap=6,customX,customY;
    bool hasCustom;
    long dataStamp=-1;
    bool dataExists;
    DateTime nextPoll=DateTime.MinValue;
    bool presenting;
    float scale=1;
    Form anchor;

    internal int MaxRows{get{return maxRows;}}
    internal int LineCount{get{return rows.Count;}}
    internal string DataPath{get{return dataPath;}}

    internal AuditFrame() {
      AutoScaleMode=AutoScaleMode.None;
      FormBorderStyle=FormBorderStyle.None;
      ShowInTaskbar=false;
      TopMost=true;
      StartPosition=FormStartPosition.Manual;
      MinimumSize=new Size(200,120);
      MaximumSize=new Size(1600,1600);
      SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.ResizeRedraw,true);
      SetFonts();
      Width=420;
      Height=340;
    }
    protected override bool ShowWithoutActivation{get{return true;}}
    protected override CreateParams CreateParams {
      get {
        CreateParams cp=base.CreateParams;
        cp.ExStyle|=0x80000|0x80|0x08000000;
        if(Locked)cp.ExStyle|=0x20;
        return cp;
      }
    }
    protected override void OnHandleCreated(EventArgs e) {
      base.OnHandleCreated(e);
      RefreshDpi();
      SetCaptureExcluded();
    }
    protected override void OnShown(EventArgs e) {
      base.OnShown(e);
      SetCaptureExcluded();
      Present();
    }
    protected override void OnPaint(PaintEventArgs e) { Present(); }
    protected override void OnResize(EventArgs e) { base.OnResize(e); if(IsHandleCreated)Present(); }
    protected override void WndProc(ref Message m) {
      if(m.Msg==0x02e0){base.WndProc(ref m);RefreshDpi();Present();return;}
      base.WndProc(ref m);
    }
    protected override void Dispose(bool disposing) {
      if(disposing){
        DisposeFonts();
        foreach(var key in thumbOrder){Bitmap image;if(thumbCache.TryGetValue(key,out image)&&image!=null)image.Dispose();}
        thumbCache.Clear();thumbOrder.Clear();
      }
      base.Dispose(disposing);
    }
    void DisposeFonts() {
      if(bodyFont!=null)bodyFont.Dispose();if(bodyBold!=null)bodyBold.Dispose();
      if(titleFont!=null)titleFont.Dispose();if(timeFont!=null)timeFont.Dispose();
      bodyFont=null;bodyBold=null;titleFont=null;timeFont=null;
    }
    void SetFonts() {
      DisposeFonts();
      string resolved="Microsoft YaHei UI";
      // 字号是 96-DPI 像素，再乘窗口 DPI 缩放；家族按 OverlayStyle 的回退链解析。
      bodyFont=OverlayStyle.Create(styleFontFamily,styleBodyPixels*scale,FontStyle.Regular,out resolved);
      bodyBold=OverlayStyle.Create(styleFontFamily,styleBodyPixels*scale,FontStyle.Bold,out resolved);
      titleFont=OverlayStyle.Create(styleFontFamily,styleTitlePixels*scale,FontStyle.Bold,out resolved);
      timeFont=OverlayStyle.Create(styleFontFamily,Math.Max(8f,styleBodyPixels*scale*.88f),FontStyle.Regular,out resolved);
      FontDescription=resolved+" "+FormatSize(styleTitlePixels)+"/"+FormatSize(styleBodyPixels);
    }
    void RefreshDpi() {
      if(!IsHandleCreated)return;
      float next=Native.GetDpiForWindow(Handle)/96f;
      next=Math.Max(1f,Math.Min(4f,next));
      if(Math.Abs(next-scale)>.01f){scale=next;SetFonts();Present();}
    }
    void SetCaptureExcluded() {
      if(!IsHandleCreated)return;
      CaptureExcluded=Native.ApplyDisplayAffinity(this,false);
    }
    void ApplyLock(bool locked) {
      Locked=locked;
      if(IsHandleCreated){
        int style=Native.GetWindowLong(Handle,-20);
        Native.SetWindowLong(Handle,-20,locked?style|0x20:style&~0x20);
        Native.SetWindowPos(Handle,IntPtr.Zero,0,0,0,0,0x37);
      }
    }
    internal void Configure(Dictionary<string,object> settings) {
      int width=ClampInt(NumberValue(settings,"auditOverlayWidth",420),200,1600);
      int height=ClampInt(NumberValue(settings,"auditOverlayHeight",340),120,1600);
      double opacity=NumberDouble(settings,"auditOverlayOpacity",88);
      WindowOpacity=Math.Max(.2,Math.Min(1,opacity/100.0));
      bool locked=BoolValue(settings,"auditOverlayLocked",true);
      string nextPosition=TextValue(settings,"auditOverlayPosition");
      if(nextPosition=="")nextPosition="left-of-thought";
      int nextGap=ClampInt(NumberValue(settings,"auditOverlayGap",6),0,80);
      int nextRows=ClampInt(NumberValue(settings,"auditOverlayRows",12),1,40);
      bool nextShowTime=BoolValue(settings,"auditOverlayShowTime",true);
      bool nextShowReason=BoolValue(settings,"auditOverlayShowReason",true);
      bool nextShowThumb=BoolValue(settings,"auditOverlayShowThumb",false);
      float nextTitle=ClampFloat(NumberDouble(settings,"auditOverlayTitleSize",13),9,28);
      float nextBody=ClampFloat(NumberDouble(settings,"auditOverlayBodySize",12.5),8,24);
      string family=TextValue(settings,"auditOverlayFontFamily");
      Color nextBackground=OverlayStyle.Color(TextValue(settings,"auditOverlayBg"),styleBackground);
      Color nextBorder=OverlayStyle.Color(TextValue(settings,"auditOverlayBorder"),styleBorder);
      Color nextText=OverlayStyle.Color(TextValue(settings,"auditOverlayText"),styleText);
      Color nextMuted=OverlayStyle.Color(TextValue(settings,"auditOverlayMuted"),styleMuted);
      Color nextAccent=OverlayStyle.Color(TextValue(settings,"auditOverlayAccent"),styleAccent);
      Color nextReason=OverlayStyle.Color(TextValue(settings,"auditOverlayReason"),styleReason);
      Color nextShot=OverlayStyle.Color(TextValue(settings,"auditOverlayShot"),styleShot);
      double rawX,rawY;
      bool hasX=TryNumber(settings,"auditOverlayX",out rawX);
      bool hasY=TryNumber(settings,"auditOverlayY",out rawY);
      hasCustom=hasX&&hasY;
      if(hasCustom){customX=(int)Math.Round(rawX);customY=(int)Math.Round(rawY);}
      bool fontsChanged=family!=styleFontFamily||Math.Abs(nextTitle-styleTitlePixels)>.01f||Math.Abs(nextBody-styleBodyPixels)>.01f;
      styleFontFamily=family;styleTitlePixels=nextTitle;styleBodyPixels=nextBody;
      styleBackground=nextBackground;styleBorder=nextBorder;styleText=nextText;styleMuted=nextMuted;
      styleAccent=nextAccent;styleReason=nextReason;styleShot=nextShot;
      if(nextRows!=maxRows)dataStamp=-1;
      maxRows=nextRows;showTime=nextShowTime;showReason=nextShowReason;showThumb=nextShowThumb;
      position=nextPosition;gap=nextGap;
      string nextData=TextValue(settings,"auditOverlayData");
      if(nextData!=dataPath){ClearThumbs();dataPath=nextData;dataStamp=-1;dataExists=false;}
      if(fontsChanged)SetFonts();
      ApplyLock(locked);
      if(Width!=width)Width=width;
      if(Height!=height)Height=height;
      Place(anchor);
      if(IsHandleCreated)Present();
      Poll();
    }
    internal void Follow(Form thought) {
      if(thought==null||thought.IsDisposed)return;
      anchor=thought;
      Place(thought);
    }
    void Place(Form thought) {
      int x=Left,y=Top;
      Rectangle area;
      if(position=="custom"&&hasCustom){
        area=Screen.FromPoint(new Point(customX,customY)).WorkingArea;
        x=ClampInt(customX,area.Left,Math.Max(area.Left,area.Right-Width));
        y=ClampInt(customY,area.Top,Math.Max(area.Top,area.Bottom-Height));
      }else if(position=="left-of-thought"){
        if(thought==null||thought.IsDisposed)return;
        x=thought.Left-Width-gap;y=thought.Top;
      }else{
        bool useThought=thought!=null&&!thought.IsDisposed;
        area=useThought?Screen.FromRectangle(thought.Bounds).WorkingArea:Screen.PrimaryScreen.WorkingArea;
        bool right=position=="top-right"||position=="bottom-right";
        bool bottom=position=="bottom-left"||position=="bottom-right";
        x=right?area.Right-Width-16:area.Left+16;
        y=bottom?area.Bottom-Height-16:area.Top+16;
        x=ClampInt(x,area.Left,Math.Max(area.Left,area.Right-Width));
        y=ClampInt(y,area.Top,Math.Max(area.Top,area.Bottom-Height));
      }
      var next=new Rectangle(x,y,Width,Height);
      if(Bounds!=next){Bounds=next;if(IsHandleCreated)Present();}
    }
    internal void Poll(bool force=false) {
      if(!IsHandleCreated)return;
      if(!force&&DateTime.UtcNow<nextPoll)return;
      nextPoll=DateTime.UtcNow.AddMilliseconds(500);
      if(String.IsNullOrEmpty(dataPath)){
        if(rows.Count>0){rows.Clear();ClearBlocks();Present();}
        return;
      }
      bool exists=false;long stamp=-1;
      try{if(File.Exists(dataPath)){exists=true;stamp=File.GetLastWriteTimeUtc(dataPath).Ticks;}}catch(Exception){}
      if(!exists){
        if(rows.Count>0){rows.Clear();ClearBlocks();Present();}
        dataExists=false;dataStamp=-1;
        return;
      }
      if(!force&&exists==dataExists&&stamp==dataStamp)return;
      try {
        string[] raw=File.ReadAllLines(dataPath,Encoding.UTF8);
        var parsed=new List<Row>();
        for(int i=0;i<raw.Length;i++){
          string line=raw[i];
          if(String.IsNullOrWhiteSpace(line))continue;
          string[] cells=line.Split('\t');
          var row=new Row();
          row.at=Cell(cells,0);row.ok=Cell(cells,1)!="0";row.action=Cell(cells,2);
          row.app=Cell(cells,3);row.detail=Cell(cells,4);row.reason=Cell(cells,5);row.shot=Cell(cells,6);
          if(row.action==""&&row.detail=="")continue;
          parsed.Add(row);
        }
        if(parsed.Count>maxRows)parsed=parsed.GetRange(parsed.Count-maxRows,maxRows);
        rows.Clear();rows.AddRange(parsed);
        dataExists=true;dataStamp=stamp;
        ClearBlocks();Present();
      }catch(Exception){dataStamp=-1;}
    }
    void ClearBlocks(){
      blocks.Clear();
      // 只在没有绘制引用时回收缩略图缓存，避免当前帧的 Block 指向已释放的 Bitmap。
      while(thumbOrder.Count>64){
        string oldest=thumbOrder[0];thumbOrder.RemoveAt(0);
        Bitmap image;if(thumbCache.TryGetValue(oldest,out image)){thumbCache.Remove(oldest);if(image!=null)image.Dispose();}
      }
    }
    void ClearThumbs() {
      foreach(var key in thumbOrder){Bitmap image;if(thumbCache.TryGetValue(key,out image)&&image!=null)image.Dispose();}
      thumbCache.Clear();thumbOrder.Clear();
    }
    Bitmap DrawSurface() {
      var image=new Bitmap(Math.Max(1,Width),Math.Max(1,Height),PixelFormat.Format32bppPArgb);
      using(var g=Graphics.FromImage(image)){
        g.Clear(Color.Transparent);
        g.SmoothingMode=SmoothingMode.AntiAlias;
        g.TextRenderingHint=TextRenderingHint.AntiAliasGridFit;
        using(var shape=Frame.Rounded(new RectangleF(.5f,.5f,Width-1,Height-1),8f))
        using(var background=new SolidBrush(styleBackground))
        using(var border=new Pen(styleBorder,1)){g.FillPath(background,shape);g.DrawPath(border,shape);}
        float pad=10f;
        float titleTop=9f;
        float titleLine=Math.Max(22f,(float)Math.Ceiling(titleFont.GetHeight()*1.1));
        using(var fg=new SolidBrush(styleText))
        using(var muted=new SolidBrush(styleMuted))
        using(var far=MakeFarFormat()){
          g.DrawString("DSH 本地审计",titleFont,fg,new PointF(pad,titleTop));
          string count=rows.Count+" 条";
          g.DrawString(count,timeFont,muted,new RectangleF(Width-pad-100f,titleTop+2f,100f,titleLine),far);
          float separator=titleTop+titleLine+3f;
          using(var pen=new Pen(OverlayStyle.WithAlpha(styleBorder,140),1f))g.DrawLine(pen,pad,separator,Width-pad,separator);
          float top=separator+6f;
          float bottom=Height-8f;
          float available=Math.Max(10f,bottom-top);
          if(rows.Count==0){
            using(var center=MakeCenterFormat())g.DrawString("暂无操作记录",bodyFont,muted,new RectangleF(pad,top,Width-2*pad,available),center);
          }else{
            blocks.Clear();
            float used=0f;
            float contentWidth=Width-2*pad;
            for(int i=rows.Count-1;i>=0&&blocks.Count<maxRows;i--){
              Block block=BuildBlock(g,rows[i],contentWidth);
              if(block==null)continue;
              if(used+block.height>available){
                if(blocks.Count==0){
                  block.height=(int)Math.Floor(available);
                  if(block.height>8){blocks.Insert(0,block);used+=block.height;}
                }
                break;
              }
              used+=block.height;
              blocks.Insert(0,block);
            }
            float y=bottom-used;
            for(int i=0;i<blocks.Count;i++){DrawBlock(g,blocks[i],pad,y,contentWidth);y+=blocks[i].height;}
            if(blocks.Count==0)using(var center=MakeCenterFormat())g.DrawString("暂无操作记录",bodyFont,muted,new RectangleF(pad,top,contentWidth,available),center);
          }
        }
      }
      return image;
    }
    Block BuildBlock(Graphics g,Row row,float contentWidth) {
      var block=new Block();
      block.row=row;
      float line=Math.Max(13f,(float)Math.Ceiling(bodyFont.GetHeight()*1.05));
      block.lineH=line;
      int thumbWidth=0,thumbHeight=0;
      Bitmap thumb=LoadThumb(row.shot,Math.Max(24,(int)Math.Min(72f,contentWidth*.35f)),44,out thumbWidth,out thumbHeight);
      block.thumb=thumb;block.thumbW=thumbWidth;block.thumbH=thumbHeight;
      float textWidth=contentWidth-(thumb!=null?thumbWidth+8f:0f);
      block.textWidth=Math.Max(60f,textWidth);
      block.reason=showReason?Wrap(g,row.reason,bodyFont,Math.Max(30f,block.textWidth-16f),2):new string[0];
      float height=line+block.reason.Length*line+6f;
      if(thumbHeight+4f>height)height=thumbHeight+4f;
      block.height=Math.Max(1,(int)Math.Ceiling(height));
      return block;
    }
    void DrawBlock(Graphics g,Block block,float x,float y,float width) {
      Row row=block.row;
      float line=block.lineH;
      float textWidth=block.textWidth;
      using(var dot=new SolidBrush(row.ok?styleAccent:Warn))g.FillEllipse(dot,x+3f,y+line*.42f,5f,5f);
      float tx=x+14f;
      using(var fg=new SolidBrush(OverlayStyle.WithAlpha(styleText,238)))
      using(var muted=new SolidBrush(OverlayStyle.WithAlpha(styleMuted,215)))
      using(var gold=new SolidBrush(styleReason))
      using(var warn=new SolidBrush(Warn))
      using(var far=MakeFarFormat()){
        float appWidth=0f;
        if(!String.IsNullOrEmpty(row.app))appWidth=Math.Min(textWidth*.42f,g.MeasureString(row.app,timeFont).Width+4f);
        float budget=Math.Max(24f,textWidth-(tx-x)-appWidth-4f);
        float timeWidth=0f;
        if(showTime&&!String.IsNullOrEmpty(row.at)){
          float measured=g.MeasureString(row.at+"  ",timeFont).Width;
          if(measured<budget*.55f){timeWidth=measured;g.DrawString(row.at,timeFont,muted,new PointF(tx,y+1f));}
        }
        float actionX=tx+timeWidth;
        string action=Fit(g,String.IsNullOrEmpty(row.action)?"操作":row.action,bodyBold,Math.Max(24f,budget-timeWidth));
        g.DrawString(action,bodyBold,fg,new PointF(actionX,y));
        float used=timeWidth+g.MeasureString(action,bodyBold).Width+6f;
        if(!String.IsNullOrEmpty(row.detail)){
          float room=budget-used;
          if(room>16f){
            string detail=Fit(g,row.detail,bodyFont,room);
            g.DrawString(detail,bodyFont,muted,new PointF(tx+used,y+(line-bodyFont.GetHeight())*.5f));
          }
        }
        float appRight=x+textWidth;
        if(!String.IsNullOrEmpty(row.app))g.DrawString(Fit(g,row.app,timeFont,appWidth),timeFont,muted,new RectangleF(appRight-appWidth,y+1f,appWidth,line),far);
        float reasonY=y+line;
        for(int i=0;i<block.reason.Length;i++){
          g.DrawString((i==0?"· ":"  ")+block.reason[i],bodyFont,row.ok?gold:warn,new PointF(tx,reasonY));
          reasonY+=line;
        }
        if(block.thumb!=null){
          var rect=new RectangleF(x+width-block.thumbW,y+1f,block.thumbW,block.thumbH);
          g.DrawImage(block.thumb,rect);
          using(var edge=new Pen(OverlayStyle.WithAlpha(styleShot,120),1f))g.DrawRectangle(edge,rect.X,rect.Y,rect.Width,rect.Height);
        }
      }
      using(var separator=new Pen(OverlayStyle.WithAlpha(styleBorder,80),1f)){
        float sy=y+block.height-1f;
        g.DrawLine(separator,x,sy,x+width,sy);
      }
    }
    Bitmap LoadThumb(string shot,int maxWidth,int maxHeight,out int thumbWidth,out int thumbHeight) {
      thumbWidth=0;thumbHeight=0;
      if(!showThumb||String.IsNullOrEmpty(shot)||String.IsNullOrEmpty(dataPath))return null;
      string path=shot;
      if(!Path.IsPathRooted(path)){
        string directory=Path.GetDirectoryName(dataPath);
        if(String.IsNullOrEmpty(directory))return null;
        path=Path.Combine(directory,path);
      }
      Bitmap cached;
      if(thumbCache.TryGetValue(path,out cached)){
        if(cached!=null&&cached.Width>0){thumbWidth=cached.Width;thumbHeight=cached.Height;return cached;}
        return null;
      }
      try {
        if(!File.Exists(path))return null;
        using(var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite))
        using(var source=Image.FromStream(stream)){
          if(source.Width<1||source.Height<1)return null;
          float scale=Math.Min((float)maxWidth/source.Width,(float)maxHeight/source.Height);
          if(scale>1f)scale=1f;
          int width=Math.Max(1,(int)Math.Round(source.Width*scale));
          int height=Math.Max(1,(int)Math.Round(source.Height*scale));
          var copy=new Bitmap(width,height,PixelFormat.Format32bppPArgb);
          using(var graphics=Graphics.FromImage(copy)){
            graphics.InterpolationMode=InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode=PixelOffsetMode.HighQuality;
            graphics.DrawImage(source,0,0,width,height);
          }
          thumbCache[path]=copy;thumbOrder.Add(path);
          thumbWidth=width;thumbHeight=height;
          return copy;
        }
      }catch(Exception){return null;}
    }
    void Present() {
      if(presenting||!IsHandleCreated||IsDisposed||Width<1||Height<1)return;
      presenting=true;
      try{
        using(var image=DrawSurface()){
          IntPtr dc=Native.CreateCompatibleDC(IntPtr.Zero),bitmap=image.GetHbitmap(Color.FromArgb(0)),previous=Native.SelectObject(dc,bitmap);
          try{
            var dest=new Native.Point(Left,Top);
            var origin=new Native.Point(0,0);
            var size=new Native.Size(Width,Height);
            var blend=new Native.Blend{op=0,flags=0,alpha=(byte)Math.Max(0,Math.Min(255,Math.Round(WindowOpacity*255))),format=1};
            if(!Native.UpdateLayeredWindow(Handle,IntPtr.Zero,ref dest,ref size,dc,ref origin,0,ref blend,2))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Could not present audit overlay");
          }finally{Native.SelectObject(dc,previous);Native.DeleteObject(bitmap);Native.DeleteDC(dc);}
        }
      }finally{presenting=false;}
    }
    static StringFormat MakeFarFormat() {
      var format=(StringFormat)StringFormat.GenericTypographic.Clone();
      format.FormatFlags|=StringFormatFlags.NoWrap|StringFormatFlags.MeasureTrailingSpaces;
      format.Trimming=StringTrimming.EllipsisCharacter;
      format.Alignment=StringAlignment.Far;
      format.LineAlignment=StringAlignment.Near;
      return format;
    }
    static StringFormat MakeCenterFormat() {
      var format=(StringFormat)StringFormat.GenericTypographic.Clone();
      format.Alignment=StringAlignment.Center;
      format.LineAlignment=StringAlignment.Center;
      return format;
    }
    static string Fit(Graphics g,string text,Font font,float width) {
      if(String.IsNullOrEmpty(text))return "";
      if(width<4f)return "…";
      if(g.MeasureString(text,font).Width<=width)return text;
      int length=text.Length;
      while(length>1&&g.MeasureString(text.Substring(0,length)+"…",font).Width>width)length--;
      return text.Substring(0,length)+"…";
    }
    static string[] Wrap(Graphics g,string text,Font font,float width,int maxLines) {
      var result=new List<string>();
      if(String.IsNullOrEmpty(text)||maxLines<1||width<=8f)return result.ToArray();
      int start=0;
      while(start<text.Length&&result.Count<maxLines){
        string rest=text.Substring(start);
        if(g.MeasureString(rest,font).Width<=width){result.Add(rest);break;}
        int low=1,high=rest.Length;
        while(low<high){
          int middle=(low+high+1)/2;
          if(g.MeasureString(rest.Substring(0,middle),font).Width<=width)low=middle;else high=middle-1;
        }
        int take=Math.Max(1,low);
        if(result.Count==maxLines-1){result.Add(Fit(g,rest,font,width));break;}
        result.Add(rest.Substring(0,take));
        start+=take;
      }
      return result.ToArray();
    }
    static string Cell(string[] cells,int index) { return index>=0&&index<cells.Length?cells[index].Trim():""; }
    static string TextValue(Dictionary<string,object> data,string key) {
      object value;
      if(data==null||!data.TryGetValue(key,out value)||value==null)return "";
      string text=Convert.ToString(value);
      return text.Length>1200?text.Substring(text.Length-1200):text;
    }
    static bool BoolValue(Dictionary<string,object> data,string key,bool fallback) {
      if(data==null)return fallback;
      object value;
      if(!data.TryGetValue(key,out value)||value==null)return fallback;
      if(value is bool)return (bool)value;
      try{return Convert.ToBoolean(value);}catch(Exception){return fallback;}
    }
    static bool TryNumber(Dictionary<string,object> data,string key,out double value) {
      value=0;
      if(data==null)return false;
      object raw;
      if(!data.TryGetValue(key,out raw)||raw==null)return false;
      try{value=Convert.ToDouble(raw,System.Globalization.CultureInfo.InvariantCulture);return true;}catch(Exception){return false;}
    }
    static int NumberValue(Dictionary<string,object> data,string key,int fallback) {
      double value;
      return TryNumber(data,key,out value)?(int)Math.Round(value):fallback;
    }
    static double NumberDouble(Dictionary<string,object> data,string key,double fallback) {
      double value;
      return TryNumber(data,key,out value)?value:fallback;
    }
    static int ClampInt(int value,int min,int max) { return Math.Max(min,Math.Min(max,value)); }
    static float ClampFloat(double value,float min,float max) { return (float)Math.Max(min,Math.Min(max,value)); }
    static string FormatSize(float pixels) { return pixels.ToString("0.###",System.Globalization.CultureInfo.InvariantCulture); }
  }
  // Companion overlay: one compact card pinned left of the thinking (progress)
  // window, stacking each live sub-agent's latest action. Owned by the
  // Controller beside AuditFrame. Pure view: never injects input, never moves
  // the real pointer, never takes focus. Visibility follows
  // settings.companionOverlayEnabled, which overlay.ts derives from
  // companion-live.json (schema 1). A failed read keeps the previous frame.
  internal sealed class CompanionRow {
    internal int Ordinal;
    internal string AgentId="";
    internal string Label="";
    internal string State="idle";
    internal string Action="";
    internal string App="";
    internal string Reason="";
    internal bool Ok;
  }
  internal sealed class CompanionView {
    internal bool Enabled;
    internal long Epoch;
    internal string RootId="";
    internal string Task="";
    internal string BannerText="";
    internal bool ThinkingVisible;
    internal string ThinkingStatus="idle";
    internal string ThinkingAction="";
    internal string ThinkingReasoning="";
    internal readonly List<CompanionRow> Rows=new List<CompanionRow>();
  }
  // Pure JSON -> view contract (unit-testable without a window). Uses CommandJson
  // so the Core (System.Text.Json) and Windows PowerShell (JavaScriptSerializer)
  // builds agree on the shape produced by plugin/lib/multi-mouse-runtime.mjs.
  internal static class CompanionParse {
    internal static CompanionView Parse(string raw){
      if(String.IsNullOrWhiteSpace(raw))return new CompanionView();
      Dictionary<string,object> data;
      try{data=new CommandJson().Deserialize<Dictionary<string,object>>(raw);}
      catch(Exception){return new CompanionView();}
      return Parse(data);
    }
    static CompanionView Parse(Dictionary<string,object> data){
      var view=new CompanionView();
      if(data==null)return view;
      view.Enabled=Flag(data,"enabled");
      view.Epoch=NumL(data,"epoch");
      view.RootId=Str(data,"rootId");
      view.Task=Str(data,"task");
      var banner=Sub(data,"banner");
      if(banner!=null)view.BannerText=Str(banner,"text");
      var thinking=Sub(data,"thinking");
      if(thinking!=null){
        view.ThinkingVisible=Flag(thinking,"visible");
        view.ThinkingStatus=Str(thinking,"status");if(view.ThinkingStatus=="")view.ThinkingStatus="idle";
        view.ThinkingAction=Str(thinking,"action");
        view.ThinkingReasoning=Str(thinking,"reasoning");
      }
      var rows=new List<CompanionRow>();
      object rawRows;
      // Runtime emits rows as a JSON array; accept any IList so the Core
      // (object[]) and Windows PowerShell (JavaScriptSerializer) builds agree.
      var rowList=(data.TryGetValue("rows",out rawRows)?rawRows as System.Collections.IList:null);
      if(rowList!=null){
        foreach(var entry in rowList){
          var row=entry as Dictionary<string,object>;if(row==null)continue;
          var r=new CompanionRow();
          r.Ordinal=(int)NumL(row,"ordinal");
          r.AgentId=Str(row,"agentId");
          r.Label=Str(row,"label");
          r.State=Str(row,"state");if(r.State=="")r.State="idle";
          var last=Sub(row,"last");
          if(last!=null){
            r.Ok=Flag(last,"ok");
            r.App=Str(last,"app");
            r.Reason=Str(last,"reason");
            string kind=Str(last,"kind"),label=Str(last,"label");
            r.Action=label!=""?label:kind;
          }
          rows.Add(r);
        }
      }
      // No logical row cap: every live sub-agent keeps its own row so a ten-
      // person fleet is fully represented (A10). Overflow is handled at draw
      // time by shrinking line height, never by dropping agents.
      rows.Sort(delegate(CompanionRow a,CompanionRow b){return a.Ordinal.CompareTo(b.Ordinal);});
      view.Rows.AddRange(rows);
      return view;
    }
    static Dictionary<string,object> Sub(Dictionary<string,object> data,string key){object value;return data.TryGetValue(key,out value)?value as Dictionary<string,object>:null;}
    static string Str(Dictionary<string,object> data,string key){object value;if(!data.TryGetValue(key,out value)||value==null)return "";string text=Convert.ToString(value,System.Globalization.CultureInfo.InvariantCulture);if(text==null)return "";return text.Length>1200?text.Substring(text.Length-1200):text;}
    static bool Flag(Dictionary<string,object> data,string key){object value;if(!data.TryGetValue(key,out value)||value==null)return false;if(value is bool)return (bool)value;string text=Convert.ToString(value,System.Globalization.CultureInfo.InvariantCulture);return String.Equals(text,"true",StringComparison.OrdinalIgnoreCase)||text=="1";}
    static long NumL(Dictionary<string,object> data,string key){object value;if(!data.TryGetValue(key,out value)||value==null)return 0;try{return Convert.ToInt64(value,System.Globalization.CultureInfo.InvariantCulture);}catch(Exception){double d;return Double.TryParse(Convert.ToString(value,System.Globalization.CultureInfo.InvariantCulture),System.Globalization.NumberStyles.Any,System.Globalization.CultureInfo.InvariantCulture,out d)?(long)Math.Round(d):0;}}
  }

  // One text line inside a single companion card.
  internal sealed class CompanionLine {
    internal string Text="";
    internal int Kind;
    internal bool Acting;
  }

  // One rounded card, owned by exactly one sub-agent (never the root).
  internal sealed class CompanionCard {
    internal int Ordinal;
    internal string AgentId="";
    internal bool Acting;
    internal readonly List<CompanionLine> Lines=new List<CompanionLine>();
    internal Rectangle Bounds;
  }

  // Pure layout for the companion stack. No window, no Graphics and no timer,
  // so a fixture can assert every geometric rule without creating a form.
  // Only sub-agents are boxed: the shared banner and the root's thinking line
  // are a plain caption on the transparent host, so the root never gets a card.
  internal sealed class CompanionLayout {
    internal readonly List<CompanionLine> Caption=new List<CompanionLine>();
    internal readonly List<CompanionCard> Cards=new List<CompanionCard>();
    internal int Width,Height,LineHeight,Gap,Padding,Radius,Outer,CaptionHeight;
    // True only when even the minimum readable line height cannot fit the
    // working area, so the last cards fall outside the host window.
    internal bool Clipped;
    internal bool HasContent{get{return Cards.Count>0||Caption.Count>0;}}
    internal static int Px(float n,float scale){
      if(scale<=0f||float.IsNaN(scale)||float.IsInfinity(scale))scale=1f;
      return (int)Math.Round(n*scale);
    }
    internal static CompanionLayout Empty(float scale){
      var layout=new CompanionLayout();
      layout.Gap=Px(4f,scale);layout.Padding=Px(6f,scale);layout.Radius=Px(8f,scale);layout.Outer=Px(2f,scale);
      layout.LineHeight=Px(12f,scale);layout.Width=Px(300f,scale);layout.Height=Px(52f,scale);
      return layout;
    }
    internal static CompanionLayout Build(CompanionView view,float scale,int availableHeight){
      return Build(view,scale,availableHeight,true);
    }
    internal static CompanionLayout Build(CompanionView view,float scale,int availableHeight,bool includeDetail){
      var layout=Empty(scale);
      if(view==null)return layout;
      if(!(view.Enabled||view.Rows.Count>0))return layout;
      layout.Caption.AddRange(CaptionFor(view));
      layout.Cards.AddRange(CardsFor(view,includeDetail));
      int minLh=Px(11f,scale),maxLh=Px(19f,scale);
      if(maxLh<minLh)maxLh=minLh;
      int pad=layout.Padding,gap=layout.Gap,outer=layout.Outer;
      int budget=availableHeight-2*outer;
      if(budget<minLh)budget=minLh;
      int lh=FitLineHeight(layout.Caption,layout.Cards,budget,pad,gap,minLh,maxLh);
      // The detail line is the only thing allowed to go when the stack is too
      // tall: every sub-agent keeps its primary card no matter the count.
      if(includeDetail&&StackHeight(layout,lh)>budget){
        layout.Cards.Clear();
        layout.Cards.AddRange(CardsFor(view,false));
        lh=FitLineHeight(layout.Caption,layout.Cards,budget,pad,gap,minLh,maxLh);
      }
      layout.LineHeight=lh;
      layout.CaptionHeight=layout.Caption.Count*lh;
      layout.Height=StackHeight(layout,lh)+2*outer;
      if(availableHeight>0&&layout.Height>availableHeight){layout.Height=availableHeight;layout.Clipped=true;}
      if(layout.Height<Px(24f,scale))layout.Height=Px(24f,scale);
      int y=outer+layout.CaptionHeight;
      if(layout.Caption.Count>0&&layout.Cards.Count>0)y+=gap;
      for(int i=0;i<layout.Cards.Count;i++){
        var card=layout.Cards[i];
        int h=2*pad+card.Lines.Count*lh;
        card.Bounds=new Rectangle(outer,y,Math.Max(1,layout.Width-2*outer),Math.Max(1,h));
        y+=h+gap;
      }
      return layout;
    }
    // Shared banner plus the root's thinking line. These are caption text on
    // the transparent host, never a box, so the root gets no audit frame.
    internal static List<CompanionLine> CaptionFor(CompanionView view){
      var caption=new List<CompanionLine>();
      if(view==null)return caption;
      string banner=view.BannerText!=""?view.BannerText:(view.Task!=""?"DSH正在完成"+view.Task:"DSH 子 Agent");
      caption.Add(new CompanionLine{Text=banner,Kind=0});
      if(view.BannerText!=""&&view.Task!="")caption.Add(new CompanionLine{Text=view.Task,Kind=1});
      if(view.ThinkingVisible&&view.ThinkingStatus=="acting"&&view.ThinkingAction!="")caption.Add(new CompanionLine{Text="主： "+view.ThinkingAction,Kind=1});
      return caption;
    }
    internal static List<CompanionCard> CardsFor(CompanionView view,bool includeDetail){
      var cards=new List<CompanionCard>();
      if(view==null)return cards;
      foreach(var row in view.Rows){
        // Defensive: the root is never a row, even if the writer slips one in.
        if(row.AgentId!=""&&row.AgentId==view.RootId)continue;
        string name=row.Label!=""?row.Label:row.AgentId;
        var card=new CompanionCard();
        card.Ordinal=row.Ordinal;
        card.AgentId=row.AgentId;
        card.Acting=row.State=="acting";
        card.Lines.Add(new CompanionLine{Text=(row.Ordinal>0?row.Ordinal+". ":"")+(name!=""?name:"子 Agent")+(card.Acting?"  · 执行中":"  · 空闲"),Kind=2,Acting=card.Acting});
        if(includeDetail){
          string detail=row.Action;
          if(row.Reason!="")detail+=(detail!=""?" — ":"")+row.Reason;
          if(row.App!="")detail="["+row.App+"] "+detail;
          if(detail!="")card.Lines.Add(new CompanionLine{Text=detail,Kind=3});
        }
        cards.Add(card);
      }
      return cards;
    }
    internal static int TotalHeight(List<CompanionCard> cards,int lineHeight,int pad,int gap){
      if(cards==null||cards.Count==0)return 0;
      int total=(cards.Count-1)*gap;
      foreach(var card in cards)total+=2*pad+card.Lines.Count*lineHeight;
      return total;
    }
    // Caption text plus every card and every gap (caption->first card included).
    internal static int StackHeight(CompanionLayout layout,int lineHeight){
      if(layout==null)return 0;
      return StackHeight(layout.Caption,layout.Cards,lineHeight,layout.Padding,layout.Gap);
    }
    internal static int StackHeight(List<CompanionLine> caption,List<CompanionCard> cards,int lineHeight,int pad,int gap){
      int captionLines=caption==null?0:caption.Count;
      int cardCount=cards==null?0:cards.Count;
      int total=captionLines*lineHeight+TotalHeight(cards,lineHeight,pad,gap);
      if(captionLines>0&&cardCount>0)total+=gap;
      return total;
    }
    static int FitLineHeight(List<CompanionLine> caption,List<CompanionCard> cards,int budget,int pad,int gap,int minLh,int maxLh){
      for(int lh=maxLh;lh>=minLh;lh--){
        if(StackHeight(caption,cards,lh,pad,gap)<=budget)return lh;
      }
      return minLh;
    }
  }

  internal sealed class CompanionFrame : Form {
    CompanionLayout layout=CompanionLayout.Empty(1f);
    CompanionView view=new CompanionView();
    string DataPath="";
    long dataStamp=-1;bool dataExists;DateTime nextPoll=DateTime.MinValue;
    int paints;bool presenting;
    internal bool CaptureExcluded;
    internal double WindowOpacity=1.0;
    Color styleBackground=Color.FromArgb(150,20,24,32),styleBorder=Color.FromArgb(140,117,161,218),styleText=Color.FromArgb(255,246,247,250),styleMuted=Color.FromArgb(235,185,198,216),styleAccent=Color.FromArgb(255,91,143,239);
    string styleFontFamily="";
    float styleTitlePixels=13f,styleBodyPixels=12.5f;
    Font titleFont,bodyFont,detailFont;
    float scale=1;
    Form anchor;
    int lineHeight;
    int Px(float n){return (int)Math.Round(n*scale);}

    internal CompanionFrame(){
      AutoScaleMode=AutoScaleMode.None;FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=true;StartPosition=FormStartPosition.Manual;
      // Keep the floor below any real stack (one card can be ~58px tall at
      // 100% DPI); a higher floor would fight Rebuild's own height every pass.
      MinimumSize=new Size(120,24);MaximumSize=new Size(1600,1600);
      SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.ResizeRedraw,true);
      SetFonts(1);Width=Px(300);Height=Px(64);
    }
    protected override bool ShowWithoutActivation{get{return true;}}
    // Display only: WS_EX_TRANSPARENT (0x20) keeps every card and every gap
    // click-through, so the audit frames never steal a click from the app
    // underneath nor block the user's emergency stop.
    protected override CreateParams CreateParams{get{var cp=base.CreateParams;cp.ExStyle|=0x80000|0x20|0x80|0x08000000;return cp;}}
    internal bool ClickThrough{get{return IsHandleCreated&&(Native.GetWindowLong(Handle,-20)&0x08080020)==0x08080020;}}
    void SetFonts(float next){
      if(next<1f)next=1f;if(next>4f)next=4f;
      DisposeFonts();scale=next;string resolved;
      titleFont=OverlayStyle.Create(styleFontFamily,styleTitlePixels*scale,FontStyle.Bold,out resolved);
      bodyFont=OverlayStyle.Create(styleFontFamily,styleBodyPixels*scale,FontStyle.Regular,out resolved);
      detailFont=OverlayStyle.Create(styleFontFamily,11f*scale,FontStyle.Regular,out resolved);
    }
    void DisposeFonts(){if(titleFont!=null){titleFont.Dispose();bodyFont.Dispose();detailFont.Dispose();titleFont=bodyFont=detailFont=null;}}
    void RefreshDpi(){float next=1f;try{next=Native.GetDpiForWindow(Handle)/96f;}catch(Exception){}SetFonts(next);}
    void SetCaptureExcluded(){CaptureExcluded=Native.ApplyDisplayAffinity(this,false);}
    protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);RefreshDpi();SetCaptureExcluded();}
    protected override void OnShown(EventArgs e){base.OnShown(e);SetCaptureExcluded();Present();}
    protected override void OnPaint(PaintEventArgs e){Present();}
    protected override void OnResize(EventArgs e){base.OnResize(e);Present();}
    protected override void WndProc(ref Message m){base.WndProc(ref m);if(m.Msg==0x02e0){RefreshDpi();Present();}}
    protected override void Dispose(bool disposing){if(disposing)DisposeFonts();base.Dispose(disposing);}

    internal void Configure(Dictionary<string,object> settings){
      if(settings==null)settings=new Dictionary<string,object>();
      string path=Str(settings,"companionOverlayData");
      if(path!=DataPath){DataPath=path;dataStamp=-1;dataExists=false;}
      WindowOpacity=Math.Max(.2,Math.Min(1,NumD(settings,"progressOverlayOpacity",100)/100.0));
      styleFontFamily=Str(settings,"progressOverlayFontFamily");
      styleBackground=OverlayStyle.Color(Str(settings,"progressOverlayBg"),Color.FromArgb(150,20,24,32));
      styleBorder=OverlayStyle.Color(Str(settings,"progressOverlayBorder"),Color.FromArgb(140,117,161,218));
      styleText=OverlayStyle.Color(Str(settings,"progressOverlayText"),Color.FromArgb(255,246,247,250));
      styleMuted=OverlayStyle.Color(Str(settings,"progressOverlayMuted"),Color.FromArgb(235,185,198,216));
      styleAccent=OverlayStyle.Color(Str(settings,"progressOverlayAccent"),Color.FromArgb(255,91,143,239));
      if(IsHandleCreated)RefreshDpi();else SetFonts(1);
      Rebuild();
      Place(anchor);
    }
    internal void Follow(Form thought){anchor=thought;Place(thought);}
    void Place(Form thought){
      if(thought==null||thought.IsDisposed)return;
      int gap=Px(10),x=thought.Left-Width-gap,y=thought.Top;
      Rectangle area;try{area=Screen.FromControl(thought).WorkingArea;}catch(Exception){area=Screen.PrimaryScreen.WorkingArea;}
      x=Math.Max(area.Left+4,Math.Min(x,Math.Max(area.Left+4,area.Right-Width-4)));
      y=Math.Max(area.Top+4,Math.Min(y,Math.Max(area.Top+4,area.Bottom-Height-4)));
      var next=new Rectangle(x,y,Width,Height);
      if(Bounds!=next){Bounds=next;if(IsHandleCreated)Present();}
    }
    internal void Poll(bool force=false){
      if(!IsHandleCreated)return;
      if(!force&&DateTime.UtcNow<nextPoll)return;
      nextPoll=DateTime.UtcNow.AddMilliseconds(500);
      if(String.IsNullOrEmpty(DataPath)){if(view.Enabled||view.Rows.Count>0){view=new CompanionView();Rebuild();}return;}
      bool exists=false;long stamp=-1;
      try{if(File.Exists(DataPath)){exists=true;stamp=File.GetLastWriteTimeUtc(DataPath).Ticks;}}catch(Exception){}
      if(!exists){if(view.Enabled||view.Rows.Count>0){view=new CompanionView();Rebuild();}dataExists=false;dataStamp=-1;return;}
      if(!force&&exists==dataExists&&stamp==dataStamp)return;
      try{
        string raw=File.ReadAllText(DataPath,Encoding.UTF8);
        var next=CompanionParse.Parse(raw);
        view=next;dataExists=true;dataStamp=stamp;Rebuild();
      }catch(Exception){dataStamp=-1;}
    }
    int AvailableHeight(){
      int available=Px(600);
      try{var scr=(anchor!=null&&!anchor.IsDisposed)?Screen.FromControl(anchor):Screen.PrimaryScreen;available=scr.WorkingArea.Height-Px(16);}catch(Exception){}
      return Math.Max(Px(48),available);
    }
    void Rebuild(){
      // Never truncate by count (no 8/10 cap). One card per sub-agent; the
      // layout shrinks the line height to fit the working area and only then
      // drops the secondary detail line, so every agent keeps a readable card
      // (A10 and larger).
      int available=AvailableHeight();
      layout=CompanionLayout.Build(view,scale,available);
      lineHeight=layout.LineHeight;
      int w=layout.Width,h=Math.Max(Px(24),layout.Height);
      if(h>available)h=available;
      if(Width!=w||Height!=h){Width=w;Height=h;}
      Present();
    }
    // One rounded card per sub-agent, stacked top to bottom inside the single
    // transparent host window. The host itself paints nothing, so the gaps
    // between cards stay fully click-through.
    Bitmap DrawSurface(){
      var image=new Bitmap(Math.Max(1,Width),Math.Max(1,Height),PixelFormat.Format32bppPArgb);
      using(var g=Graphics.FromImage(image)){
        g.Clear(Color.Transparent);g.SmoothingMode=SmoothingMode.AntiAlias;g.TextRenderingHint=TextRenderingHint.AntiAliasGridFit;
        int pad=layout.Padding,radius=layout.Radius;
        using(var fg=new SolidBrush(styleText))using(var muted=new SolidBrush(styleMuted))using(var accent=new SolidBrush(styleAccent))using(var bg=new SolidBrush(styleBackground))using(var border=new Pen(styleBorder,1))using(var format=(StringFormat)StringFormat.GenericTypographic.Clone()){
          format.FormatFlags|=StringFormatFlags.NoWrap;format.Trimming=StringTrimming.EllipsisCharacter;
          float captionY=layout.Outer;
          foreach(var line in layout.Caption){
            Font font=line.Kind==0?titleFont:detailFont;
            Brush brush=line.Kind==0?fg:muted;
            g.DrawString(line.Text,font,brush,new RectangleF(layout.Outer,captionY,Math.Max(10,layout.Width-2*layout.Outer),lineHeight),format);
            captionY+=lineHeight;
          }
          foreach(var card in layout.Cards){
            var box=card.Bounds;
            if(box.Width<2||box.Height<2)continue;
            var outline=new RectangleF(box.Left+.5f,box.Top+.5f,box.Width-1,box.Height-1);
            using(var shape=Frame.Rounded(outline,radius)){g.FillPath(bg,shape);g.DrawPath(border,shape);}
            float y=box.Top+pad;
            float textWidth=Math.Max(10,box.Width-2*pad);
            foreach(var line in card.Lines){
              Font font=line.Kind==2?bodyFont:detailFont;
              Brush brush=line.Kind==2?(line.Acting?accent:fg):muted;
              g.DrawString(line.Text,font,brush,new RectangleF(box.Left+pad,y,textWidth,lineHeight),format);
              y+=lineHeight;
            }
          }
        }
      }
      return image;
    }
    void Present(){
      if(presenting||!IsHandleCreated||IsDisposed||Width<1||Height<1)return;presenting=true;
      try{using(var image=DrawSurface()){IntPtr dc=Native.CreateCompatibleDC(IntPtr.Zero),bitmap=image.GetHbitmap(Color.FromArgb(0)),previous=Native.SelectObject(dc,bitmap);try{var dest=new Native.Point(Left,Top);var origin=new Native.Point(0,0);var size=new Native.Size(Width,Height);var blend=new Native.Blend{op=0,flags=0,alpha=(byte)Math.Max(0,Math.Min(255,Math.Round(WindowOpacity*255))),format=1};if(!Native.UpdateLayeredWindow(Handle,IntPtr.Zero,ref dest,ref size,dc,ref origin,0,ref blend,2))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Could not present companion overlay");paints++;}finally{Native.SelectObject(dc,previous);Native.DeleteObject(bitmap);Native.DeleteDC(dc);}}}finally{presenting=false;}
    }
    static string Str(Dictionary<string,object> data,string key){object value;if(!data.TryGetValue(key,out value)||value==null)return "";return Convert.ToString(value,System.Globalization.CultureInfo.InvariantCulture)??"";}
    static double NumD(Dictionary<string,object> data,string key,double fallback){object value;if(!data.TryGetValue(key,out value)||value==null)return fallback;try{return Convert.ToDouble(value,System.Globalization.CultureInfo.InvariantCulture);}catch(Exception){double d;return Double.TryParse(Convert.ToString(value,System.Globalization.CultureInfo.InvariantCulture),System.Globalization.NumberStyles.Any,System.Globalization.CultureInfo.InvariantCulture,out d)?d:fallback;}}
  }
  // Explicit, caller-supplied input to the multi-pointer drawing layer. Pure
  // data only: a stable Key for identity, a display Name, a distinguishable
  // Color, a physical-pixel screen Point, the physical bounds of the monitor
  // that point belongs to, and that monitor DPI scale (96 DPI == 1.0). No
  // field is inferred from ambient or caller state.
  internal sealed class PointerVisual {
    internal readonly string Key;
    internal readonly string Name;
    internal readonly Color Color;
    internal readonly Native.Point Point;
    internal readonly Rectangle MonitorBounds;
    internal readonly float Scale;
    // Heading in DEGREES OF ROTATION about the tip (0 = canonical up-left
    // glyph, i.e. exactly the historical F1 triangle). float.NaN means "no
    // heading supplied" and draws canonical without touching the trig branch.
    internal readonly float HeadingDeg;
    // Whole-marker opacity in [0,1]; 1 means fully opaque (historical look).
    internal readonly float Opacity;
    internal PointerVisual(string key, string name, Color color, Native.Point point, Rectangle monitorBounds, float scale)
      : this(key, name, color, point, monitorBounds, scale, float.NaN, 1f) { }
    internal PointerVisual(string key, string name, Color color, Native.Point point, Rectangle monitorBounds, float scale, float headingDeg, float opacity) {
      Key = key == null ? "" : key;
      Name = name == null ? "" : name;
      Color = color;
      Point = point;
      MonitorBounds = monitorBounds;
      Scale = (scale > 0f && !float.IsNaN(scale) && !float.IsInfinity(scale)) ? scale : 1f;
      HeadingDeg = headingDeg;
      Opacity = (opacity >= 0f && !float.IsNaN(opacity) && !float.IsInfinity(opacity)) ? (opacity > 1f ? 1f : opacity) : 1f;
    }
  }

  // A small cursor-following layer. The system cursor, theme and input state
  // remain owned by Windows; closing/crashing this process leaves no cursor changes.
  internal sealed class PointerFrame : Form {
    IntPtr dc, bitmap, previous;
    float scale;
    bool flipX, flipY;
    Rectangle lastBounds;
    byte lastAlpha;
    SizeF lastExtent;
    bool remoteVisible;
    internal PointerFrame(bool visible) {
      remoteVisible=visible;
      AutoScaleMode = AutoScaleMode.None; FormBorderStyle = FormBorderStyle.None;
      ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
      Bounds = new Rectangle(0,0,1,1);
      dc = Native.CreateCompatibleDC(IntPtr.Zero);
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get { var value=base.CreateParams; value.ExStyle|=0x80000|0x20|0x80|0x08000000; return value; }
    }
    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); SetRemoteVisible(remoteVisible); }
    internal void SetRemoteVisible(bool visible) {remoteVisible=visible;Native.ApplyDisplayAffinity(this,visible);}
    internal bool ClickThrough { get { return (Native.GetWindowLong(Handle,-20)&0x08080020)==0x08080020; } }
    internal bool CaptureExcluded { get { uint affinity; return Native.GetWindowDisplayAffinity(Handle,out affinity)&&affinity==0x11; } }
    // Geometry in 96-DPI units. The tag sits just past the pointer's visible
    // extent; the canvas grows with it, and the default arrow keeps 120x84.
    static float TagX(SizeF extent) { return Math.Max(13f,extent.Width+2); }
    static float TagY(SizeF extent) { return Math.Max(17f,extent.Height-1); }
    static float CanvasWidth(SizeF extent) { return Math.Max(120f,24+TagX(extent)+48); }
    static float CanvasHeight(SizeF extent) { return Math.Max(84f,24+TagY(extent)+27); }
    static bool FlipX(Native.Point point, Rectangle screen, float zoom, SizeF extent) { return screen.Right-point.x < (CanvasWidth(extent)-24)*zoom; }
    static bool FlipY(Native.Point point, Rectangle screen, float zoom, SizeF extent) { return screen.Bottom-point.y < (CanvasHeight(extent)-18)*zoom; }
    internal static Rectangle LayoutForPoint(Native.Point point, Rectangle screen, float zoom) { return LayoutForPoint(point,screen,zoom,SizeF.Empty); }
    internal static Rectangle LayoutForPoint(Native.Point point, Rectangle screen, float zoom, SizeF extent) {
      float canvasWidth=CanvasWidth(extent),canvasHeight=CanvasHeight(extent);
      int width=(int)Math.Ceiling(canvasWidth*zoom),height=(int)Math.Ceiling(canvasHeight*zoom);
      int centerX=(int)Math.Round((FlipX(point,screen,zoom,extent)?canvasWidth-24:24)*zoom),centerY=(int)Math.Round((FlipY(point,screen,zoom,extent)?canvasHeight-24:24)*zoom);
      return new Rectangle(point.x-centerX,point.y-centerY,width,height);
    }
    // The user's pointer size: the arrow's visible extent past its hotspot, in
    // 96-DPI units. Measured once, and again only after Windows reports a
    // preference change (pointer size or cursor scheme).
    static SizeF? pointerExtent;
    internal static void ForgetPointerSize() { pointerExtent=null; }
    internal static SizeF PointerExtent() {
      if(!pointerExtent.HasValue) {
        var measured=MeasureCursor(Native.LoadCursor(IntPtr.Zero,new IntPtr(32512)));
        float dpi=96; try { dpi=Native.GetDpiForSystem(); } catch(EntryPointNotFoundException) { }
        // Windows enlarges the accessibility pointer when drawing it, not in the
        // arrow image; SPI_GETCURSORBASESIZE reports that size (32 by default).
        int baseSize; if(!Native.SystemParametersInfo(0x2028,0,out baseSize,0)||baseSize<32)baseSize=32;
        float factor=Math.Min(8f,baseSize/32f)/Math.Max(1f,dpi/96f);
        pointerExtent=new SizeF(measured.Width*factor,measured.Height*factor);
      }
      return pointerExtent.Value;
    }
    // Visible pixels past the hotspot, in physical pixels.
    internal static SizeF MeasureCursor(IntPtr cursor) {
      Native.IconInfo info;
      if(cursor==IntPtr.Zero||!Native.GetIconInfo(cursor,out info))return SizeF.Empty;
      try {
        using(var icon=Icon.FromHandle(cursor))
        using(var image=icon.ToBitmap()) {
          var data=image.LockBits(new Rectangle(0,0,image.Width,image.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
          int right=-1,bottom=-1;
          try {
            int row=Math.Abs(data.Stride)/4;var pixels=new int[row*image.Height];
            Marshal.Copy(data.Scan0,pixels,0,pixels.Length);
            for(int y=0;y<image.Height;y++)for(int x=0;x<image.Width;x++)if(((pixels[y*row+x]>>24)&0xff)>40){if(x>right)right=x;if(y>bottom)bottom=y;}
          } finally { image.UnlockBits(data); }
          // A monochrome pointer draws without alpha; size it from its cell like the arrow.
          if(right<0)return new SizeF(Math.Max(0,image.Width*.375f-info.hotX),Math.Max(0,image.Height*.6f-info.hotY));
          return new SizeF(Math.Max(0,right-info.hotX+1),Math.Max(0,bottom-info.hotY+1));
        }
      } catch(ArgumentException) { return SizeF.Empty; }
      catch(ExternalException) { return SizeF.Empty; }
      finally {
        if(info.mask!=IntPtr.Zero)Native.DeleteObject(info.mask);
        if(info.color!=IntPtr.Zero)Native.DeleteObject(info.color);
      }
    }
    internal void Update(Native.Point point, byte alpha) {
      var screen=Native.DisplayFromPoint(point);
      uint dpiX=96,dpiY=96; try { if(Native.GetDpiForMonitor(Native.MonitorFromPoint(point,2),0,out dpiX,out dpiY)!=0)dpiX=96; } catch(EntryPointNotFoundException) { }
      float zoom=Math.Max(1f,Math.Min(3f,dpiX/96f));
      var extent=PointerExtent();
      bool nextFlipX=FlipX(point,screen,zoom,extent),nextFlipY=FlipY(point,screen,zoom,extent);
      bool redraw=bitmap==IntPtr.Zero||Math.Abs(scale-zoom)>.01f||flipX!=nextFlipX||flipY!=nextFlipY||extent!=lastExtent;
      if(redraw) {
        using(var image=Draw(zoom,nextFlipX,nextFlipY,extent)) {
          IntPtr next=image.GetHbitmap(Color.FromArgb(0));
          IntPtr selected=Native.SelectObject(dc,next);
          if(bitmap==IntPtr.Zero)previous=selected; else Native.DeleteObject(bitmap);
          bitmap=next;
        }
        scale=zoom;flipX=nextFlipX;flipY=nextFlipY;lastExtent=extent;
      }
      var bounds=LayoutForPoint(point,screen,zoom,extent);
      if(!redraw&&bounds==lastBounds&&alpha==lastAlpha)return;
      var destination=new Native.Point(bounds.X,bounds.Y);var origin=new Native.Point(0,0);var size=new Native.Size(bounds.Width,bounds.Height);
      var blend=new Native.Blend { op=0,flags=0,alpha=alpha,format=1 };
      if(!Native.UpdateLayeredWindow(Handle,IntPtr.Zero,ref destination,ref size,dc,ref origin,0,ref blend,2))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Could not present pointer indicator");
      lastBounds=bounds;lastAlpha=alpha;
    }
    // ---- Shared pure drawing helpers --------------------------------------
    static readonly Color DefaultPointerColor = Color.FromArgb(57, 100, 254);
    static readonly Color DefaultGlowColor = Color.FromArgb(86, 134, 254);
    const float TagHeight = 19f;
    const float TagGapX = 16f;
    const float TagGapY = 18f;
    const float TagStackGap = 4f;

    static Font PointerFont() { return new Font("Segoe UI", 10, FontStyle.Bold, GraphicsUnit.Pixel); }
    static StringFormat PointerTagFormat() { return new StringFormat(StringFormat.GenericTypographic) { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center }; }
    static float TagWidth(Graphics g, Font font, StringFormat format, string label) { return (float)Math.Ceiling(g.MeasureString(label, font, PointF.Empty, format).Width) + 14; }

    // Soft radial spotlight centred on the tip, tinted with the pointer colour.
    static void DrawSpotlight(Graphics g, float x, float y, Color glow) {
      using(var spot=new GraphicsPath()) {
        spot.AddEllipse(x-16,y-16,32,32);
        using(var brush=new PathGradientBrush(spot) { CenterColor=Color.FromArgb(120,glow), SurroundColors=new[] { Color.FromArgb(0,glow) } }) g.FillPath(brush,spot);
      }
    }

    // The solid name tag shared by both the single- and multi-pointer paths.
    static void DrawTag(Graphics g, Font font, StringFormat format, RectangleF r, bool left, bool up, string label, Color color) {
      using(var shadow=Frame.Rounded(new RectangleF(r.X,r.Y+1.5f,r.Width,r.Height),6)) using(var brush=new SolidBrush(Color.FromArgb(60,0,0,0))) g.FillPath(brush,shadow);
      using(var shape=TagShape(r,left,up)) {
        using(var fill=new SolidBrush(Color.FromArgb(255,color)))g.FillPath(fill,shape);
        using(var outline=new Pen(Color.FromArgb(240,255,255,255),1.25f))g.DrawPath(outline,shape);
      }
      using(var brush=new SolidBrush(Color.White))g.DrawString(label,font,brush,new RectangleF(r.X,r.Y+.5f,r.Width,r.Height),format);
    }

    internal static Bitmap Draw(float zoom,bool left,bool up) { return Draw(zoom,left,up,SizeF.Empty); }
    internal static Bitmap Draw(float zoom,bool left,bool up,SizeF extent) {
      float canvasWidth=CanvasWidth(extent),canvasHeight=CanvasHeight(extent);
      var image=new Bitmap((int)Math.Ceiling(canvasWidth*zoom),(int)Math.Ceiling(canvasHeight*zoom),PixelFormat.Format32bppPArgb);
      using(var g=Graphics.FromImage(image)) {
        g.Clear(Color.Transparent);g.SmoothingMode=SmoothingMode.AntiAlias;g.TextRenderingHint=TextRenderingHint.AntiAliasGridFit;g.ScaleTransform(zoom,zoom);
        float x=left?canvasWidth-24:24,y=up?canvasHeight-24:24;
        // A soft spotlight under the tip instead of a hard ring.
        DrawSpotlight(g,x,y,DefaultGlowColor);
        // A solid name tag just past the arrow, like collaborative cursors.
        using(var font=PointerFont())
        using(var format=PointerTagFormat()) {
          float w=TagWidth(g,font,format,"DSH"),h=TagHeight;
          // Below-right clears the pointer's whole extent; the other corners only need to clear the tip.
          float bx=left?x-8-w:up?x+13:x+TagX(extent),by=up?y-10-h:left?y+17:y+TagY(extent);
          DrawTag(g,font,format,new RectangleF(bx,by,w,h),left,up,"DSH",DefaultPointerColor);
        }
      }
      return image;
    }

        // ---- Multi-pointer pure drawing layer --------------------------------
    // Renders any number of explicitly supplied PointerVisual markers onto an
    // image that is exactly the caller-supplied screen rectangle in physical
    // pixels: the Bitmap is screen.Width x screen.Height and its origin is
    // screen.Location, so a marker whose physical point is p lands on bitmap
    // pixel (p - screen.Location). There is no auto-cropping and no ambient
    // state; every key, name, colour, point, monitor and DPI scale is supplied
    // by the caller.
    //
    // A marker is drawn only when its physical point lies inside BOTH its own
    // monitor bounds and the canvas. Right and bottom edges are open, so a
    // point exactly on the far edge is excluded. Each marker is scaled by its
    // own monitor DPI/96 and all collision work happens in the single
    // physical-pixel space, so markers from mixed-DPI monitors still avoid one
    // another. The tip never moves: the arrow is mirrored inward when it would
    // overrun a screen edge or a cross-screen seam, and a long label is
    // ellipsised so its tag fits the available space instead of hiding every
    // point. Pure: this never reads the OS cursor or input state and never
    // creates a window, so the single-pointer path above is untouched.
    internal static Bitmap DrawVisuals(IList<PointerVisual> visuals, Rectangle screen) {
      if (screen.Width <= 0 || screen.Height <= 0) screen = new Rectangle(screen.X, screen.Y, 1, 1);
      var image = new Bitmap(screen.Width, screen.Height, PixelFormat.Format32bppPArgb);
      try {
        using (var g = Graphics.FromImage(image)) {
          DrawVisualsInto(g, visuals, screen);
        }
        return image;
      } catch {
        image.Dispose();
        throw;
      }
    }

    // Paints the same visuals onto any caller-supplied Graphics whose surface is
    // already sized to `screen`, using the identical clear/clip/DrawVisual
    // sequence as DrawVisuals. The live overlay passes a Graphics over a
    // persistent DIB section here, so it repaints without allocating a
    // full-screen Bitmap or copying one out with GetHbitmap each frame. Pure:
    // still never reads the OS cursor or input state.
    internal static void DrawVisualsInto(Graphics g, IList<PointerVisual> visuals, Rectangle screen) {
      if (screen.Width <= 0 || screen.Height <= 0) screen = new Rectangle(screen.X, screen.Y, 1, 1);
      g.Clear(Color.Transparent);
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
      var placed = new List<RectangleF>();
      if (visuals != null) {
        foreach (var visual in visuals) {
          if (visual == null) continue;
          Rectangle bounds = Rectangle.Intersect(screen, visual.MonitorBounds);
          if (!InRegion(visual.Point, bounds)) continue;
          bounds.Offset(-screen.X, -screen.Y);
          // Limit all pixels, including glow and stroke, to this monitor.
          GraphicsState state = g.Save();
          try {
            g.SetClip(bounds, CombineMode.Intersect);
            DrawVisual(g, visual, visual.Point.x - screen.X, visual.Point.y - screen.Y, bounds, placed);
          } finally {
            g.Restore(state);
          }
        }
      }
    }

    static void DrawVisual(Graphics g, PointerVisual visual, float x, float y, Rectangle bounds, List<RectangleF> placed) {
      // Prefer folding the entire glyph inward; clipping is a fallback on
      // very small screens. The tip always stays on the caller's point.
      const float Margin = 2f, ArrowW = TriangleExtent, ArrowH = TriangleExtent;
      float s = visual.Scale;
      float left = bounds.Left + Margin, top = bounds.Top + Margin;
      float right = bounds.Right - Margin, bottom = bounds.Bottom - Margin;
      float roomRight = right - x, roomLeft = x - left;
      float roomBottom = bottom - y, roomTop = y - top;
      bool flipX = ArrowW * s > roomRight && roomLeft > roomRight;
      bool flipY = ArrowH * s > roomBottom && roomTop > roomBottom;
      Color color = visual.Color;
      float opacity = visual.Opacity;
      float headingRad = (float.IsNaN(visual.HeadingDeg) || float.IsInfinity(visual.HeadingDeg)) ? 0f : (float)(visual.HeadingDeg * System.Math.PI / 180.0);
      // The minimalist triangle carries its own white edge glow; no radial
      // spotlight, so the cursor reads as a clean triangular pointer.
      DrawArrow(g, x, y, color, flipX, flipY, s, headingRad, opacity);
      if (opacity <= 0.001f) return;

      string label = !string.IsNullOrEmpty(visual.Name) ? visual.Name : visual.Key;
      if (string.IsNullOrEmpty(label)) return;
      // Reserve room for the stroke as well as the tag; on a very short or
      // narrow monitor, keep the anchored arrow instead of a clipped label.
      float edge = 2f * Math.Max(1f, 1.25f * s);
      float h = TagHeight * s, maxW = right - left - edge;
      float maxTextW = maxW - 14f * s;
      if (maxTextW < 12f * s || h + edge > bottom - top) return;
      using (var font = MultiFont(s))
      using (var format = PointerTagFormat()) {
        float w = MultiTagWidth(g, font, format, label, s);
        if (w > maxW) {
          label = ElideLabel(g, font, format, label, maxTextW);
          if (label.Length == 0) return;
          w = MultiTagWidth(g, font, format, label, s);
        }
        RectangleF preferred;
        RectangleF tag = PlaceTag(x, y, w, h, placed, out preferred, s, left, top, right, bottom);
        bool tleft = tag.Right <= x + 2f * s;
        bool tup = tag.Bottom <= y + 2f * s;
        placed.Add(tag);
        if (tag.X != preferred.X || tag.Y != preferred.Y) DrawLeader(g, x, y, tag, color, s, opacity);
        DrawTagScaled(g, font, format, tag, tleft, tup, label, color, s, opacity);
      }
    }


    // Half-open containment in physical pixels: left/top inclusive, right/bottom
    // exclusive, so the far edges are open boundaries.
    static bool InRegion(Native.Point p, Rectangle r) {
      return p.x >= r.Left && p.x < r.Right && p.y >= r.Top && p.y < r.Bottom;
    }

    static Font MultiFont(float scale) { return new Font("Segoe UI", 10f * scale, FontStyle.Bold, GraphicsUnit.Pixel); }
    static float MultiTagWidth(Graphics g, Font font, StringFormat format, string label, float scale) {
      return (float)Math.Ceiling(g.MeasureString(label, font, PointF.Empty, format).Width) + 14f * scale;
    }

    // Shortens a label with an ellipsis until its measured text fits maxTextWidth,
    // so a very long name cannot make the tag span and hide the whole canvas.
    static string ElideLabel(Graphics g, Font font, StringFormat format, string label, float maxTextWidth) {
      if (label == null) return "";
      if (maxTextWidth <= 0f) return "";
      if (g.MeasureString(label, font, PointF.Empty, format).Width <= maxTextWidth) return label;
      string ellipsis = ((char)0x2026).ToString();
      if (g.MeasureString(ellipsis, font, PointF.Empty, format).Width > maxTextWidth) return "";
      int lo = 0, hi = label.Length;
      while (lo < hi) {
        int mid = (lo + hi + 1) / 2;
        string candidate = label.Substring(0, mid) + ellipsis;
        if (g.MeasureString(candidate, font, PointF.Empty, format).Width <= maxTextWidth) lo = mid; else hi = mid - 1;
      }
      return label.Substring(0, lo) + ellipsis;
    }

    static Color GlowColor(Color c) {
      return Color.FromArgb(Math.Min(255, c.R + 29), Math.Min(255, c.G + 34), c.B);
    }

    // Soft radial spotlight centred on the tip, tinted with the pointer colour,
    // scaled by the marker DPI.
    static void DrawSpotlight(Graphics g, float x, float y, Color glow, float scale) {
      float r = 20f * scale;
      using (var spot = new GraphicsPath()) {
        spot.AddEllipse(x - r, y - r, r * 2f, r * 2f);
        using (var brush = new PathGradientBrush(spot) { CenterColor = Color.FromArgb(108, glow), SurroundColors = new[] { Color.FromArgb(0, glow) } }) g.FillPath(brush, spot);
      }
      float core = 2.1f * scale;
      using (var dot = new GraphicsPath()) {
        dot.AddEllipse(x - core, y - core, core * 2f, core * 2f);
        using (var brush = new SolidBrush(Color.FromArgb(142, glow))) g.FillPath(brush, dot);
      }
    }

    // A compact vector cursor in the marker colour, scaled by its DPI. The (0,0)
    // vertex is the tip, so flipping keeps the tip on the exact point.
    static Color BlendColour(Color a, Color b, float t) {
      t = Math.Max(0f, Math.Min(1f, t));
      return Color.FromArgb(
        (int)Math.Round(a.A + (b.A - a.A) * t), (int)Math.Round(a.R + (b.R - a.R) * t),
        (int)Math.Round(a.G + (b.G - a.G) * t), (int)Math.Round(a.B + (b.B - a.B) * t));
    }

    // A deliberately plain triangular cursor. The (0,0) vertex is the exact
    // click point; the two base corners sit down/right so the shape reads as a
    // lightweight arrowhead rather than a Windows pointer silhouette.
    // The base edge was widened 25% about its midpoint (12,12): the previous
    // (16.2,7.8)-(7.8,16.2) edge became (17.25,6.75)-(6.75,17.25). Both corners
    // still satisfy x+y=24, so the tip (0,0) and the glyph height are unchanged.
    internal const float TriangleExtent = 17.25f;
    internal const float TriangleInset = 6.75f;
    // Canonical glyph orientation as a travel angle in screen degrees (x right,
    // y down): the tip points up-left, toward (-1,-1). The writer's headingDeg
    // is atan2 of the real movement, so the applied rotation is
    // (headingDeg - CanonicalTipDeg). Omitting headingDeg leaves the glyph
    // exactly as the historical F1 triangle (zero rotation).
    internal const float CanonicalTipDeg = -135f;

    // The three glyph vertices (tip first) at the given scale, exposed for the
    // offline geometry regression. Drawing itself still goes through
    // MinimalTrianglePath so the tested points are the ones actually drawn.
    internal static PointF[] TrianglePoints(float scale) { return TrianglePoints(scale, 0f); }
    internal static PointF[] TrianglePoints(float scale, float headingRad) {
      if (!(scale > 0f) || float.IsInfinity(scale)) scale = 1f;
      float cos = 1f, sin = 0f;
      if (headingRad != 0f && !float.IsNaN(headingRad) && !float.IsInfinity(headingRad)) {
        cos = (float)System.Math.Cos(headingRad); sin = (float)System.Math.Sin(headingRad);
      }
      Func<float, float, PointF> r = (dx, dy) => {
        float rx = cos * dx - sin * dy, ry = sin * dx + cos * dy;
        return new PointF(rx * scale, ry * scale);
      };
      return new[] { new PointF(0f, 0f), r(TriangleExtent, TriangleInset), r(TriangleInset, TriangleExtent) };
    }

    static GraphicsPath MinimalTrianglePath(float x, float y, bool flipX, bool flipY, float scale) {
      return MinimalTrianglePath(x, y, flipX, flipY, scale, 0f);
    }
    static GraphicsPath MinimalTrianglePath(float x, float y, bool flipX, bool flipY, float scale, float headingRad) {
      float cos = 1f, sin = 0f;
      bool rot = headingRad != 0f && !float.IsNaN(headingRad) && !float.IsInfinity(headingRad);
      if (rot) { cos = (float)System.Math.Cos(headingRad); sin = (float)System.Math.Sin(headingRad); }
      Func<float, float, PointF> p = (dx, dy) => {
        float rx = rot ? cos * dx - sin * dy : dx;
        float ry = rot ? sin * dx + cos * dy : dy;
        return new PointF(flipX ? x - rx * scale : x + rx * scale, flipY ? y - ry * scale : y + ry * scale);
      };
      var path = new GraphicsPath();
      path.AddPolygon(new[] { p(0f, 0f), p(TriangleExtent, TriangleInset), p(TriangleInset, TriangleExtent) });
      path.CloseFigure();
      return path;
    }

    static void DrawArrow(Graphics g, float x, float y, Color color, bool flipX, bool flipY, float scale) {
      DrawArrow(g, x, y, color, flipX, flipY, scale, 0f, 1f);
    }
    static void DrawArrow(Graphics g, float x, float y, Color color, bool flipX, bool flipY, float scale, float headingRad, float opacity) {
      if (!(opacity >= 0f) || float.IsNaN(opacity)) opacity = 1f;
      if (opacity > 1f) opacity = 1f;
      if (opacity <= 0.001f) return; // fully faded out: draw nothing
      Func<int, int> A = a => (int)System.Math.Round(a * opacity);
      using (var path = MinimalTrianglePath(x, y, flipX, flipY, scale, headingRad)) {
        // Shadows and white bloom stay outside so the tinted interior keeps
        // its colour and translucency instead of accumulating opaque layers.
        GraphicsState bloomState = g.Save();
        try {
          g.SetClip(path, CombineMode.Exclude);
          using (var shadow = (GraphicsPath)path.Clone()) {
            using (var shift = new Matrix()) { shift.Translate(1.2f * scale, 2.0f * scale); shadow.Transform(shift); }
            using (var brush = new SolidBrush(Color.FromArgb(A(52), 0, 0, 0))) g.FillPath(brush, shadow);
          }
          using (var halo = new Pen(Color.FromArgb(A(34), 255, 255, 255), Math.Max(6f, 11f * scale))) {
            halo.LineJoin = LineJoin.Round; g.DrawPath(halo, path);
          }
          using (var bloom = new Pen(Color.FromArgb(A(86), 255, 255, 255), Math.Max(3f, 5.8f * scale))) {
            bloom.LineJoin = LineJoin.Round; g.DrawPath(bloom, path);
          }
          using (var veil = new Pen(Color.FromArgb(A(138), 255, 255, 255), Math.Max(1.8f, 3.1f * scale))) {
            veil.LineJoin = LineJoin.Round; g.DrawPath(veil, path);
          }
        } finally { g.Restore(bloomState); }
        RectangleF bounds = path.GetBounds();
        Color top = BlendColour(color, Color.White, 0.14f);
        using (var fill = new LinearGradientBrush(bounds, Color.FromArgb(A(90), top), Color.FromArgb(A(58), color), 45f)) g.FillPath(fill, path);
        using (var rim = new Pen(Color.FromArgb(A(242), 255, 255, 255), Math.Max(1f, 1.3f * scale))) {
          rim.LineJoin = LineJoin.Round; g.DrawPath(rim, path);
        }
      }
    }

    // The solid name tag for the multi-pointer path, scaled by the marker DPI.
    static void DrawTagScaled(Graphics g, Font font, StringFormat format, RectangleF r, bool left, bool up, string label, Color color, float scale, float opacity = 1f) {
      if (!(opacity >= 0f) || float.IsNaN(opacity)) opacity = 1f;
      if (opacity > 1f) opacity = 1f;
      if (opacity <= 0.001f) return;
      Func<int, int> A = a => (int)System.Math.Round(a * opacity);
      float radius = Math.Max(1f, 6f * scale);
      using (var shadow = Frame.Rounded(new RectangleF(r.X, r.Y + 1.5f * scale, r.Width, r.Height), radius))
      using (var brush = new SolidBrush(Color.FromArgb(A(60), 0, 0, 0))) g.FillPath(brush, shadow);
      using (var shape = TagShapeScaled(r, left, up, scale)) {
        using (var fill = new SolidBrush(Color.FromArgb(A(255), color))) g.FillPath(fill, shape);
        using (var outline = new Pen(Color.FromArgb(A(240), 255, 255, 255), Math.Max(1f, 1.25f * scale))) g.DrawPath(outline, shape);
      }
      using (var brush = new SolidBrush(Color.FromArgb(A(255), 255, 255, 255))) g.DrawString(label, font, brush, new RectangleF(r.X, r.Y + 0.5f * scale, r.Width, r.Height), format);
    }

    static GraphicsPath TagShapeScaled(RectangleF r, bool left, bool up, float scale) {
      float big = 6f * scale, small = 2f * scale;
      float topLeft = !left && !up ? small : big, topRight = left && !up ? small : big;
      float bottomRight = left && up ? small : big, bottomLeft = !left && up ? small : big;
      var p = new GraphicsPath();
      p.AddArc(r.X, r.Y, topLeft * 2f, topLeft * 2f, 180, 90);
      p.AddArc(r.Right - topRight * 2f, r.Y, topRight * 2f, topRight * 2f, 270, 90);
      p.AddArc(r.Right - bottomRight * 2f, r.Bottom - bottomRight * 2f, bottomRight * 2f, bottomRight * 2f, 0, 90);
      p.AddArc(r.X, r.Bottom - bottomLeft * 2f, bottomLeft * 2f, bottomLeft * 2f, 90, 90);
      p.CloseFigure();
      return p;
    }

    // Keeps a tag inside its allowed box and, when tags would collide, stacks the
    // later one below then above so same-point markers stay legible. All geometry
    // is physical pixels; gaps scale with the marker.
    static RectangleF PlaceTag(float x, float y, float w, float h, List<RectangleF> occupied, out RectangleF preferred, float scale, float left, float top, float right, float bottom) {
      float gapX = TagGapX * scale, gapY = TagGapY * scale, stack = TagStackGap * scale;
      float minX = left, maxX = Math.Max(left, right - w);
      float minY = top, maxY = Math.Max(top, bottom - h);
      float bx = x + gapX, by = y + gapY;
      if (bx + w > right) bx = x - gapX - w;
      bx = Math.Max(minX, Math.Min(maxX, bx));
      if (by + h > bottom) by = y - gapY - h;
      by = Math.Max(minY, Math.Min(maxY, by));
      preferred = new RectangleF(bx, by, w, h);
      if (!OverlapsAny(preferred, occupied)) return preferred;
      for (int k = 1; k <= 64; k++) {
        float ny = preferred.Y + k * (h + stack);
        if (ny + h > bottom) break;
        var r = new RectangleF(preferred.X, ny, w, h);
        if (!OverlapsAny(r, occupied)) return r;
      }
      for (int k = 1; k <= 64; k++) {
        float ny = preferred.Y - k * (h + stack);
        if (ny < top) break;
        var r = new RectangleF(preferred.X, ny, w, h);
        if (!OverlapsAny(r, occupied)) return r;
      }
      return preferred;
    }

    static bool OverlapsAny(RectangleF r, List<RectangleF> occupied) {
      if (occupied == null) return false;
      foreach (var other in occupied) if (r.IntersectsWith(other)) return true;
      return false;
    }

    static void DrawLeader(Graphics g, float x, float y, RectangleF tag, Color color, float scale, float opacity = 1f) {
      if (!(opacity >= 0f) || float.IsNaN(opacity)) opacity = 1f;
      if (opacity <= 0.001f) return;
      float tx = tag.X <= x ? tag.Right - 1f : tag.X + 1f;
      float ty = tag.Y + tag.Height / 2f;
      using (var pen = new Pen(Color.FromArgb((int)System.Math.Round(160 * Math.Min(1f, opacity)), color), Math.Max(1f, 1.25f * scale))) {
        pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
        g.DrawLine(pen, x, y, tx, ty);
      }
    }

    // The corner nearest the pointer stays tight, so the tag reads as attached.
    static GraphicsPath TagShape(RectangleF r,bool left,bool up) {
      float topLeft=!left&&!up?2:6,topRight=left&&!up?2:6,bottomRight=left&&up?2:6,bottomLeft=!left&&up?2:6;
      var p=new GraphicsPath();
      p.AddArc(r.X,r.Y,topLeft*2,topLeft*2,180,90);p.AddArc(r.Right-topRight*2,r.Y,topRight*2,topRight*2,270,90);
      p.AddArc(r.Right-bottomRight*2,r.Bottom-bottomRight*2,bottomRight*2,bottomRight*2,0,90);p.AddArc(r.X,r.Bottom-bottomLeft*2,bottomLeft*2,bottomLeft*2,90,90);
      p.CloseFigure();return p;
    }
    protected override void Dispose(bool disposing) {
      if(dc!=IntPtr.Zero) { if(bitmap!=IntPtr.Zero){Native.SelectObject(dc,previous);Native.DeleteObject(bitmap);}Native.DeleteDC(dc);dc=IntPtr.Zero; }
      base.Dispose(disposing);
    }
  }

  // A live, click-through layer for every tracked subagent's virtual mouse
  // cursor. The visual is the same vector arrow/tag the single-pointer path
  // uses; this class only supplies an explicit list from the state file and
  // presents it in one virtual-screen layered window. It never moves the real
  // cursor and never receives input.
  public static class MultiPointerOverlay {
    public static void Run(string statePath, string logPath) {
      try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); Native.SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
      Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
      Application.EnableVisualStyles();
      try {
        using (var form = new MultiPointerFrame(statePath, logPath)) {
          form.Show();
          Application.Run(form);
        }
      } catch (Exception error) {
        MultiPointerFrame.AppendLog(logPath, "fatal: " + error);
        throw;
      }
    }
  }

  // Display-side motion for the multi-pointer overlay. Each id eases from the
  // position it is currently showing toward the newest target named by the
  // state file. Positions are a pure function of the monotonic clock (never of
  // how many frames happened to be drawn before), so a jittery or late frame
  // cannot accumulate drift. Deliberately window-free so the timing regression
  // can drive it with a fake clock and no desktop.
  internal delegate bool CursorSampler(out Native.Point point);

  // Turns the writer's lifecycle flags into concrete screen anchors with ONE
  // real GetCursorPos sample per state read (shared by every pointer, so all
  // monitors see the same origin). Window-free and side-effect free apart from
  // the injected sampler, so offline fixtures can prove the rules.
  internal sealed class PointerAnchorResolver {
    readonly Dictionary<string, bool> spawned = new Dictionary<string, bool>(StringComparer.Ordinal);
    readonly Dictionary<string, long> released = new Dictionary<string, long>(StringComparer.Ordinal);
    readonly Dictionary<string, Native.Point> releasePoint = new Dictionary<string, Native.Point>(StringComparer.Ordinal);

    internal void Clear() { spawned.Clear(); released.Clear(); releasePoint.Clear(); }

    internal bool HasSpawned(string key) { return key != null && spawned.ContainsKey(key); }

    internal List<MultiPointerAnimator.PointerTarget> Resolve(
        IList<MultiPointerAnimator.PointerTarget> source, CursorSampler sampler,
        Func<string, bool> live, Action<string> evidence) {
      var result = new List<MultiPointerAnimator.PointerTarget>();
      if (source == null) return result;
      // Newest lifetime wins for a reused agent id; stale lifetimes never roll back.
      var newestLife = new Dictionary<string, double>(StringComparer.Ordinal);
      foreach (var target in source) {
        if (target == null || String.IsNullOrEmpty(target.Key)) continue;
        double life;
        if (!Double.TryParse(target.Lifetime, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out life)) continue;
        double seen;
        if (!newestLife.TryGetValue(target.Id == null ? "" : target.Id, out seen) || life > seen)
          newestLife[target.Id == null ? "" : target.Id] = life;
      }
      // Newest seq wins for a key; older writes cannot rewind the pointer.
      var newestSeq = new Dictionary<string, long>(StringComparer.Ordinal);
      foreach (var target in source) {
        if (target == null || String.IsNullOrEmpty(target.Key)) continue;
        long seen;
        if (target.Seq > 0 && (!newestSeq.TryGetValue(target.Key, out seen) || target.Seq > seen))
          newestSeq[target.Key] = target.Seq;
      }
      var emitted = new HashSet<string>(StringComparer.Ordinal);
      Native.Point sample = default(Native.Point);
      bool tried = false, sampled = false;
      Func<bool> readCursor = () => {
        if (!tried) {
          tried = true;
          try { sampled = sampler != null && sampler(out sample); }
          catch (Exception) { sampled = false; }
        }
        return sampled;
      };
      foreach (var target in source) {
        if (target == null || String.IsNullOrEmpty(target.Key)) continue;
        string id = target.Id == null ? "" : target.Id;
        double life;
        double newest;
        if (Double.TryParse(target.Lifetime, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out life)
            && newestLife.TryGetValue(id, out newest) && life < newest) {
          Report(evidence, "anchor: stale lifetime " + target.Key + " (" + life.ToString(System.Globalization.CultureInfo.InvariantCulture) + ")");
          continue;
        }
        long best;
        if (target.Seq > 0 && newestSeq.TryGetValue(target.Key, out best) && target.Seq < best) {
          Report(evidence, "anchor: stale seq " + target.Key + " (" + target.Seq + ")");
          continue;
        }
        if (!emitted.Add(target.Key)) continue;   // one entry per key per state read
        string anchor = (target.CursorAnchor ?? "").Trim().ToLowerInvariant();
        if (anchor == "spawn") {
          if (released.ContainsKey(target.Key) && (live == null || !live(target.Key))) {
            // The pointer was already merged back and the animator dropped it.
            // A spawn row arriving after that is stale writer state; honouring it
            // would resurrect a pointer the user already watched disappear.
            Report(evidence, "anchor: spawn after release " + target.Key);
            continue;
          }
          if (spawned.ContainsKey(target.Key)) {
            // Repeated spawn versions must not resample or reset the origin.
            if (!target.HasPoint) {
              Report(evidence, "anchor: spawn repeat without point " + target.Key);
              continue;
            }
          } else if (!target.HasPoint) {
            if (!readCursor()) {
              Report(evidence, "anchor: spawn sample failed " + target.Key + " err=" + System.Runtime.InteropServices.Marshal.GetLastWin32Error());
              continue;
            }
            target.Point = sample;
            target.HasPoint = true;
            target.MotionMs = 0.0;
            target.HasFrom = false;
            spawned[target.Key] = true;
          } else {
            if (!readCursor()) {
              // Fail closed: hide this frame instead of inventing 0,0 / center.
              Report(evidence, "anchor: spawn sample failed " + target.Key + " err=" + System.Runtime.InteropServices.Marshal.GetLastWin32Error());
              continue;
            }
            target.HasFrom = true;
            target.FromPoint = sample;
            if (target.MotionMs <= 0.0) target.MotionMs = 200.0;
            if (Single.IsNaN(target.HeadingDeg)) {
              // The first departure aims the tip along the real cursor -> target
              // vector, then falls back to the canonical tip on arrival.
              target.HeadingDeg = HeadingFrom(sample, target.Point);
              target.HeadingRestore = true;
            }
            spawned[target.Key] = true;
          }
        } else if (anchor == "release") {
          bool known = (live != null && live(target.Key)) || spawned.ContainsKey(target.Key);
          long previous;
          bool duplicate = released.TryGetValue(target.Key, out previous) && previous >= target.Seq;
          if (!known) {
            Report(evidence, "anchor: release for unknown pointer " + target.Key);
            continue;
          }
          if (duplicate) {
            // The fade already finished and the animator dropped the pointer, yet
            // the writer keeps rewriting this row until its own sweep. Re-emitting
            // it would build a fresh hidden motion, so drop it instead of reviving.
            if (live != null && !live(target.Key)) {
              Report(evidence, "anchor: release already merged " + target.Key);
              continue;
            }
            // Same release version already sampled: never take a second sample.
            // Re-emit the stored destination so the fade already in flight is
            // not dropped by the animator just because the file was rewritten.
            Native.Point stored;
            if (!releasePoint.TryGetValue(target.Key, out stored)) {
              Report(evidence, "anchor: release repeat seq " + target.Seq + " " + target.Key);
              continue;
            }
            target.Point = stored;
            target.HasPoint = true;
            target.HasFrom = false;
            target.RemoveWhenHidden = true;
            target.HeadingRestore = true;
            // Drop any heading the writer still carries: the return trip aims the
            // tip at the sampled cursor, which the animator derives from the
            // point it is currently rendering.
            target.HeadingDeg = float.NaN;
            if (target.MotionMs <= 0.0) target.MotionMs = 200.0;
            Report(evidence, "anchor: release repeat seq " + target.Seq + " reuses sample " + target.Key);
            result.Add(target);
            continue;
          }
          if (!readCursor()) {
            Report(evidence, "anchor: release sample failed " + target.Key + " err=" + System.Runtime.InteropServices.Marshal.GetLastWin32Error());
            continue;
          }
          // The real cursor at release time is the destination; x/y from the
          // writer stays ignored because it may already be stale.
          target.Point = sample;
          target.HasPoint = true;
          target.HasFrom = false;
          target.RemoveWhenHidden = true;
          target.HeadingRestore = true;
          target.HeadingDeg = float.NaN;
          if (target.MotionMs <= 0.0) target.MotionMs = 200.0;
          released[target.Key] = target.Seq;
          releasePoint[target.Key] = sample;
          spawned[target.Key] = true;
        } else if (!target.HasPoint) {
          Report(evidence, "anchor: missing x/y " + target.Key);
          continue;
        }
        result.Add(target);
      }
      return result;
    }

    static void Report(Action<string> evidence, string message) {
      if (evidence != null) { try { evidence(message); } catch (Exception) { } }
    }

    // Real screen heading (atan2, x right / y down) converted to glyph rotation
    // about the tip; canonical heading stays pixel-identical to F1.
    static float HeadingFrom(Native.Point from, Native.Point to) {
      double degrees = Math.Atan2((double)(to.y - from.y), (double)(to.x - from.x)) * 180.0 / Math.PI;
      return (float)(degrees - PointerFrame.CanonicalTipDeg);
    }
  }

  internal sealed class MultiPointerAnimator {
    // One live pointer target as produced by the state file (physical pixels).
    internal sealed class PointerTarget {
      internal string Key;
      internal Native.Point Point;
      internal float HeadingDeg = float.NaN;   // rotation degrees about the tip; NaN = canonical
      internal bool HeadingRestore;
      internal float Opacity = 1f;
      internal double MotionMs;               // this move's tween length (0 = snap)
      internal double SampleMs;               // real sample epoch ms (staleness guard)
      internal long Seq;                      // monotonic write sequence (staleness guard)
      internal IList<Native.Point> Path;      // optional real polyline (physical px)
      // Lifecycle anchors. The writer only marks the first appearance (spawn)
      // and the merge-back (release); the renderer samples the real cursor.
      internal string Id, Lifetime;
      internal string Name;
      internal Color Colour = Color.White;
      internal int Index;
      internal string CursorAnchor;           // "spawn" | "release" | null
      internal bool HasPoint;                 // x/y present or resolved from the real cursor
      internal bool HasFrom;                  // spawn with a target: tween starts at the sampled cursor
      internal Native.Point FromPoint;
      internal bool RemoveWhenHidden;         // release: drop once tween and fade finish
    }

    sealed class Motion {
      internal double FromX, FromY, ToX, ToY;
      internal double StartMs, DurationMs;
      internal double X, Y;
      internal bool Animating;
      internal long Seq;
      internal double SampleMs;
      internal IList<Native.Point> Path;
      internal double PathStartMs;
      // Heading is a rotation in degrees about the tip; NaN = canonical/no rotation.
      internal float Heading = float.NaN, HeadingFrom = float.NaN, HeadingTo = float.NaN;
      // Last headingDeg the writer sent for this pointer. The writer re-sends the
      // value of its last real travel on every flush, so an unchanged value is an
      // echo and must not restart the heading.
      internal float WriterHeading = float.NaN;
      internal double HeadingStartMs, HeadingDurationMs;
      internal bool HeadingActive, HeadingRestore, HeadingTail;
      internal float Opacity = 1f, OpacityFrom = 1f, OpacityTo = 1f;
      internal double OpacityStartMs, OpacityDurationMs;
      internal bool OpacityActive;
      internal bool RemoveWhenHidden;         // release anchor: delete when settled and hidden
    }

    readonly Dictionary<string, Motion> motions = new Dictionary<string, Motion>(StringComparer.Ordinal);

    // Default tween length; long enough to span a dozen 60 Hz frames, short
    // enough that a single jump still settles quickly.
    internal double DurationMs = 200.0;

    internal bool ContainsKey(string key) { return key != null && motions.ContainsKey(key); }

    internal int Count { get { return motions.Count; } }

    internal bool AnyAnimating {
      get {
        foreach (var motion in motions.Values)
          if (motion.Animating || motion.HeadingActive || motion.OpacityActive) return true;
        return false;
      }
    }

    internal void Clear() { motions.Clear(); }

    // Reconcile the animated set with the targets the state file now names.
    // A brand-new id appears exactly at its target (no tween from nowhere), a
    // moved id tweens from its current on-screen position, and ids that vanish
    // are dropped so the next present erases them.
    internal void Sync(IList<string> keys, IList<Native.Point> points, double nowMs) {
      if (keys == null || points == null) return;
      // Sample every running tween at the same monotonic instant the new targets
      // arrive. Tick calls Sync then Advance at one now, so a target that moves
      // again on the very next frame would otherwise retarget from the previous
      // frame's stale position with StartMs=now and then advance t=0 forever:
      // the cursor freezes while the target keeps moving, then snaps on settle.
      Advance(nowMs);
      int pairs = Math.Min(keys.Count, points.Count);
      var keep = new HashSet<string>(StringComparer.Ordinal);
      for (int i = 0; i < pairs; i++) keep.Add(keys[i] == null ? "" : keys[i]);
      var dropped = new List<string>();
      foreach (var key in motions.Keys) if (!keep.Contains(key)) dropped.Add(key);
      foreach (var key in dropped) motions.Remove(key);
      for (int i = 0; i < pairs; i++) {
        var key = keys[i] == null ? "" : keys[i];
        var point = points[i];
        Motion motion;
        if (!motions.TryGetValue(key, out motion)) {
          motion = new Motion {
            FromX = point.x, FromY = point.y, ToX = point.x, ToY = point.y,
            StartMs = nowMs, DurationMs = 0.0, X = point.x, Y = point.y, Animating = false
          };
          motions[key] = motion;
        } else if (motion.ToX != point.x || motion.ToY != point.y) {
          motion.FromX = motion.X;
          motion.FromY = motion.Y;
          motion.ToX = point.x;
          motion.ToY = point.y;
          motion.StartMs = nowMs;
          motion.DurationMs = DurationMs > 0.0 ? DurationMs : 0.0;
          motion.Animating = motion.DurationMs > 0.0;
          if (!motion.Animating) { motion.X = motion.ToX; motion.Y = motion.ToY; }
        }
      }
    }

    // Full entry point: per-move duration, heading, opacity and optional real
    // path. A brand-new id lands exactly on its target, a moved id tweens from
    // its current on-screen position, a vanished id is dropped. Stale samples
    // (older sampleMs/seq) are ignored so a late writer can never rewind a
    // pointer (continuous retarget of streamed real-time progress is the norm).
    internal void Sync(IList<PointerTarget> targets, double nowMs) {
      if (targets == null) return;
      Advance(nowMs);
      var keep = new HashSet<string>(StringComparer.Ordinal);
      foreach (var target in targets) keep.Add(target == null || target.Key == null ? "" : target.Key);
      var dropped = new List<string>();
      foreach (var key in motions.Keys) if (!keep.Contains(key)) dropped.Add(key);
      foreach (var key in dropped) motions.Remove(key);
      foreach (var target in targets) {
        if (target == null) continue;
        var key = target.Key == null ? "" : target.Key;
        Motion motion;
        if (!motions.TryGetValue(key, out motion)) {
          float initial = float.IsNaN(target.HeadingDeg) ? 0f : target.HeadingDeg;
          // A spawn anchor may hand us the real cursor as the start point; the
          // tween then runs cursor -> first real target in one Sync pass. A
          // spawn without a target simply appears at the sampled cursor (0 ms).
          bool fromAnchor = target.HasFrom && target.MotionMs > 0.0;
          double initialDuration = fromAnchor ? target.MotionMs : 0.0;
          motion = new Motion {
            FromX = target.HasFrom ? target.FromPoint.x : target.Point.x,
            FromY = target.HasFrom ? target.FromPoint.y : target.Point.y,
            ToX = target.Point.x, ToY = target.Point.y,
            StartMs = nowMs, DurationMs = initialDuration,
            X = target.HasFrom ? target.FromPoint.x : target.Point.x,
            Y = target.HasFrom ? target.FromPoint.y : target.Point.y,
            Animating = fromAnchor,
            Seq = target.Seq, SampleMs = target.SampleMs, Path = null,
            Heading = initial, HeadingFrom = initial, HeadingTo = initial, HeadingRestore = target.HeadingRestore,
            WriterHeading = target.HeadingDeg,
            Opacity = target.Opacity, OpacityFrom = target.Opacity, OpacityTo = target.Opacity,
            RemoveWhenHidden = target.RemoveWhenHidden
          };
          // Arrival restore for a spawned pointer: keep the travel heading while
          // the pointer travels, then fall back to the canonical tip the same way
          // a retarget does. Without this a spawn that is only ever synced once
          // would stay tilted for its whole lifetime.
          if (target.HeadingRestore && Math.Abs((double)initial) > 0.01) {
            motion.HeadingStartMs = nowMs;
            motion.HeadingDurationMs = initialDuration;
            motion.HeadingActive = true;
            motion.HeadingTail = false;
          }
          motions[key] = motion;
          continue;
        }
        if (target.SampleMs > 0.0 && motion.SampleMs > 0.0 && target.SampleMs < motion.SampleMs) continue;
        if (target.Seq > 0 && motion.Seq > 0 && target.Seq < motion.Seq) continue;
        double duration = target.MotionMs > 0.0 ? target.MotionMs : 0.0;
        bool moved = motion.ToX != target.Point.x || motion.ToY != target.Point.y;
        // The writer rewrites every row on every flush, so a pointer that did not
        // move comes back carrying the headingDeg of its last real travel. That
        // value is an echo, not news: applying it again would tilt a pointer that
        // had already restored to canonical, or cut its restore tail short, each
        // time any other agent touched the state file. Only a *changed* echo
        // describes travel we have not aimed at yet.
        bool newWriterHeading = !float.IsNaN(target.HeadingDeg) && !SameHeading(motion.WriterHeading, target.HeadingDeg);
        // The visible tween starts at the current rendered point, not at the
        // writer's previous target, so a mid-flight retarget derives its heading
        // from the motion itself. A NaN heading from the writer means "no
        // opinion" (release clears it) and must never yank the tip back.
        float headingTarget;
        if (moved) {
          headingTarget = HeadingFromPoint(motion.X, motion.Y, target.Point);
        } else if (newWriterHeading) {
          headingTarget = target.HeadingDeg;
        } else {
          headingTarget = motion.HeadingTo;
        }
        bool headingChanged = !SameHeading(motion.HeadingTo, headingTarget) || motion.HeadingRestore != target.HeadingRestore || (moved && target.HeadingRestore);
        bool opacityChanged = Math.Abs(motion.OpacityTo - target.Opacity) > 0.001f;
        if (moved) {
          motion.FromX = motion.X; motion.FromY = motion.Y;
          motion.ToX = target.Point.x; motion.ToY = target.Point.y;
          motion.StartMs = nowMs; motion.DurationMs = duration; motion.Animating = duration > 0.0;
          if (!motion.Animating) { motion.X = motion.ToX; motion.Y = motion.ToY; }
          motion.Path = (target.Path != null && target.Path.Count >= 2) ? target.Path : null;
          motion.PathStartMs = nowMs;
        }
        if (headingChanged) {
          motion.HeadingRestore = target.HeadingRestore;
          motion.HeadingFrom = float.IsNaN(motion.Heading) ? headingTarget : motion.Heading;
          motion.HeadingTo = headingTarget;
          motion.HeadingStartMs = nowMs;
          motion.HeadingDurationMs = motion.DurationMs > 0.0 ? motion.DurationMs : (target.MotionMs > 0.0 ? target.MotionMs : 0.0);
          motion.HeadingActive = true; motion.HeadingTail = false;
        }
        if (opacityChanged) {
          motion.OpacityFrom = motion.Opacity; motion.OpacityTo = target.Opacity;
          motion.OpacityStartMs = nowMs; motion.OpacityDurationMs = motion.DurationMs > 0.0 ? motion.DurationMs : (target.MotionMs > 0.0 ? target.MotionMs : 0.0);
          motion.OpacityActive = true;
        }
        if (target.RemoveWhenHidden) motion.RemoveWhenHidden = true;
        motion.Seq = target.Seq; motion.SampleMs = target.SampleMs;
        // Remember the echo we just saw so an unchanged re-send is not read as
        // new travel. NaN keeps the previous value: it means "no opinion".
        if (!float.IsNaN(target.HeadingDeg)) motion.WriterHeading = target.HeadingDeg;
      }
    }

    static bool SameHeading(float a, float b) {
      if (float.IsNaN(a) && float.IsNaN(b)) return true;
      if (float.IsNaN(a) || float.IsNaN(b)) return false;
      return Math.Abs(a - b) < 0.01f;
    }
    // Rotation that points the canonical tip along the visible travel vector.
    static float HeadingFromPoint(double fromX, double fromY, Native.Point to) {
      double degrees = Math.Atan2((double)to.y - fromY, (double)to.x - fromX) * 180.0 / Math.PI;
      return (float)(degrees - PointerFrame.CanonicalTipDeg);
    }
    static float LerpShortest(float a, float b, float t) {
      if (float.IsNaN(a)) return b;
      float d = b - a; while (d > 180f) d -= 360f; while (d < -180f) d += 360f;
      return a + d * t;
    }
    static void PolylineAt(IList<Native.Point> path, double t, out double x, out double y) {
      if (path == null || path.Count == 0) { x = 0.0; y = 0.0; return; }
      if (path.Count == 1 || t <= 0.0) { x = path[0].x; y = path[0].y; return; }
      if (t >= 1.0) { int n = path.Count - 1; x = path[n].x; y = path[n].y; return; }
      double total = 0.0;
      for (int i = 1; i < path.Count; i++) { double dx = path[i].x - path[i - 1].x, dy = path[i].y - path[i - 1].y; total += Math.Sqrt(dx * dx + dy * dy); }
      if (total <= 0.0) { x = path[0].x; y = path[0].y; return; }
      double want = total * t, acc = 0.0;
      for (int i = 1; i < path.Count; i++) {
        double dx = path[i].x - path[i - 1].x, dy = path[i].y - path[i - 1].y; double seg = Math.Sqrt(dx * dx + dy * dy);
        if (acc + seg >= want) { double f = seg <= 0.0 ? 0.0 : (want - acc) / seg; x = path[i - 1].x + dx * f; y = path[i - 1].y + dy * f; return; }
        acc += seg;
      }
      x = path[path.Count - 1].x; y = path[path.Count - 1].y;
    }

    // Move every active tween to nowMs. Linear easing keeps a frame's position
    // exactly proportional to elapsed monotonic time, which is what the timing
    // tests assert; finishing snaps precisely onto the target (no overshoot).
    internal bool Advance(double nowMs) {
      var expired = new List<string>();
      foreach (var pair in motions) {
        var key = pair.Key;
        var motion = pair.Value;
        if (motion.Animating) {
          double t = motion.DurationMs <= 0.0 ? 1.0 : (nowMs - motion.StartMs) / motion.DurationMs;
          if (t >= 1.0) { motion.X = motion.ToX; motion.Y = motion.ToY; motion.Animating = false; }
          else {
            if (t < 0.0) t = 0.0;
            motion.X = motion.FromX + (motion.ToX - motion.FromX) * t;
            motion.Y = motion.FromY + (motion.ToY - motion.FromY) * t;
          }
        }
        if (motion.Animating && motion.Path != null && motion.Path.Count >= 2) {
          double pt = motion.DurationMs <= 0.0 ? 1.0 : (nowMs - motion.PathStartMs) / motion.DurationMs;
          double px, py; PolylineAt(motion.Path, pt, out px, out py); motion.X = px; motion.Y = py;
        }
        if (motion.HeadingActive) {
          double ht = motion.HeadingDurationMs <= 0.0 ? 1.0 : (nowMs - motion.HeadingStartMs) / motion.HeadingDurationMs;
          if (ht >= 1.0) {
            motion.Heading = motion.HeadingTo; motion.HeadingActive = false;
            if (motion.HeadingRestore && Math.Abs(motion.Heading) > 0.01f && !motion.HeadingTail) {
              motion.HeadingFrom = motion.Heading; motion.HeadingTo = 0f;
              motion.HeadingStartMs = nowMs;
              motion.HeadingDurationMs = Math.Min(120.0, motion.DurationMs > 0.0 ? motion.DurationMs : DurationMs);
              motion.HeadingActive = true; motion.HeadingTail = true;
            }
          } else { if (ht < 0.0) ht = 0.0; motion.Heading = LerpShortest(motion.HeadingFrom, motion.HeadingTo, (float)ht); }
        }
        if (motion.OpacityActive) {
          double ot = motion.OpacityDurationMs <= 0.0 ? 1.0 : (nowMs - motion.OpacityStartMs) / motion.OpacityDurationMs;
          if (ot >= 1.0) { motion.Opacity = motion.OpacityTo; motion.OpacityActive = false; }
          else { if (ot < 0.0) ot = 0.0; motion.Opacity = (float)(motion.OpacityFrom + (motion.OpacityTo - motion.OpacityFrom) * ot); }
        }
        // Release anchors disappear by themselves once tween and fade are done;
        // the writer may keep the row until its sweep without leaving a ghost.
        if (motion.RemoveWhenHidden && !motion.Animating && !motion.HeadingActive && !motion.OpacityActive && motion.Opacity <= 0.001f)
          expired.Add(key);
      }
      foreach (var key in expired) motions.Remove(key);
      return expired.Count > 0;
    }

    internal bool TryGet(string key, out double x, out double y) {
      Motion motion;
      if (key != null && motions.TryGetValue(key, out motion)) { x = motion.X; y = motion.Y; return true; }
      x = 0.0; y = 0.0; return false;
    }
    internal bool TryGetHeading(string key, out float headingDeg) {
      Motion motion;
      if (key != null && motions.TryGetValue(key, out motion)) { headingDeg = motion.Heading; return true; }
      headingDeg = float.NaN; return false;
    }
    internal bool TryGetOpacity(string key, out float opacity) {
      Motion motion;
      if (key != null && motions.TryGetValue(key, out motion)) { opacity = motion.Opacity; return true; }
      opacity = 1f; return false;
    }
  }

  internal sealed class MultiPointerFrame : Form {
    // Frames are scheduled from a dedicated thread against an absolute
    // monotonic deadline, not a WinForms Timer. WinForms quantises Interval to
    // the ~15.6 ms system tick (Interval=16 can fire near 31 ms) and the
    // full-screen GDI blit is costly, so the real rate is read from the trace
    // instead of assumed. One pending flag coalesces UI dispatch: a slow blit
    // never builds a backlog, and a missed slot is skipped, never replayed.
    const double FrameIntervalMs = 1000.0 / 60.0;

    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint period);
    [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint period);

    readonly string statePath, logPath, tracePath;
    readonly Rectangle screen;
    readonly bool allowCapture;
    readonly PointerAnchorResolver anchorResolver = new PointerAnchorResolver();
    readonly MultiPointerAnimator animator = new MultiPointerAnimator();
    readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
    readonly ManualResetEventSlim wake = new ManualResetEventSlim(false);
    readonly UTF8Encoding traceEncoding = new UTF8Encoding(false);
    List<PointerVisual> targetVisuals = new List<PointerVisual>();
    IntPtr dc, dib;
    Bitmap surface;
    bool loggedFirstPresent;
    int refreshLogCount;
    DateTime lastWrite = DateTime.MinValue;
    Thread clockThread;
    volatile bool closed;
    int framePending;
    int frameErrorCount;
    int frameSeq;
    // Diagnostic for take-02: bumped only when RefreshTargets actually swaps in a
    // new target set (state file changed). A trace record whose coordinates stay
    // put while stateVersion is flat proves the producer wrote nothing new; a
    // rising stateVersion with identical coordinates proves it rewrote the same
    // targets. Either way it is upstream of the overlay, not a present stall.
    int stateVersion;
    bool traceStarted;
    bool layerVisible;
    bool presentDirty;
    bool highResolutionPeriod;

    internal MultiPointerFrame(string statePath, string logPath) {
      this.statePath = statePath;
      this.logPath = logPath;
      tracePath = Environment.GetEnvironmentVariable("DSH_MULTI_POINTER_FRAME_TRACE");
      screen = SystemInformation.VirtualScreen;
      allowCapture = Environment.GetEnvironmentVariable("DSH_MULTI_POINTER_CAPTURE") == "1";
      AutoScaleMode = AutoScaleMode.None;
      FormBorderStyle = FormBorderStyle.None;
      ShowInTaskbar = false;
      TopMost = true;
      StartPosition = FormStartPosition.Manual;
      Bounds = new Rectangle(screen.X, screen.Y, screen.Width, screen.Height);
      dc = Native.CreateCompatibleDC(IntPtr.Zero);
      Shown += delegate {
        AppendLog(logPath, "overlay shown");
        Native.KeepOnTop(Handle);
        try { Tick(true); } catch (Exception error) { AppendLog(logPath, "first frame: " + error); }
        StartClock();
      };
      FormClosed += delegate { StopClock(); };
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams {
      get { var value = base.CreateParams; value.ExStyle |= 0x80000 | 0x20 | 0x80 | 0x08000000; return value; }
    }

    protected override void OnHandleCreated(EventArgs e) {
      base.OnHandleCreated(e);
      if (!allowCapture) Native.ApplyDisplayAffinity(this, false);
      Native.KeepOnTop(Handle);
      AppendLog(logPath, "handle ex=0x" + Native.GetWindowLong(Handle, -20).ToString("X8"));
    }

    internal static void AppendLog(string path, string message) {
      if (String.IsNullOrEmpty(path)) return;
      try { File.AppendAllText(path, DateTime.Now.ToString("o") + " " + message + Environment.NewLine, Encoding.UTF8); } catch { }
    }

    // Real cursor sample used for spawn/release anchors. Physical pixels in
    // per-monitor v2 awareness; failure is reported, never replaced by a fake
    // origin (no 0,0 / screen center / cached point).
    bool SampleCursor(out Native.Point point) {
      bool ok = Native.GetCursorPos(out point);
      if (!ok) AppendLog(logPath, "anchor: GetCursorPos failed err=" + Marshal.GetLastWin32Error());
      return ok;
    }

    static string FieldText(Dictionary<string, object> item, string key) {
      object value;
      return item != null && item.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
    }

    static bool Integer(Dictionary<string, object> item, string key, out int value) {
      value = 0;
      object raw;
      if (item == null || !item.TryGetValue(key, out raw) || raw == null) return false;
      try { value = Convert.ToInt32(raw); return true; } catch { return false; }
    }

    static Color Colour(string text, int index) {
      try {
        if (!String.IsNullOrEmpty(text) && text[0] == '#') return ColorTranslator.FromHtml(text);
        if (!String.IsNullOrEmpty(text)) return Color.FromName(text);
      } catch { }
      Color[] fallback = { Color.FromArgb(79,195,247), Color.FromArgb(255,183,77), Color.FromArgb(129,199,132),
                           Color.FromArgb(240,98,146), Color.FromArgb(186,104,200), Color.FromArgb(77,208,225),
                           Color.FromArgb(255,213,79), Color.FromArgb(161,136,127) };
      return fallback[Math.Abs(index) % fallback.Length];
    }

    // headingDeg from the writer is the real movement direction (atan2 in
    // screen degrees, x right / y down). Convert to the glyph rotation about
    // the tip so canonical (absent heading) is exactly the historical F1 shape.
    static float HeadingRotation(Dictionary<string, object> item) {
      double deg;
      if (!HasNum(item, "headingDeg", out deg)) return float.NaN;
      if (double.IsNaN(deg)) return float.NaN;
      return (float)(deg - PointerFrame.CanonicalTipDeg);
    }

    // Local JSON field readers so this class stays independent of AuditFrame's
    // private helpers (it must not depend on the audit overlay's internals).
    static bool HasNum(Dictionary<string, object> item, string key, out double value) {
      value = 0.0;
      object raw;
      if (item == null || !item.TryGetValue(key, out raw) || raw == null) return false;
      try { value = Convert.ToDouble(raw, System.Globalization.CultureInfo.InvariantCulture); return true; } catch { return false; }
    }
    static double Num(Dictionary<string, object> item, string key, double fallback) {
      double value;
      return HasNum(item, key, out value) ? value : fallback;
    }
    static bool Flag(Dictionary<string, object> item, string key, bool fallback) {
      object raw;
      if (item == null || !item.TryGetValue(key, out raw) || raw == null) return fallback;
      if (raw is bool) return (bool)raw;
      try { return Convert.ToBoolean(raw); } catch { return fallback; }
    }

    static IList<Native.Point> PathPoints(Dictionary<string, object> item) {
      object raw;
      if (item == null || !item.TryGetValue("path", out raw) || raw == null) return null;
      var list = raw as System.Collections.IList;
      if (list == null) return null;
      var points = new List<Native.Point>();
      foreach (var entry in list) {
        var point = entry as Dictionary<string, object>;
        if (point == null) continue;
        int px, py;
        if (Integer(point, "x", out px) && Integer(point, "y", out py)) points.Add(new Native.Point(px, py));
      }
      return points.Count >= 2 ? points : null;
    }

    void StartClock() {
      try { timeBeginPeriod(1); highResolutionPeriod = true; } catch { highResolutionPeriod = false; }
      closed = false;
      clockThread = new Thread(ClockLoop) { IsBackground = true, Name = "multi-pointer-clock" };
      clockThread.Start();
    }

    void StopClock() {
      closed = true;
      try { wake.Set(); } catch { }
      var thread = clockThread;
      clockThread = null;
      if (thread != null) { try { thread.Join(250); } catch { } }
      if (highResolutionPeriod) { highResolutionPeriod = false; try { timeEndPeriod(1); } catch { } }
    }

    // Absolute-deadline loop. Wait until the next 60 Hz slot on the monotonic
    // clock, then ask the UI thread for one frame. If a slot is missed while the
    // UI is busy, jump the next deadline to now+interval so frames never replay
    // in a burst; positions stay correct because the animator reads absolute
    // time, not a per-frame delta.
    void ClockLoop() {
      double next = clock.Elapsed.TotalMilliseconds;
      while (!closed) {
        double now = clock.Elapsed.TotalMilliseconds;
        double wait = next - now;
        // A blocking ManualResetEventSlim.Wait / WinForms timer in this range
        // was measured to wake far too late (~24.7 ms for a 16 ms request), so
        // wait coarsely with Thread.Sleep (honours timeBeginPeriod(1): ~1.3 ms
        // granularity) up to ~1.5 ms before the deadline, then spin with
        // Thread.Yield for the final approach. Benchmarked on a 2560x1440
        // desktop: median/p95 interval = 16.667 ms, max 16.69 ms at 60 Hz.
        int coarse;
        if (PacerSleepMs(wait, out coarse)) {
          try { Thread.Sleep(coarse); } catch { }
          continue;
        }
        if (PacerSpin(wait)) { Thread.Yield(); continue; }
        RequestFrame();
        next += FrameIntervalMs;
        now = clock.Elapsed.TotalMilliseconds;
        if (next < now) next = now + FrameIntervalMs;
      }
    }

    // Pure pacing policy, split out so the offline timing regression can
    // exercise the exact same decisions the clock loop makes. Coarse wait
    // (Thread.Sleep, ~1.3 ms granularity under timeBeginPeriod(1)) down to
    // ~1.5 ms before the deadline, then spin with Thread.Yield for the final
    // approach; anything inside ~0.05 ms fires immediately. Keeping this pure
    // also documents why MRE.Wait or a WinForms timer is not used here.
    internal static bool PacerSleepMs(double wait, out int ms) {
      ms = 0;
      if (wait <= 2.0) return false;
      int coarse = (int)Math.Floor(wait - 1.5);
      if (coarse > 0) { ms = coarse; return true; }
      return false;
    }

    internal static bool PacerSpin(double wait) { return wait > 0.05 && wait <= 2.0; }

    void RequestFrame() {
      if (closed || !IsHandleCreated) return;
      if (Interlocked.Exchange(ref framePending, 1) == 1) return; // a frame is already queued
      try {
        BeginInvoke((MethodInvoker)delegate {
          Interlocked.Exchange(ref framePending, 0);
          try { Tick(false); } catch (Exception error) {
            if (frameErrorCount++ < 3 || (frameErrorCount % 300) == 0)
              AppendLog(logPath, "frame: " + error);
          }
        });
      } catch { Interlocked.Exchange(ref framePending, 0); }
    }

    // One scheduler step: re-read the state file only when it changed, advance
    // the tweens to the current monotonic time, and pay for a full-screen
    // present only when something moved or the visible set changed. A settled
    // overlay therefore costs no GDI work until the next state change.
    void Tick(bool force) {
      if (IsDisposed || !IsHandleCreated) return;
      double now = clock.Elapsed.TotalMilliseconds;
      bool changed = RefreshTargets(force, now);
      if (targetVisuals.Count == 0) {
        animator.Clear();
        if (layerVisible) { HideLayer(); layerVisible = false; }
        return;
      }
      // Expiry inside Advance removes a released marker; that removal still
      // needs one present so the last painted frame cannot stay on screen.
      bool expired = animator.Advance(now);
      if (!changed && !expired && !animator.AnyAnimating && !presentDirty) return;
      Present(BuildRendered(), now);
      presentDirty = false;
    }

    bool RefreshTargets(bool force, double now) {
      try {
        if (!File.Exists(statePath)) {
          if (targetVisuals.Count == 0) return false;
          targetVisuals = new List<PointerVisual>();
          animator.Clear();
          anchorResolver.Clear();
          presentDirty = true;
          stateVersion++;
          return true;
        }
        var info = new FileInfo(statePath);
        if (!force && info.LastWriteTimeUtc == lastWrite) return false;
        lastWrite = info.LastWriteTimeUtc;
        var raw = File.ReadAllText(statePath, Encoding.UTF8);
        var data = new CommandJson().Deserialize<Dictionary<string, object>>(raw);
        object rawPointers = null;
        var items = data != null && data.TryGetValue("pointers", out rawPointers) ? rawPointers as System.Collections.IList : null;
        var targets = new List<MultiPointerAnimator.PointerTarget>();
        int index = 0;
        if (items == null || items.Count == 0) anchorResolver.Clear();
        if (items != null) {
          foreach (var rawItem in items) {
            var item = rawItem as Dictionary<string, object>;
            if (item == null) continue;
            var id = FieldText(item, "id");
            if (String.IsNullOrEmpty(id)) continue;
            var epoch = FieldText(item, "epoch");
            // Lifetime/epoch isolation: the same agent id reused by a new
            // lifetime must not inherit the previous pointer's motion state.
            var key = String.IsNullOrEmpty(epoch) ? id : id + "\u001f" + epoch;
            var name = FieldText(item, "label");
            int x, y;
            bool hasX = Integer(item, "x", out x);
            bool hasY = Integer(item, "y", out y);
            bool hasPoint = hasX && hasY;
            var point = hasPoint ? new Native.Point(x, y) : new Native.Point(0, 0);
            var colour = Colour(FieldText(item, "color"), index);
            float headingRot = HeadingRotation(item);
            float opacity = (float)Math.Max(0.0, Math.Min(1.0, Num(item, "opacity", 1.0)));
            double motionMs = Num(item, "motionMs", 200.0);
            double sampleMs = Num(item, "sampleMs", 0.0);
            long seq = (long)Num(item, "seq", 0.0);
            bool headingRestore = Flag(item, "headingRestore", true);
            IList<Native.Point> path = PathPoints(item);
            targets.Add(new MultiPointerAnimator.PointerTarget {
              Id = id, Lifetime = epoch, Key = key, Name = name, Colour = colour, Index = index,
              Point = point, HasPoint = hasPoint, CursorAnchor = FieldText(item, "cursorAnchor"),
              HeadingDeg = headingRot, HeadingRestore = headingRestore, Opacity = opacity,
              MotionMs = motionMs, SampleMs = sampleMs, Seq = seq, Path = path
            });
            index++;
          }
        }
        // Resolve spawn/release anchors with one shared real GetCursorPos sample;
        // failures hide the pointer (fail closed) and leave a log line.
        var resolved = anchorResolver.Resolve(targets, SampleCursor, delegate (string key) { return animator.ContainsKey(key); }, delegate (string message) { AppendLog(logPath, message); });
        var visuals = new List<PointerVisual>();
        foreach (var target in resolved) {
          var monitor = Native.DisplayFromPoint(target.Point);
          visuals.Add(new PointerVisual(target.Key, target.Name, target.Colour, target.Point, monitor, Native.ScaleForDisplay(monitor), target.HeadingDeg, target.Opacity));
        }
        if (refreshLogCount++ < 2 || (refreshLogCount % 300) == 0)
          AppendLog(logPath, "refresh items=" + (items == null ? -1 : items.Count) + " resolved=" + resolved.Count + " visuals=" + visuals.Count + " allowCapture=" + allowCapture);
        // Reconcile before swapping the visible set: a new id snaps to its
        // target, a moved id tweens from where it is, a vanished id is dropped.
        animator.Sync(resolved, now);
        targetVisuals = visuals;
        presentDirty = true;
        stateVersion++;
        return true;
      } catch (Exception error) {
        AppendLog(logPath, "state: " + error);
        return false;
      }
    }

    // Build this frame's visuals from the animated positions, resolving the
    // monitor and DPI from the point actually drawn so a pointer crossing a
    // seam is clipped by the monitor it is over at that instant.
    List<PointerVisual> BuildRendered() {
      var list = new List<PointerVisual>(targetVisuals.Count);
      foreach (var target in targetVisuals) {
        double x, y;
        // A released marker whose tween/fade already expired has no motion any
        // more; skip it instead of resurrecting it at its last written point.
        if (!animator.TryGet(target.Key, out x, out y)) continue;
        var point = new Native.Point((int)Math.Round(x), (int)Math.Round(y));
        var monitor = Native.DisplayFromPoint(point);
        float heading; if (!animator.TryGetHeading(target.Key, out heading)) heading = float.NaN;
        float opacity; if (!animator.TryGetOpacity(target.Key, out opacity)) opacity = target.Opacity;
        list.Add(new PointerVisual(target.Key, target.Name, target.Color, point, monitor, Native.ScaleForDisplay(monitor), heading, opacity));
      }
      return list;
    }

    // Lazily create the one persistent DIB-backed surface. The Bitmap wraps the
    // DIB bits, so GDI+ paints directly into the memory later handed to
    // UpdateLayeredWindow and the HBITMAP stays selected in the memory DC for
    // the overlay's lifetime. Every frame reuses it instead of allocating a new
    // full-screen Bitmap and copying it out with GetHbitmap (measured ~13.5 ms
    // vs ~1.7 ms per frame on 2560x1440).
    bool EnsureSurface() {
      if (surface != null) return true;
      if (dc == IntPtr.Zero) {
        AppendLog(logPath, "surface: compatible DC unavailable");
        return false;
      }
      IntPtr handle = IntPtr.Zero;
      try {
        IntPtr bits;
        handle = Native.CreateArgbDib(screen.Width, screen.Height, out bits);
        if (handle == IntPtr.Zero || bits == IntPtr.Zero) {
          if (handle != IntPtr.Zero) Native.DeleteObject(handle);
          AppendLog(logPath, "surface: CreateDIBSection failed err=" + Marshal.GetLastWin32Error());
          return false;
        }
        var bitmap = new Bitmap(screen.Width, screen.Height, screen.Width * 4, PixelFormat.Format32bppPArgb, bits);
        if (Native.SelectObject(dc, handle) == IntPtr.Zero) {
          // The DC always starts with a 1x1 bitmap selected, so a zero return
          // here is a real failure: free both the GDI+ wrapper and the DIB.
          bitmap.Dispose();
          Native.DeleteObject(handle);
          AppendLog(logPath, "surface: SelectObject failed err=" + Marshal.GetLastWin32Error());
          return false;
        }
        dib = handle;
        surface = bitmap;
        return true;
      } catch (Exception error) {
        if (handle != IntPtr.Zero && handle != dib) { try { Native.DeleteObject(handle); } catch { } }
        AppendLog(logPath, "surface: " + error);
        return false;
      }
    }

    void Present(IList<PointerVisual> visuals, double monoMs) {
      if (!EnsureSurface()) throw new InvalidOperationException("multi-pointer surface unavailable");
      using (var g = Graphics.FromImage(surface)) {
        PointerFrame.DrawVisualsInto(g, visuals, screen);
      }
      var destination = new Native.Point(screen.X, screen.Y);
      var origin = new Native.Point(0, 0);
      var size = new Native.Size(screen.Width, screen.Height);
      var blend = new Native.Blend { op = 0, flags = 0, alpha = 255, format = 1 };
      if (!Native.UpdateLayeredWindow(Handle, IntPtr.Zero, ref destination, ref size, dc, ref origin, 0, ref blend, 2))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Could not present multi-pointer overlay");
      if (!Visible) Show();
      Native.KeepOnTop(Handle);
      layerVisible = true;
      TraceFrame(visuals, monoMs);
      // No per-frame log line: at 60 Hz the synchronous AppendAllText plus a
      // GetWindowLong were a measurable slice of the frame budget. Key events
      // (shown/first frame/hide/errors) are still logged.
      if (!loggedFirstPresent) { loggedFirstPresent = true; AppendLog(logPath, "first present visuals=" + visuals.Count); }
    }

    // Optional proof-of-present: when DSH_MULTI_POINTER_FRAME_TRACE names a
    // writable path, append one JSONL record per successful UpdateLayeredWindow
    // carrying the monotonic time, wall time, active count and the positions
    // actually drawn. The first record truncates the file so a run starts clean;
    // trace IO never breaks the overlay or touches the real cursor.
    void TraceFrame(IList<PointerVisual> visuals, double monoMs) {
      if (String.IsNullOrEmpty(tracePath)) return;
      try {
        var line = TraceLine(frameSeq, monoMs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), visuals);
        // Extra diagnostic field only on the live trace (the pure TraceLine schema
        // the offline test pins is unchanged): a stalled upstream target set.
        line = "{\"stateVersion\":" + stateVersion + "," + line.Substring(1);
        if (!traceStarted) { File.WriteAllText(tracePath, line, traceEncoding); traceStarted = true; }
        else { File.AppendAllText(tracePath, line, traceEncoding); }
        frameSeq++;
      } catch { }
    }

    // Pure JSONL record builder, exposed so an offline test can pin the schema
    // the demo script parses ("seq","tMs","wallMs","active", optional "visuals").
    internal static string TraceLine(int seq, double monoMs, long wallMs, IList<PointerVisual> visuals) {
      var ci = System.Globalization.CultureInfo.InvariantCulture;
      var builder = new StringBuilder();
      builder.Append('{').Append('"').Append("seq").Append('"').Append(':').Append(seq);
      builder.Append(',').Append('"').Append("tMs").Append('"').Append(':').Append(monoMs.ToString("0.###", ci));
      builder.Append(',').Append('"').Append("wallMs").Append('"').Append(':').Append(wallMs);
      int active = visuals == null ? 0 : visuals.Count;
      builder.Append(',').Append('"').Append("active").Append('"').Append(':').Append(active);
      if (visuals != null && visuals.Count > 0) {
        builder.Append(',').Append('"').Append("visuals").Append('"').Append(':').Append('[');
        for (int i = 0; i < visuals.Count; i++) {
          if (i > 0) builder.Append(',');
          var visual = visuals[i];
          var id = visual.Key == null ? "" : visual.Key.Replace((char)92, (char)47).Replace((char)34, (char)39);
          builder.Append('{').Append('"').Append("id").Append('"').Append(':').Append('"').Append(id).Append('"');
          builder.Append(',').Append('"').Append("x").Append('"').Append(':').Append(visual.Point.x);
          builder.Append(',').Append('"').Append("y").Append('"').Append(':').Append(visual.Point.y);
          builder.Append('}');
        }
        builder.Append(']');
      }
      builder.Append('}').Append((char)10);
      return builder.ToString();
    }

    void HideLayer() {
      if (Visible) Hide();
    }

    protected override void Dispose(bool disposing) {
      StopClock();
      if (surface != null) {
        surface.Dispose();
        surface = null;
      }
      // Delete the DC before the DIB: a bitmap still selected into a DC cannot
      // be deleted, and DeleteDC releases the selection for us. (SelectObject
      // with a NULL handle is not a valid deselect and is deliberately avoided.)
      if (dc != IntPtr.Zero) { Native.DeleteDC(dc); dc = IntPtr.Zero; }
      if (dib != IntPtr.Zero) { Native.DeleteObject(dib); dib = IntPtr.Zero; }
      base.Dispose(disposing);
    }
  }

  internal sealed class Frame : Form {
    readonly Rectangle rectangle;
    bool remoteVisible;
    IntPtr dc, bitmap, previous;
    internal Frame(Rectangle bounds, string text, string position, bool visible, string stopShortcut = "", float dpiScale = 0f) {
      remoteVisible=visible;rectangle = bounds; AutoScaleMode=AutoScaleMode.None;FormBorderStyle = FormBorderStyle.None;
      ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
      Bounds=bounds;
      using (var image = Draw(bounds.Width, bounds.Height, text, position, stopShortcut, dpiScale)) bitmap = image.GetHbitmap(Color.FromArgb(0));
      dc = Native.CreateCompatibleDC(IntPtr.Zero); previous = Native.SelectObject(dc, bitmap);
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get { var value = base.CreateParams; value.ExStyle |= 0x80000 | 0x20 | 0x80 | 0x08000000; return value; }
    }
    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); SetRemoteVisible(remoteVisible); }
    internal void SetRemoteVisible(bool visible) {remoteVisible=visible;Native.ApplyDisplayAffinity(this,visible);}
    internal Rectangle DisplayBounds {get{return rectangle;}}
    internal bool CaptureExcluded { get { uint affinity;return Native.GetWindowDisplayAffinity(Handle,out affinity)&&affinity==0x11; } }
    internal bool ClickThrough {get{return (Native.GetWindowLong(Handle,-20)&0x08080020)==0x08080020;}}
    internal void Present(byte alpha) {
      if (IsDisposed) return;
      var destination = new Native.Point(rectangle.X, rectangle.Y); var origin = new Native.Point(0,0);
      var size = new Native.Size(rectangle.Width,rectangle.Height);
      var blend = new Native.Blend { op=0, flags=0, alpha=alpha, format=1 };
      if (!Native.UpdateLayeredWindow(Handle, IntPtr.Zero, ref destination, ref size, dc, ref origin, 0, ref blend, 2)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Could not present takeover overlay");
    }
    internal static Bitmap Draw(int width, int height, string text, string position) {
      return Draw(width, height, text, position, "", 0f);
    }
    internal static Bitmap Draw(int width, int height, string text, string position, string stopShortcut = "", float dpiScale = 0f) {
      var image = new Bitmap(width,height,PixelFormat.Format32bppPArgb);
      using (var g = Graphics.FromImage(image)) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        // ClearType needs an opaque surface; layered windows need grayscale text.
        g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        g.Clear(Color.Transparent);
        float scale = dpiScale > 0f ? dpiScale : Math.Max(1f, Math.Min(2f, width/1920f));
        // Edge glow: a bright core line that reads on dark wallpapers, then a
        // DeepSeek-blue falloff that reads on light ones.
        g.CompositingMode = CompositingMode.SourceCopy;
        int core = (int)Math.Round(2*scale), glow = core+(int)Math.Round(18*scale);
        for (int i=0;i<glow;i++) {
          var color = i<core ? Color.FromArgb(235,150,184,255) : Color.FromArgb((int)(175*Math.Pow(1-(i-core)/(double)(glow-core),2.2)),77,124,254);
          using (var pen = new Pen(color,1)) g.DrawRectangle(pen,i,i,width-2*i-1,height-2*i-1);
        }
        g.CompositingMode = CompositingMode.SourceOver;
        // Status pill: live dot, the user's text, then an Esc (or Esc / custom) keycap.
        using (var font = new Font("Microsoft YaHei UI",10.5f*scale,FontStyle.Regular,GraphicsUnit.Point))
        using (var keyFont = new Font("Segoe UI",8.5f*scale,FontStyle.Bold,GraphicsUnit.Point))
        using (var hintFont = new Font("Microsoft YaHei UI",9.5f*scale,FontStyle.Regular,GraphicsUnit.Point))
        using (var measure = new StringFormat(StringFormat.GenericTypographic) { FormatFlags = StringFormatFlags.NoWrap | StringFormatFlags.MeasureTrailingSpaces }) {
          string hint = Words.Get("stopHint");
          string keyLabel = String.IsNullOrEmpty(stopShortcut) ? "Esc" : "Esc / " + stopShortcut;
          float pillHeight=40*scale, padding=16*scale, dot=8*scale, gap=10*scale, keyHeight=20*scale;
          float keyWidth=g.MeasureString(keyLabel,keyFont,PointF.Empty,measure).Width+12*scale;
          float hintWidth=g.MeasureString(hint,hintFont,PointF.Empty,measure).Width;
          float fixedWidth=padding*2+dot+gap*3+1+keyWidth+6*scale+hintWidth;
          float textWidth=Math.Min(g.MeasureString(text,font,PointF.Empty,measure).Width,Math.Max(48*scale,width-48*scale-fixedWidth));
          float pillWidth=fixedWidth+textWidth;
          float x=(float)Math.Round((width-pillWidth)/2), y=position=="bottom"?height-pillHeight-24*scale:24*scale, middle=y+pillHeight/2;
          for (int i=1;i<=6;i++)
            using (var shadow=Rounded(new RectangleF(x-i,y-i+2*scale,pillWidth+2*i,pillHeight+2*i),pillHeight/2+i))
            using (var brush=new SolidBrush(Color.FromArgb(9,0,0,0))) g.FillPath(brush,shadow);
          using (var shape=Rounded(new RectangleF(x,y,pillWidth,pillHeight),pillHeight/2)) {
            using (var fill=new SolidBrush(Color.FromArgb(238,20,22,28))) g.FillPath(fill,shape);
            using (var outline=new Pen(Color.FromArgb(40,255,255,255),1)) g.DrawPath(outline,shape);
          }
          float cursor=x+padding;
          using (var halo=new SolidBrush(Color.FromArgb(64,86,134,254))) g.FillEllipse(halo,cursor-3*scale,middle-dot/2-3*scale,dot+6*scale,dot+6*scale);
          using (var fill=new SolidBrush(Color.FromArgb(255,86,134,254))) g.FillEllipse(fill,cursor,middle-dot/2,dot,dot);
          cursor+=dot+gap;
          using (var brush=new SolidBrush(Color.FromArgb(255,245,247,250)))
          using (var format=new StringFormat(StringFormat.GenericTypographic) { LineAlignment=StringAlignment.Center, Trimming=StringTrimming.EllipsisCharacter, FormatFlags=StringFormatFlags.NoWrap })
            g.DrawString(text,font,brush,new RectangleF(cursor,y,textWidth+1,pillHeight),format);
          cursor+=textWidth+gap;
          using (var line=new Pen(Color.FromArgb(56,255,255,255),1)) g.DrawLine(line,cursor,middle-8*scale,cursor,middle+8*scale);
          cursor+=1+gap;
          var key=new RectangleF(cursor,middle-keyHeight/2,keyWidth,keyHeight);
          using (var shape=Rounded(key,5*scale)) {
            using (var fill=new SolidBrush(Color.FromArgb(34,255,255,255))) g.FillPath(fill,shape);
            using (var outline=new Pen(Color.FromArgb(64,255,255,255),1)) g.DrawPath(outline,shape);
          }
          using (var brush=new SolidBrush(Color.FromArgb(255,245,247,250)))
          using (var format=new StringFormat(StringFormat.GenericTypographic) { Alignment=StringAlignment.Center, LineAlignment=StringAlignment.Center })
            g.DrawString(keyLabel,keyFont,brush,key,format);
          cursor+=keyWidth+6*scale;
          using (var brush=new SolidBrush(Color.FromArgb(200,245,247,250)))
          using (var format=new StringFormat(StringFormat.GenericTypographic) { LineAlignment=StringAlignment.Center, FormatFlags=StringFormatFlags.NoWrap })
            g.DrawString(hint,hintFont,brush,new RectangleF(cursor,y,hintWidth+2,pillHeight),format);
        }
      }
      return image;
    }
    internal static GraphicsPath Rounded(RectangleF r,float radius) {
      var p=new GraphicsPath(); float d=radius*2;
      p.AddArc(r.X,r.Y,d,d,180,90);p.AddArc(r.Right-d,r.Y,d,d,270,90);p.AddArc(r.Right-d,r.Bottom-d,d,d,0,90);p.AddArc(r.X,r.Bottom-d,d,d,90,90);p.CloseFigure();return p;
    }
    protected override void Dispose(bool disposing) {
      if (dc!=IntPtr.Zero) { Native.SelectObject(dc,previous); Native.DeleteObject(bitmap); Native.DeleteDC(dc); dc=IntPtr.Zero; }
      base.Dispose(disposing);
    }
  }
}
