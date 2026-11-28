// Offline pixel regression assertions for the multi-pointer drawing primitives.
// Compiled together with scripts/windows-takeover.cs by tests/desktopPointerRender.test.ts.
// This file creates no window and synthesizes no input: it only calls
// PointerFrame.DrawVisuals -> Bitmap and inspects the returned pixels.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace DshTakeover {
  // Public entry point. Run() is parameterless and returns a string; a passing run
  // returns "POINTER_RENDER_OK <caseCount>", any failed assertion throws.
  public static class PointerRenderTests {
    public static string Run() {
      int cases = 0;
      EmptyFrameIsTransparent();          cases++;
      NullVisualListIsTransparent();      cases++;
      VisualOutsideScreenIsIgnored();     cases++;
      VisualOutsideMonitorIsIgnored();    cases++;
      RightAndBottomAreOpenBoundaries();  cases++;
      CornerAnchorStaysAtTheTip();        cases++;
      NegativeOriginKeepsSamePixel();     cases++;
      MixedDpiSameFrameScales();          cases++;
      SamePointLabelsExpand();            cases++;
      CrossMonitorSeamFoldsInward();      cases++;
      ZeroSizeMonitorSkipsVisual();       cases++;
      LongLabelStaysInsideNarrowMonitor();cases++;
      NarrowScreenArrowKeepsTip();        cases++;
      ShortScreenDropsLabel();            cases++;
      TriangleHasWhiteBloomAndTranslucentBody(); cases++;
      return "POINTER_RENDER_OK " + cases.ToString();
    }

    // ---------------------------------------------------------------------
    // Assertions
    // ---------------------------------------------------------------------

    static void Require(bool condition, string message) {
      if (!condition) throw new InvalidOperationException("pointer render assertion failed: " + message);
    }

    // Reads a Format32bppPArgb bitmap once into a flat array and exposes
    // straight-alpha pixels. Kept tolerant: edges are anti-aliased so tests
    // aggregate regions instead of depending on exact glyph bytes.
    sealed class Frame {
      internal readonly int W, H;
      readonly int[] raw; // premultiplied ARGB, exactly as stored (PArgb)
      internal Frame(Bitmap source) {
        W = source.Width; H = source.Height;
        var data = source.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, PixelFormat.Format32bppPArgb);
        raw = new int[W * H];
        try { Marshal.Copy(data.Scan0, raw, 0, raw.Length); }
        finally { source.UnlockBits(data); }
      }
      internal int AlphaAt(int x, int y) { return (raw[y * W + x] >> 24) & 255; }
      internal Color At(int x, int y) {
        int v = raw[y * W + x];
        int a = (v >> 24) & 255;
        int r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
        if (a > 0 && a < 255) {
          r = Math.Min(255, (r * 255 + a / 2) / a);
          g = Math.Min(255, (g * 255 + a / 2) / a);
          b = Math.Min(255, (b * 255 + a / 2) / a);
        }
        return Color.FromArgb(a, r, g, b);
      }
      internal bool HasFullyTransparent() {
        for (int i = 0; i < raw.Length; i++) if (((raw[i] >> 24) & 255) != 0) return false;
        return true;
      }
    }

    static Frame Render(IList<PointerVisual> visuals, Rectangle screen) {
      using (var bmp = PointerFrame.DrawVisuals(visuals, screen)) {
        Require(bmp != null, "DrawVisuals returned null");
        Require(bmp.Width == screen.Width && bmp.Height == screen.Height,
          "bitmap " + bmp.Width + "x" + bmp.Height + " must equal screen " + screen.Width + "x" + screen.Height);
        Require(bmp.PixelFormat == PixelFormat.Format32bppPArgb,
          "bitmap must stay Format32bppPArgb, was " + bmp.PixelFormat.ToString());
        return new Frame(bmp);
      }
    }

    static PointerVisual Visual(string key, string name, Color color, int x, int y, Rectangle monitor, float scale) {
      return new PointerVisual(key, name, color, new Native.Point(x, y), monitor, scale);
    }

    static bool Near(Color a, Color target, int tol) {
      return Math.Abs(a.R - target.R) <= tol && Math.Abs(a.G - target.G) <= tol && Math.Abs(a.B - target.B) <= tol;
    }

    // Counts "solid" (opaque-ish) pixels in a region. Used for footprint/extent,
    // not for glyph identity, so it is independent of font hinting.
    static int OpaqueCount(Frame f, Rectangle area) {
      int n = 0;
      int x0 = Math.Max(0, area.Left), y0 = Math.Max(0, area.Top);
      int x1 = Math.Min(f.W, area.Right), y1 = Math.Min(f.H, area.Bottom);
      for (int y = y0; y < y1; y++)
        for (int x = x0; x < x1; x++)
          if (f.AlphaAt(x, y) >= 200) n++;
      return n;
    }

    static int ColorCount(Frame f, Rectangle area, Color target, int tol) {
      int n = 0;
      int x0 = Math.Max(0, area.Left), y0 = Math.Max(0, area.Top);
      int x1 = Math.Min(f.W, area.Right), y1 = Math.Min(f.H, area.Bottom);
      for (int y = y0; y < y1; y++)
        for (int x = x0; x < x1; x++) {
          int a = f.AlphaAt(x, y);
          if (a >= 150 && Near(f.At(x, y), target, tol)) n++;
        }
      return n;
    }

    // Counts every pixel with any opacity at all (alpha > 0) inside area. Used to
    // prove that nothing -- not even an anti-aliased glow or stroke -- is painted
    // off a marker's own monitor.
    static int AlphaCount(Frame f, Rectangle area) {
      int n = 0;
      int x0 = Math.Max(0, area.Left), y0 = Math.Max(0, area.Top);
      int x1 = Math.Min(f.W, area.Right), y1 = Math.Min(f.H, area.Bottom);
      for (int y = y0; y < y1; y++)
        for (int x = x0; x < x1; x++)
          if (f.AlphaAt(x, y) > 0) n++;
      return n;
    }

    // Number of pixels whose straight-alpha colour differs by more than a small
    // tolerance. Frames compared here are either produced by the same draw path
    // (identical) or clearly different (a tag drawn), so a 4-level tolerance is
    // safe against anti-alias rounding.
    static int FrameDiff(Frame a, Frame b) {
      Require(a.W == b.W && a.H == b.H, "frame size mismatch in FrameDiff");
      int n = 0;
      for (int y = 0; y < a.H; y++)
        for (int x = 0; x < a.W; x++) {
          Color ca = a.At(x, y), cb = b.At(x, y);
          int d = Math.Max(Math.Abs(ca.A - cb.A), Math.Max(Math.Abs(ca.R - cb.R), Math.Max(Math.Abs(ca.G - cb.G), Math.Abs(ca.B - cb.B))));
          if (d > 4) n++;
        }
      return n;
    }

    static Rectangle OpaqueBounds(Frame f, Rectangle area) {
      int minX = int.MaxValue, minY = int.MaxValue, maxX = -1, maxY = -1;
      int x0 = Math.Max(0, area.Left), y0 = Math.Max(0, area.Top);
      int x1 = Math.Min(f.W, area.Right), y1 = Math.Min(f.H, area.Bottom);
      for (int y = y0; y < y1; y++)
        for (int x = x0; x < x1; x++)
          if (f.AlphaAt(x, y) >= 200) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
      if (maxX < 0) return Rectangle.Empty;
      return Rectangle.FromLTRB(minX, minY, maxX + 1, maxY + 1);
    }

    static Rectangle ColorBounds(Frame f, Rectangle area, Color target, int tol) {
      int minX = int.MaxValue, minY = int.MaxValue, maxX = -1, maxY = -1;
      int x0 = Math.Max(0, area.Left), y0 = Math.Max(0, area.Top);
      int x1 = Math.Min(f.W, area.Right), y1 = Math.Min(f.H, area.Bottom);
      for (int y = y0; y < y1; y++)
        for (int x = x0; x < x1; x++) {
          int a = f.AlphaAt(x, y);
          if (a >= 150 && Near(f.At(x, y), target, tol)) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      if (maxX < 0) return Rectangle.Empty;
      return Rectangle.FromLTRB(minX, minY, maxX + 1, maxY + 1);
    }

    static void RequireEmpty(Frame f, string what) {
      Require(f.HasFullyTransparent(), what + ": expected a fully transparent frame");
    }

    // ---------------------------------------------------------------------
    // Cases
    // ---------------------------------------------------------------------

    static void EmptyFrameIsTransparent() {
      var screen = new Rectangle(0, 0, 320, 240);
      var f = Render(new List<PointerVisual>(), screen);
      RequireEmpty(f, "empty visual list");
    }

    static void NullVisualListIsTransparent() {
      var f = Render(null, new Rectangle(0, 0, 200, 150));
      RequireEmpty(f, "null visual list");
    }

    static void VisualOutsideScreenIsIgnored() {
      // Point is inside the monitor but outside the explicit canvas -> not rendered.
      var screen = new Rectangle(0, 0, 300, 300);
      var monitor = new Rectangle(0, 0, 600, 300);
      var f = Render(new List<PointerVisual> {
        Visual("a", "A", Color.FromArgb(255, 0, 0), 400, 150, monitor, 1f)
      }, screen);
      RequireEmpty(f, "visual point outside screen canvas");
    }

    static void VisualOutsideMonitorIsIgnored() {
      // Point is inside the canvas but outside its own monitor -> not rendered.
      var screen = new Rectangle(0, 0, 400, 300);
      var f = Render(new List<PointerVisual> {
        Visual("a", "A", Color.FromArgb(255, 0, 0), 100, 150, new Rectangle(200, 0, 200, 300), 1f)
      }, screen);
      RequireEmpty(f, "visual point outside its monitor bounds");
    }

    static void RightAndBottomAreOpenBoundaries() {
      // Right/bottom are half-open: a point at Right or Bottom is outside.
      var screen = new Rectangle(0, 0, 200, 200);
      var f = Render(new List<PointerVisual> {
        Visual("r", "R", Color.FromArgb(255, 0, 0), 200, 100, screen, 1f), // x == Right
        Visual("b", "B", Color.FromArgb(0, 180, 0), 100, 200, screen, 1f)  // y == Bottom
      }, screen);
      RequireEmpty(f, "right/bottom open boundaries");
    }

    static void TriangleHasWhiteBloomAndTranslucentBody() {
      var screen = new Rectangle(0, 0, 120, 120);
      Color tint = Color.FromArgb(30, 120, 240);
      var f = Render(new List<PointerVisual> { Visual("", "", tint, 40, 40, screen, 1f) }, screen);
      Color interior = f.At(48, 48);
      Require(interior.A >= 20 && interior.A <= 130, "triangle interior must stay translucent: alpha=" + interior.A);
      Require(Near(interior, tint, 65), "triangle lost the agent colour tint");
      Require(ColorCount(f, new Rectangle(38, 38, 22, 22), Color.White, 35) > 15, "white triangle rim missing");
      Color bloom = f.At(38, 40);
      Require(bloom.A > 0 && bloom.A < 180 && Near(bloom, Color.White, 35), "white edge bloom missing outside the tip");
      Require(AlphaCount(f, new Rectangle(20, 66, 70, 20)) == 0, "triangle still has a pointer tail or radial spotlight");
    }

    static void CornerAnchorStaysAtTheTip() {
      // A marker in the bottom-right corner folds its body up-left, but the tip
      // must remain exactly on the caller's physical point (rightmost/bottommost).
      var screen = new Rectangle(0, 0, 140, 140);
      var f = Render(new List<PointerVisual> {
        Visual("c", "A", Color.FromArgb(255, 0, 0), 139, 139, screen, 1f)
      }, screen);
      var b = OpaqueBounds(f, screen);
      Require(!b.IsEmpty, "corner marker was not rendered");
      Require(b.Right >= screen.Right - 1 && b.Bottom >= screen.Bottom - 1,
        "corner tip not anchored: opaque bounds " + b.ToString());
      Color interior = f.At(131, 131);
      Require(interior.A >= 20 && Near(interior, Color.Red, 90),
        "corner triangle tint missing behind the white tip");
    }

    static void NegativeOriginKeepsSamePixel() {
      // Rendering must depend only on (point - screen.Location): translating both
      // the canvas origin and the physical point by the same offset must produce
      // the exact same bitmap. This is the "negative origin, same pixel" contract.
      var screenA = new Rectangle(0, 0, 360, 300);
      var screenB = new Rectangle(-160, -120, 360, 300);
      var fA = Render(new List<PointerVisual> {
        Visual("p", "AB", Color.FromArgb(255, 0, 0), 200, 150, screenA, 1f)
      }, screenA);
      var fB = Render(new List<PointerVisual> {
        Visual("p", "AB", Color.FromArgb(255, 0, 0), 40, 30, screenB, 1f)
      }, screenB);
      Require(fA.W == fB.W && fA.H == fB.H, "frame size mismatch across origin shift");
      Require(!OpaqueBounds(fA, screenA).IsEmpty, "marker not rendered in positive-origin frame");
      int differing = 0, maxDelta = 0;
      for (int y = 0; y < fA.H; y++)
        for (int x = 0; x < fA.W; x++) {
          Color a = fA.At(x, y), b = fB.At(x, y);
          int d = Math.Max(Math.Abs(a.A - b.A), Math.Max(Math.Abs(a.R - b.R), Math.Max(Math.Abs(a.G - b.G), Math.Abs(a.B - b.B))));
          if (d > 4) differing++;
          if (d > maxDelta) maxDelta = d;
        }
      Require(differing == 0, "negative-origin frame differs at " + differing + " pixels (max delta " + maxDelta + ")");
    }

    static void MixedDpiSameFrameScales() {
      // Two markers in one frame at scale 1 and scale 2: the 2x marker must be
      // visibly larger (per-monitor DPI), while both keep their own colour.
      var screen = new Rectangle(0, 0, 520, 320);
      Color red = Color.FromArgb(255, 0, 0);
      Color green = Color.FromArgb(0, 180, 0);
      var f = Render(new List<PointerVisual> {
        Visual("s1", "A", red, 80, 160, screen, 1f),
        Visual("s2", "B", green, 340, 160, screen, 2f)
      }, screen);
      var region1 = new Rectangle(60, 60, 220, 220);
      var region2 = new Rectangle(320, 10, 200, 300);
      var b1 = OpaqueBounds(f, region1);
      var b2 = OpaqueBounds(f, region2);
      Require(!b1.IsEmpty, "1x marker not rendered");
      Require(!b2.IsEmpty, "2x marker not rendered");
      Require(b2.Height > b1.Height * 1.4f,
        "2x marker not taller than 1x: " + b1.Height + " vs " + b2.Height);
      Require(OpaqueCount(f, region2) > OpaqueCount(f, region1) * 1.6f,
        "2x marker footprint not larger: " + OpaqueCount(f, region1) + " vs " + OpaqueCount(f, region2));
      Require(ColorCount(f, region1, red, 90) > 0, "1x marker colour missing");
      Require(ColorCount(f, region2, green, 90) > 0, "2x marker colour missing");
    }

    static void SamePointLabelsExpand() {
      // Two markers on the exact same physical point: both tags must stay
      // legible (stacked), not overlap so one hides the other.
      var screen = new Rectangle(0, 0, 360, 360);
      Color red = Color.FromArgb(255, 0, 0);
      Color blue = Color.FromArgb(0, 80, 255);
      var single = Render(new List<PointerVisual> {
        Visual("a", "A", red, 180, 150, screen, 1f)
      }, screen);
      int singleCount = ColorCount(single, screen, red, 90);
      var singleBounds = OpaqueBounds(single, screen);
      Require(singleCount > 0, "single marker produced no colour");

      var both = Render(new List<PointerVisual> {
        Visual("a", "A", red, 180, 150, screen, 1f),
        Visual("b", "C", blue, 180, 150, screen, 1f)
      }, screen);
      int redCount = ColorCount(both, screen, red, 90);
      int blueCount = ColorCount(both, screen, blue, 90);
      var bothBounds = OpaqueBounds(both, screen);

      Require(redCount > singleCount * 0.55f, "first tag vanished when the second was added (" + redCount + " vs " + singleCount + ")");
      Require(blueCount > singleCount * 0.55f, "second marker not fully drawn (" + blueCount + " vs " + singleCount + ")");
      Require(bothBounds.Height >= singleBounds.Height + 9,
        "same-point tags were not stacked vertically: single " + singleBounds.Height + ", both " + bothBounds.Height);
    }

    static void CrossMonitorSeamFoldsInward() {
      // Two monitors share a vertical seam at x = 280. A marker whose tip sits at
      // the seam must fold its body inward and, crucially, may not paint a single
      // pixel -- not even an anti-aliased glow or outline -- onto the monitor it
      // does not belong to. Rendering each marker alone attributes every pixel;
      // rendering two adjacent markers together then proves the clip saved for the
      // first is restored before the second draws, so the second is not swallowed
      // by the first marker's clip.
      var screen = new Rectangle(0, 0, 560, 300);
      var monitorA = new Rectangle(0, 0, 280, 300);
      var monitorB = new Rectangle(280, 0, 280, 300);
      var leftHalf = new Rectangle(0, 0, 280, 300);
      var rightHalf = new Rectangle(280, 0, 280, 300);
      Color red = Color.FromArgb(255, 0, 0);
      Color green = Color.FromArgb(0, 180, 0);

      // Marker A alone: tip on the A side, body folds left. Any alpha>0 pixel that
      // lands on monitor B is a leak.
      var fa = Render(new List<PointerVisual> {
        Visual("a", "A", red, 279, 150, monitorA, 1f)
      }, screen);
      Require(!fa.HasFullyTransparent(), "marker A not rendered at the seam");
      Require(AlphaCount(fa, rightHalf) == 0,
        "marker A painted alpha>0 onto monitor B (" + AlphaCount(fa, rightHalf) + " px)");
      var rbSolo = ColorBounds(fa, leftHalf, red, 90);
      Require(!rbSolo.IsEmpty, "marker A body not rendered on monitor A");
      var aTip = OpaqueBounds(fa, new Rectangle(270, 145, 10, 14));
      Require(!aTip.IsEmpty && aTip.Right == 280,
        "marker A white tip not anchored/folded at the seam: " + aTip);

      // Marker B alone: tip on the B side, body extends right.
      var fb = Render(new List<PointerVisual> {
        Visual("b", "B", green, 280, 150, monitorB, 1f)
      }, screen);
      Require(!fb.HasFullyTransparent(), "marker B not rendered at the seam");
      Require(AlphaCount(fb, leftHalf) == 0,
        "marker B painted alpha>0 onto monitor A (" + AlphaCount(fb, leftHalf) + " px)");
      var gbSolo = ColorBounds(fb, rightHalf, green, 90);
      Require(!gbSolo.IsEmpty, "marker B body not rendered on monitor B");
      var bTip = OpaqueBounds(fb, new Rectangle(280, 145, 10, 14));
      Require(!bTip.IsEmpty && bTip.Left == 280,
        "marker B white tip not anchored at the seam: " + bTip);

      // Two adjacent markers in one frame. Both must appear on their own side and
      // neither colour may cross; this only holds if marker A's clip is restored
      // for marker B (an unrestored clip would erase B or trap it on A's side).
      var f = Render(new List<PointerVisual> {
        Visual("a", "A", red, 279, 150, monitorA, 1f),  // tip on A side of the seam
        Visual("b", "B", green, 280, 150, monitorB, 1f)  // tip on B side of the seam
      }, screen);
      var rb = ColorBounds(f, leftHalf, red, 90);
      var gb = ColorBounds(f, rightHalf, green, 90);
      Require(!rb.IsEmpty, "combined frame lost marker A (clip not restored?)");
      Require(!gb.IsEmpty, "combined frame lost marker B (clip not restored?)");
      var bothATip = OpaqueBounds(f, new Rectangle(270, 145, 10, 14));
      var bothBTip = OpaqueBounds(f, new Rectangle(280, 145, 10, 14));
      Require(!bothATip.IsEmpty && bothATip.Right == 280, "combined: marker A white tip drifted from the seam");
      Require(!bothBTip.IsEmpty && bothBTip.Left == 280, "combined: marker B white tip drifted from the seam");
      Require(ColorCount(f, rightHalf, red, 70) == 0, "combined: marker A colour crossed into monitor B");
      Require(ColorCount(f, leftHalf, green, 70) == 0, "combined: marker B colour crossed into monitor A");
    }

    static void ZeroSizeMonitorSkipsVisual() {
      // A monitor with non-positive width or height is not a real screen that
      // can contain the point, so its marker is dropped (task-12 semantics),
      // while a sibling marker with a valid monitor still renders. Covers both
      // a zero-area (Rectangle.Empty) and a zero-height monitor bounds.
      var screen = new Rectangle(0, 0, 240, 160);
      Color droppedEmpty = Color.FromArgb(255, 0, 90, 200);
      Color droppedFlat = Color.FromArgb(255, 150, 0, 150);
      Color kept = Color.FromArgb(255, 200, 60, 0);
      var f = Render(new List<PointerVisual> {
        Visual("be", "BE", droppedEmpty, 80, 80, Rectangle.Empty, 1f),
        Visual("bf", "BF", droppedFlat, 120, 80, new Rectangle(0, 0, 240, 0), 1f),
        Visual("ok", "OK", kept, 190, 80, new Rectangle(0, 0, 240, 160), 1f)
      }, screen);
      Require(ColorCount(f, screen, kept, 70) > 0, "valid marker with a real monitor was not rendered");
      Require(ColorCount(f, screen, droppedEmpty, 70) == 0, "zero-area monitor marker was rendered instead of skipped");
      Require(ColorCount(f, screen, droppedFlat, 70) == 0, "zero-height monitor marker was rendered instead of skipped");
    }

    static void LongLabelStaysInsideNarrowMonitor() {
      // A narrow monitor sits inside a wider virtual canvas that also covers the
      // screen to its right (a widened/side-by-side desktop). The usable width
      // for a tag is monitor ∩ canvas, so a long label must be elided to fit
      // the monitor and must never paint its solid body colour onto the adjacent
      // screen. The soft spotlight glow has alpha <= 120, below the 150 body
      // floor used by ColorCount, so a glow cannot masquerade as body colour.
      var screen = new Rectangle(0, 0, 360, 120);
      var monitor = new Rectangle(0, 0, 120, 120);   // monitor right edge = x 120
      Color body = Color.FromArgb(255, 200, 40, 40);
      string longLabel = "WIDE-LABEL-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789";
      var f = Render(new List<PointerVisual> {
        Visual("k", longLabel, body, 60, 60, monitor, 1f)
      }, screen);

      int inMonitor = ColorCount(f, new Rectangle(0, 0, 120, 120), body, 60);
      int inAdjacent = ColorCount(f, new Rectangle(120, 0, 240, 120), body, 60);
      Require(inMonitor > 200, "long label body not visible inside its own monitor: " + inMonitor + " px");
      Require(inAdjacent <= 2, "long label bled onto the adjacent screen: " + inAdjacent + " body px past x=120");

      var cb = ColorBounds(f, screen, body, 60);
      Require(!cb.IsEmpty, "long label produced no body colour");
      Require(cb.Right <= 120, "usable width not clamped to monitor-canvas: coloured right edge " + cb.Right + " > monitor right 120");
    }

    static void NarrowScreenArrowKeepsTip() {
      // A narrow monitor (24 px wide) sits at the far left of a much wider canvas.
      // A marker tip one pixel from the monitor's right edge must fold its arrow
      // inward so the whole arrow is drawn, the tip stays on the caller's point,
      // and nothing -- arrow, outline or glow -- spills onto the canvas to the
      // right of the monitor. This exercises the per-marker monitor / canvas clip
      // together with inward folding; a plain screen clip would let an unflipped
      // arrow bleed past x = 24.
      var screen = new Rectangle(0, 0, 200, 120);
      var monitor = new Rectangle(0, 0, 24, 120);
      var beyondMonitor = new Rectangle(24, 0, 200 - 24, 120);
      Color body = Color.FromArgb(255, 0, 120, 255);
      int tipX = 22, tipY = 60;
      var f = Render(new List<PointerVisual> {
        Visual("n", "", body, tipX, tipY, monitor, 1f)
      }, screen);

      Require(!f.HasFullyTransparent(), "narrow-monitor marker was not rendered");
      // Nothing may appear past the monitor's right edge.
      Require(AlphaCount(f, beyondMonitor) == 0,
        "narrow arrow overflowed past the monitor edge (" + AlphaCount(f, beyondMonitor) + " px at x>=24)");
      var b = OpaqueBounds(f, monitor);
      Require(!b.IsEmpty, "narrow arrow produced no opaque pixels");
      Require(b.Right <= monitor.Right, "narrow arrow painted past x=" + monitor.Right + ": " + b.ToString());
      // Tip anchored on the caller's point (rightmost opaque column reaches it).
      Require(b.Right >= tipX, "narrow arrow tip not anchored at x=" + tipX + " (opaque right edge " + b.Right + ")");
      Require(OpaqueCount(f, new Rectangle(tipX - 3, tipY - 4, 5, 9)) > 0, "narrow arrow has no body pixels at the tip");
      // The arrow body was folded inward (drawn left of the tip), not clipped to a
      // sliver at the edge: the opaque footprint is a real arrow's width.
      Require(b.Left <= tipX - 8, "narrow arrow was not folded inward: opaque left edge " + b.Left + " (tip " + tipX + ")");
    }

    static void ShortScreenDropsLabel() {
      // On a monitor too short to hold a tag, DrawVisuals must fall back to the
      // anchored arrow and draw no tag at all: the picture must be pixel-identical
      // to the very same point with no label. A tall monitor at the same point
      // proves the label is drawn when there is room, so the equality is not
      // vacuous.
      var screen = new Rectangle(0, 0, 200, 200);
      Color body = Color.FromArgb(255, 40, 160, 60);
      int px = 80;
      string label = "SHORT-LABEL";

      // Short monitor: 20 px tall, tip on the bottom edge -> no vertical room.
      var shortMon = new Rectangle(0, 0, 160, 20);
      int shortY = 19;
      var labelled = Render(new List<PointerVisual> {
        Visual("k", label, body, px, shortY, shortMon, 1f)
      }, screen);
      var bare = Render(new List<PointerVisual> {
        Visual("", "", body, px, shortY, shortMon, 1f)
      }, screen);
      Require(!labelled.HasFullyTransparent(), "short-monitor marker was not rendered at all");
      int shortDiff = FrameDiff(labelled, bare);
      Require(shortDiff == 0,
        "short monitor drew a label despite no vertical room (" + shortDiff + " px differ from the no-label frame)");

      // Control: a tall monitor with the same label must actually draw a tag.
      var tallMon = new Rectangle(0, 0, 160, 120);
      int tallY = 60;
      var tallLabelled = Render(new List<PointerVisual> {
        Visual("k", label, body, px, tallY, tallMon, 1f)
      }, screen);
      var tallBare = Render(new List<PointerVisual> {
        Visual("", "", body, px, tallY, tallMon, 1f)
      }, screen);
      int tallDiff = FrameDiff(tallLabelled, tallBare);
      Require(tallDiff > 40,
        "control failed: a tall monitor with room did not draw the label (diff " + tallDiff + " px)");
    }
  }
}
