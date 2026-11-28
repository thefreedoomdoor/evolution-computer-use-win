// Offline timing, geometry and trace-schema regression for the multi-pointer
// overlay. Compiled together with scripts/windows-takeover.cs by
// tests/desktopPointerAnimation.test.ts. No window is created and no input is
// synthesized: MultiPointerAnimator is a pure clock-driven model,
// PointerFrame.TrianglePoints is the exact geometry the renderer draws, and
// MultiPointerFrame.TraceLine is the pure record builder.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;

namespace DshTakeover {
  // Run() is parameterless and returns "POINTER_ANIMATION_OK <count>"; a failed
  // assertion throws so the Node test fails with the message.
  public static class PointerAnimationTests {
    public static string Run() {
      int cases = 0;
      TriangleBaseExpanded25Percent();   cases++;
      TriangleTipAndHeightUnchanged();   cases++;
      FirstFrameSnapsToTarget();         cases++;
      TweenFollowsMonotonicTime();       cases++;
      FrameSchedulingNoDrift();          cases++;
      PerAgentTargetsIndependent();      cases++;
      RetargetUsesCurrentPosition();     cases++;
      ContinuousRetargetKeepsProgress(); cases++;
      DeleteRemovesMotionSafely();       cases++;
      ClearAndNullAreSafe();             cases++;
      NoOvershootAcrossScreens();        cases++;
      TraceLineHasContract();            cases++;
      SurfacePaintMatchesDrawVisuals();  cases++;
      SurfaceReuseClearsStalePixels();   cases++;
      PacerMeets60HzDeadline();          cases++;
      HeadingCanonicalIsZeroRotation();  cases++;
      HeadingRotatesAboutTip();          cases++;
      HeadingShortestArc();              cases++;
      HeadingRestoresToCanonical();      cases++;
      OpacityFades();                    cases++;
      PerMotionDurationHonored();        cases++;
      SeqStaleSampleIgnored();           cases++;
      PathFollowsPolyline();             cases++;
      OpacityZeroIsInvisible();          cases++;
      HeadingRotatesPixels();            cases++;
      SpawnSingleSyncRestoresHeading();  cases++;
      RetargetUsesRenderedHeading();     cases++;
      NanHeadingKeepsCurrentHeading();   cases++;
      SnapshotEchoKeepsRestoredHeading(); cases++;
      EchoDoesNotCutRestoreTail();       cases++;
      NewTargetTurnsDespiteStaleEcho();  cases++;
      return "POINTER_ANIMATION_OK " + cases.ToString();
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------
    static void Require(bool condition, string message) {
      if (!condition) throw new InvalidOperationException("pointer animation assertion failed: " + message);
    }

    static void Near(double actual, double expected, double tol, string message) {
      if (Math.Abs(actual - expected) > tol)
        throw new InvalidOperationException("pointer animation assertion failed: " + message +
          " (expected " + expected.ToString("0.####") + ", got " + actual.ToString("0.####") + ")");
    }

    static string[] Keys(params string[] keys) { return keys; }
    static Native.Point[] Points(params Native.Point[] points) { return points; }
    static Native.Point Pt(int x, int y) { return new Native.Point(x, y); }

    static PointerVisual Visual(string key, string name, int x, int y) {
      var screen = new Rectangle(0, 0, 400, 400);
      return new PointerVisual(key, name, Color.FromArgb(255, 0, 0), new Native.Point(x, y), screen, 1f);
    }

    // Paint visuals into a persistent top-down 32bppPArgb DIB section, the same
    // way the live overlay does, so the pixel result can be compared with the
    // legacy DrawVisuals bitmap and with a reused surface.
    static Bitmap PaintToDib(IList<PointerVisual> visuals, Rectangle screen, out IntPtr dib) {
      IntPtr bits;
      dib = Native.CreateArgbDib(screen.Width, screen.Height, out bits);
      Require(dib != IntPtr.Zero && bits != IntPtr.Zero, "CreateArgbDib returned a null handle");
      var surface = new Bitmap(screen.Width, screen.Height, screen.Width * 4, PixelFormat.Format32bppPArgb, bits);
      using (var g = Graphics.FromImage(surface)) PointerFrame.DrawVisualsInto(g, visuals, screen);
      return surface;
    }

    static int PixelDiff(Bitmap a, Bitmap b, int width, int height, out int firstX, out int firstY) {
      int diff = 0;
      firstX = -1;
      firstY = -1;
      for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
          Color ca = a.GetPixel(x, y);
          Color cb = b.GetPixel(x, y);
          if (ca.A != cb.A || ca.R != cb.R || ca.G != cb.G || ca.B != cb.B) {
            if (diff == 0) { firstX = x; firstY = y; }
            diff++;
          }
        }
      }
      return diff;
    }

    static double Dist(PointF a, PointF b) {
      double dx = a.X - b.X, dy = a.Y - b.Y;
      return Math.Sqrt(dx * dx + dy * dy);
    }

    static double DistanceToLine(PointF point, PointF a, PointF b) {
      double dx = b.X - a.X, dy = b.Y - a.Y;
      double len = Math.Sqrt(dx * dx + dy * dy);
      if (len == 0.0) return Dist(point, a);
      return Math.Abs((point.X - a.X) * dy - (point.Y - a.Y) * dx) / len;
    }

    static void Read(MultiPointerAnimator animator, string key, out double x, out double y) {
      if (!animator.TryGet(key, out x, out y)) throw new InvalidOperationException("missing motion for " + key);
    }

    // ------------------------------------------------------------------
    // geometry: base edge widened 25%, tip and height unchanged
    // ------------------------------------------------------------------
    static void TriangleBaseExpanded25Percent() {
      var p = PointerFrame.TrianglePoints(1f);
      Require(p.Length == 3, "expected three vertices, got " + p.Length);
      Near(p[0].X, 0.0, 1e-4, "tip x must stay at origin");
      Near(p[0].Y, 0.0, 1e-4, "tip y must stay at origin");
      Near(p[1].X, 17.25, 1e-4, "base corner 1 x");
      Near(p[1].Y, 6.75, 1e-4, "base corner 1 y");
      Near(p[2].X, 6.75, 1e-4, "base corner 2 x");
      Near(p[2].Y, 17.25, 1e-4, "base corner 2 y");

      double midX = (p[1].X + p[2].X) / 2.0, midY = (p[1].Y + p[2].Y) / 2.0;
      Near(midX, 12.0, 1e-4, "base midpoint x");
      Near(midY, 12.0, 1e-4, "base midpoint y");
      double oldLength = Dist(new PointF(16.2f, 7.8f), new PointF(7.8f, 16.2f));
      double newLength = Dist(p[1], p[2]);
      Near(newLength / oldLength, 1.25, 1e-4, "base edge must be exactly 25% longer");
    }

    static void TriangleTipAndHeightUnchanged() {
      var p = PointerFrame.TrianglePoints(1f);
      Near(p[0].X, 0.0, 1e-4, "tip x");
      Near(p[0].Y, 0.0, 1e-4, "tip y");
      Near(DistanceToLine(p[0], p[1], p[2]), 24.0 / Math.Sqrt(2.0), 1e-3, "height must not change");

      var p2 = PointerFrame.TrianglePoints(2f);
      Near(p2[0].X, 0.0, 1e-4, "tip x at 2x");
      Near(p2[0].Y, 0.0, 1e-4, "tip y at 2x");
      Near(p2[1].X, 34.5, 1e-4, "base corner 1 x at 2x");
      Near(p2[2].Y, 34.5, 1e-4, "base corner 2 y at 2x");
      Near(DistanceToLine(p2[0], p2[1], p2[2]), 2.0 * 24.0 / Math.Sqrt(2.0), 1e-3, "height scales with DPI");
    }

    // ------------------------------------------------------------------
    // motion model
    // ------------------------------------------------------------------
    static void FirstFrameSnapsToTarget() {
      var a = new MultiPointerAnimator();
      a.Sync(Keys("alpha"), Points(Pt(300, 200)), 0.0);
      double x, y;
      Read(a, "alpha", out x, out y);
      Near(x, 300.0, 1e-6, "new id must appear exactly at its target x");
      Near(y, 200.0, 1e-6, "new id must appear exactly at its target y");
      Require(!a.AnyAnimating, "a brand-new id must not animate from nowhere");
      Require(a.Count == 1, "one motion expected");
    }

    static void TweenFollowsMonotonicTime() {
      var a = new MultiPointerAnimator();
      a.DurationMs = 200.0;
      a.Sync(Keys("p"), Points(Pt(0, 0)), 0.0);
      a.Sync(Keys("p"), Points(Pt(100, 200)), 0.0);
      double x, y;
      a.Advance(50.0);  Read(a, "p", out x, out y);  Near(x, 25.0, 1e-6, "quarter x");  Near(y, 50.0, 1e-6, "quarter y");
      a.Advance(100.0); Read(a, "p", out x, out y);  Near(x, 50.0, 1e-6, "half x");     Near(y, 100.0, 1e-6, "half y");
      a.Advance(199.0); Read(a, "p", out x, out y);  Near(x, 99.5, 1e-3, "near-end x");
      Require(a.AnyAnimating, "still animating before the duration elapses");
      a.Advance(200.0); Read(a, "p", out x, out y);  Near(x, 100.0, 1e-6, "end x");     Near(y, 200.0, 1e-6, "end y");
      Require(!a.AnyAnimating, "settled exactly at the end");
    }

    static void FrameSchedulingNoDrift() {
      var stepped = new MultiPointerAnimator();
      stepped.DurationMs = 200.0;
      stepped.Sync(Keys("p"), Points(Pt(0, 0)), 0.0);
      stepped.Sync(Keys("p"), Points(Pt(100, 0)), 0.0);
      double[] stamps = { 16.667, 33.333, 50.0, 66.667, 83.333, 100.0 };
      foreach (var s in stamps) stepped.Advance(s);

      var jumped = new MultiPointerAnimator();
      jumped.DurationMs = 200.0;
      jumped.Sync(Keys("p"), Points(Pt(0, 0)), 0.0);
      jumped.Sync(Keys("p"), Points(Pt(100, 0)), 0.0);
      jumped.Advance(100.0);

      double sx, sy, jx, jy;
      Read(stepped, "p", out sx, out sy);
      Read(jumped, "p", out jx, out jy);
      Near(sx, 50.0, 1e-6, "stepped position at 100ms");
      Near(jx, 50.0, 1e-6, "jumped position at 100ms");
      Near(sx, jx, 1e-9, "many frames must not drift from one jump (x)");
      Near(sy, jy, 1e-9, "many frames must not drift from one jump (y)");

      stepped.Advance(100.0);
      double rx, ry; Read(stepped, "p", out rx, out ry);
      Near(rx, 50.0, 1e-9, "idempotent at the same monotonic time");
      Near(ry, 0.0, 1e-9, "idempotent y");
    }

    static void PerAgentTargetsIndependent() {
      var a = new MultiPointerAnimator();
      a.DurationMs = 200.0;
      a.Sync(Keys("a", "b"), Points(Pt(0, 0), Pt(0, 0)), 0.0);
      a.Sync(Keys("a", "b"), Points(Pt(100, 0), Pt(0, 100)), 0.0);
      a.Advance(100.0);
      double ax, ay, bx, by;
      Read(a, "a", out ax, out ay);
      Read(a, "b", out bx, out by);
      Near(ax, 50.0, 1e-6, "agent a x");
      Near(ay, 0.0, 1e-6, "agent a y");
      Near(bx, 0.0, 1e-6, "agent b x");
      Near(by, 50.0, 1e-6, "agent b y");
    }

    static void RetargetUsesCurrentPosition() {
      var a = new MultiPointerAnimator();
      a.DurationMs = 200.0;
      a.Sync(Keys("p"), Points(Pt(0, 0)), 0.0);
      a.Sync(Keys("p"), Points(Pt(100, 0)), 0.0);
      a.Advance(100.0);
      a.Sync(Keys("p"), Points(Pt(100, 100)), 100.0);
      a.Advance(200.0);
      double x, y;
      Read(a, "p", out x, out y);
      Near(x, 75.0, 1e-6, "retarget must start from the current x");
      Near(y, 50.0, 1e-6, "retarget must start from the current y");
    }

    // Reproduces the real Tick order exactly: RefreshTargets calls Sync at the
    // same monotonic now, then the frame calls Advance(now). No test-side
    // Advance before Sync is allowed, because that is what hid the freeze: a
    // target that changes on every 16.667ms frame would set From=stale.X and
    // StartMs=now, then always advance t=0, so the drawn cursor never moved
    // until the target stopped and it snapped.
    static void ContinuousRetargetKeepsProgress() {
      var a = new MultiPointerAnimator();
      a.DurationMs = 200.0;
      const double Step = 1000.0 / 60.0;
      a.Sync(Keys("p"), Points(Pt(0, 0)), 0.0);
      double prevX = 0.0, prevY = 0.0;
      for (int i = 1; i <= 120; i++) {
        double now = i * Step;
        int tx = i * 5, ty = 200 + i * 3;
        a.Sync(Keys("p"), Points(Pt(tx, ty)), now);
        a.Advance(now);
        double x, y;
        Read(a, "p", out x, out y);
        if (i >= 2) {
          Require(x > prevX + 0.05, "frame " + i + " froze: x=" + x + " prev=" + prevX);
          Require(y > prevY + 0.03, "frame " + i + " froze: y=" + y + " prev=" + prevY);
        }
        Require(x <= tx + 1e-6 && y <= ty + 1e-6, "frame " + i + " overshot its target");
        prevX = x; prevY = y;
      }
      // A moving pointer must still be behind its target; a snap would equal it.
      Require(prevX < 120 * 5 - 1.0, "moving sequence should interpolate, x=" + prevX);
      double holdStart = 120 * Step;
      for (int j = 1; j <= 15; j++) {
        double now = holdStart + j * Step;
        a.Sync(Keys("p"), Points(Pt(600, 560)), now);
        a.Advance(now);
      }
      double hx, hy;
      Read(a, "p", out hx, out hy);
      Near(hx, 600.0, 1e-6, "hold must converge to target x");
      Near(hy, 560.0, 1e-6, "hold must converge to target y");
      Require(!a.AnyAnimating, "hold must settle, not keep animating");
      // A regressed clock must not drag the drawn position backwards.
      double beforeX, beforeY;
      Read(a, "p", out beforeX, out beforeY);
      a.Sync(Keys("p"), Points(Pt(700, 600)), holdStart + 10 * Step - 5.0);
      a.Advance(holdStart + 10 * Step - 5.0);
      Read(a, "p", out hx, out hy);
      Require(hx >= beforeX - 1e-6 && hy >= beforeY - 1e-6, "regressed clock moved the tip backwards");
      // F1 anchor invariant: the tip stays the model origin at every position.
      var tip = PointerFrame.TrianglePoints(1f)[0];
      Near(tip.X, 0.0, 1e-4, "tip x anchor must stay at origin");
      Near(tip.Y, 0.0, 1e-4, "tip y anchor must stay at origin");
    }

    static void DeleteRemovesMotionSafely() {
      var a = new MultiPointerAnimator();
      a.DurationMs = 200.0;
      a.Sync(Keys("a", "b"), Points(Pt(0, 0), Pt(0, 0)), 0.0);
      a.Sync(Keys("a", "b"), Points(Pt(100, 100), Pt(50, 50)), 0.0);
      a.Advance(50.0);
      Require(a.Count == 2, "two motions before delete");
      a.Sync(Keys("a"), Points(Pt(100, 100)), 50.0);
      Require(a.Count == 1, "vanished id must be dropped");
      double x, y;
      Require(!a.TryGet("b", out x, out y), "deleted id must not resolve");
      Require(a.TryGet("a", out x, out y), "surviving id must still resolve");

      // Replacing the whole set (remove one id, add another in the same step)
      // must not leave the removed id behind.
      a.Sync(Keys("c"), Points(Pt(0, 0)), 50.0);
      Require(a.Count == 1, "whole-set replacement must drop the old id");
      Require(!a.TryGet("a", out x, out y), "old id gone after full replacement");
      Require(a.TryGet("c", out x, out y), "new id present after full replacement");
    }

    static void ClearAndNullAreSafe() {
      var a = new MultiPointerAnimator();
      a.Sync(Keys("a"), Points(Pt(5, 5)), 0.0);
      a.Sync(null, null, 0.0);
      Require(a.Count == 1, "null sync must be ignored");
      a.Sync(new string[0], new Native.Point[0], 0.0);
      Require(a.Count == 0, "empty sync must clear all motion");
      Require(!a.AnyAnimating, "nothing animates after clear");
      a.Clear();
      Require(a.Count == 0, "clear is safe on an empty set");
    }

    static void NoOvershootAcrossScreens() {
      var a = new MultiPointerAnimator();
      a.DurationMs = 200.0;
      a.Sync(Keys("p"), Points(Pt(100, 100)), 0.0);
      a.Sync(Keys("p"), Points(Pt(-300, 700)), 0.0);
      double prevX = 100.0, prevY = 100.0;
      for (int t = 0; t <= 250; t += 10) {
        a.Advance((double)t);
        double x, y;
        Read(a, "p", out x, out y);
        Require(x <= 100.0 + 1e-6 && x >= -300.0 - 1e-6, "x left the segment at t=" + t + ": " + x);
        Require(y >= 100.0 - 1e-6 && y <= 700.0 + 1e-6, "y left the segment at t=" + t + ": " + y);
        Require(x <= prevX + 1e-6 && y >= prevY - 1e-6, "motion reversed (drift) at t=" + t);
        prevX = x; prevY = y;
      }
      a.Advance(200.0);
      double ex, ey;
      Read(a, "p", out ex, out ey);
      Near(ex, -300.0, 1e-6, "exact end x (no overshoot)");
      Near(ey, 700.0, 1e-6, "exact end y (no overshoot)");
      a.Advance(260.0);
      Read(a, "p", out ex, out ey);
      Near(ex, -300.0, 1e-6, "stays clamped after the end (x)");
      Near(ey, 700.0, 1e-6, "stays clamped after the end (y)");
    }

    static void TraceLineHasContract() {
      var visuals = new List<PointerVisual> {
        Visual("agent-1", "A", 10, 20),
        Visual("agent-2", "B", -5, 30)
      };
      var line = MultiPointerFrame.TraceLine(7, 12.5, 1700000000123L, visuals);
      Require(line.Length > 2 && line[0] == '{', "record must start with a JSON object: " + line);
      Require(line[line.Length - 1] == (char)10, "record must end with a newline");
      Require(line.TrimEnd((char)10, (char)13).EndsWith("}"), "record must close with a brace: " + line);
      Require(line.Contains(@"""seq"":7"), "seq field: " + line);
      Require(line.Contains(@"""tMs"":12.5"), "tMs field: " + line);
      Require(line.Contains(@"""wallMs"":1700000000123"), "wallMs field: " + line);
      Require(line.Contains(@"""active"":2"), "active field: " + line);
      Require(line.Contains(@"""id"":""agent-1"""), "first id: " + line);
      Require(line.Contains(@"""x"":10"), "first x: " + line);
      Require(line.Contains(@"""y"":20"), "first y: " + line);
      Require(line.Contains(@"""x"":-5"), "negative x preserved: " + line);
    }

    // New drawing path must be pixel-identical to the legacy one so the
    // white bloom, translucent fill, tip anchor and label all survive F1.
    static void SurfacePaintMatchesDrawVisuals() {
      var screen = new Rectangle(0, 0, 160, 160);
      var visuals = new List<PointerVisual> {
        Visual("a", "Alpha", 40, 40),
        Visual("b", "Beta", 110, 110)
      };
      IntPtr dib;
      using (var reference = PointerFrame.DrawVisuals(visuals, screen))
      using (var surface = PaintToDib(visuals, screen, out dib)) {
        int fx, fy;
        int diff = PixelDiff(reference, surface, screen.Width, screen.Height, out fx, out fy);
        Require(diff == 0, "DIB surface paint differs from DrawVisuals, first at (" + fx + "," + fy + "), pixels=" + diff);
      }
      Native.DeleteObject(dib);
    }

    // Reusing one surface across frames must clear stale pixels: the old tip
    // footprint disappears and the new one is painted.
    static void SurfaceReuseClearsStalePixels() {
      var screen = new Rectangle(0, 0, 160, 160);
      IntPtr dib;
      var surface = PaintToDib(new List<PointerVisual> { Visual("p", "P", 40, 40) }, screen, out dib);
      try {
        Require(surface.GetPixel(48, 48).A > 0, "first frame should paint near the tip");
        using (var g = Graphics.FromImage(surface))
          PointerFrame.DrawVisualsInto(g, new List<PointerVisual> { Visual("p", "P", 90, 90) }, screen);
        Require(surface.GetPixel(48, 48).A == 0, "reused surface must clear the previous frame");
        Require(surface.GetPixel(98, 98).A > 0, "reused surface must paint the new frame");
      } finally {
        surface.Dispose();
        Native.DeleteObject(dib);
      }
    }

    // The clock policy must coarse-sleep only when it can, spin for the last
    // stretch, fire inside a tiny window, and never accumulate drift over a
    // long 60 Hz run. A fake clock models the real wake latency.
    static void PacerMeets60HzDeadline() {
      int ms;
      Require(MultiPointerFrame.PacerSleepMs(16.6, out ms) && ms == 15, "16.6ms should coarse-sleep 15ms, got " + ms);
      Require(MultiPointerFrame.PacerSleepMs(3.0, out ms) && ms == 1, "3.0ms should coarse-sleep 1ms, got " + ms);
      Require(!MultiPointerFrame.PacerSleepMs(2.0, out ms), "2.0ms is inside the spin window, not coarse-sleep");
      Require(!MultiPointerFrame.PacerSleepMs(0.04, out ms), "0.04ms should fire immediately");
      Require(MultiPointerFrame.PacerSpin(2.0), "2.0ms should spin");
      Require(MultiPointerFrame.PacerSpin(0.2), "0.2ms should spin");
      Require(!MultiPointerFrame.PacerSpin(0.04), "0.04ms should fire immediately");
      Require(!MultiPointerFrame.PacerSpin(5.0), "5.0ms should coarse-sleep, not spin");

      double frame = 1000.0 / 60.0;
      double target = frame;
      double clock = 0.0;
      double worstLate = 0.0;
      for (int i = 0; i < 240; i++) {
        int guard = 0;
        while (true) {
          double wait = target - clock;
          int coarse;
          if (MultiPointerFrame.PacerSleepMs(wait, out coarse)) {
            clock += coarse + 0.35;        // sleep returns ~0.35ms late
          } else if (MultiPointerFrame.PacerSpin(wait)) {
            clock += 0.05;                 // each yield advances 0.05ms
          } else {
            break;
          }
          if (++guard > 100000) throw new InvalidOperationException("pacer did not converge");
        }
        Require(clock >= target - 0.06, "frame fired too early at i=" + i + ": late=" + (target - clock));
        worstLate = Math.Max(worstLate, target - clock);
        target += frame;
      }
      Require(worstLate <= 0.06, "per-frame lateness must not grow across 240 frames, worst=" + worstLate.ToString("0.####"));
    }

    // ------------------------------------------------------------------
    // heading / opacity / per-motion duration / seq / path (task-38)
    // ------------------------------------------------------------------
    static MultiPointerAnimator.PointerTarget Target(string key, int x, int y, double motionMs, float headingDeg, bool restore, float opacity, params Native.Point[] path) {
      return new MultiPointerAnimator.PointerTarget {
        Key = key, Point = new Native.Point(x, y), MotionMs = motionMs,
        HeadingDeg = headingDeg, HeadingRestore = restore, Opacity = opacity,
        Path = (path != null && path.Length >= 2) ? new List<Native.Point>(path) : null
      };
    }
    static void Sync1(MultiPointerAnimator a, double now, MultiPointerAnimator.PointerTarget target) {
      a.Sync(new List<MultiPointerAnimator.PointerTarget> { target }, now);
    }

    // A spawn that is only ever synced once still returns to the canonical tip
    // after it arrives: the tilt is held during travel, then restored.
    static void SpawnSingleSyncRestoresHeading() {
      var a = new MultiPointerAnimator();
      var spawn = Target("s", 100, 100, 200.0, 135f, true, 1f);
      spawn.HasFrom = true;
      spawn.FromPoint = Pt(0, 0);
      Sync1(a, 0.0, spawn);
      a.Advance(100.0);
      float travelling;
      Require(a.TryGetHeading("s", out travelling), "spawn heading must be available");
      Near(travelling, 135.0, 0.5, "spawn keeps its travel heading while moving");
      a.Advance(200.0);
      a.Advance(320.0);
      float arrived;
      Require(a.TryGetHeading("s", out arrived), "spawn heading must survive arrival");
      Near(arrived, 0.0, 0.5, "single-sync spawn must restore the canonical tip");
    }

    // A mid-flight retarget aims the tip along the tween that is actually drawn
    // (current rendered point -> new target), not along writer->writer.
    static void RetargetUsesRenderedHeading() {
      var a = new MultiPointerAnimator();
      Sync1(a, 0.0, Target("t", 0, 0, 0.0, float.NaN, false, 1f));
      a.Advance(0.0);
      Sync1(a, 0.0, Target("t", 100, 0, 200.0, float.NaN, false, 1f));
      a.Advance(100.0);
      Sync1(a, 100.0, Target("t", 50, 100, 200.0, float.NaN, false, 1f));
      a.Advance(300.0);
      float heading;
      Require(a.TryGetHeading("t", out heading), "retarget heading must be available");
      // Rendered point (50,0) -> (50,100) is straight down: 90 - (-135) = 225.
      Near(heading, 225.0, 0.5, "retarget must follow the rendered travel vector");
      // The writer's previous target (0,0) -> (50,100) would have given ~198.4.
      Require(Math.Abs(heading - 198.43) > 5.0, "retarget must not reuse the writer's stale vector");
    }

    // A NaN heading from the writer means "no opinion"; it must not yank the tip
    // back to canonical in the middle of a move.
    static void NanHeadingKeepsCurrentHeading() {
      var a = new MultiPointerAnimator();
      Sync1(a, 0.0, Target("n", 0, 0, 0.0, 90f, false, 1f));
      a.Advance(0.0);
      Sync1(a, 0.0, Target("n", 0, 0, 200.0, float.NaN, false, 1f));
      a.Advance(300.0);
      float heading;
      Require(a.TryGetHeading("n", out heading), "heading must be available");
      Near(heading, 90.0, 0.5, "NaN heading must not reset an established heading");
    }

    static void HeadingCanonicalIsZeroRotation() {
      var canonical = PointerFrame.TrianglePoints(1f);
      var zero = PointerFrame.TrianglePoints(1f, 0f);
      for (int i = 0; i < 3; i++) {
        Near(zero[i].X, canonical[i].X, 1e-6, "canonical heading must not rotate x[" + i + "]");
        Near(zero[i].Y, canonical[i].Y, 1e-6, "canonical heading must not rotate y[" + i + "]");
      }
    }

    static void HeadingRotatesAboutTip() {
      var p = PointerFrame.TrianglePoints(1f, (float)(Math.PI / 2.0));
      Near(p[0].X, 0.0, 1e-5, "tip x stays anchored");
      Near(p[0].Y, 0.0, 1e-5, "tip y stays anchored");
      Near(p[1].X, -6.75, 1e-4, "corner1 rotated x");
      Near(p[1].Y, 17.25, 1e-4, "corner1 rotated y");
    }

    static void HeadingShortestArc() {
      var a = new MultiPointerAnimator();
      Sync1(a, 0.0, Target("h", 0, 0, 0.0, 170f, false, 1f));
      a.Advance(0.0);
      Sync1(a, 0.0, Target("h", 0, 0, 200.0, -170f, false, 1f));
      a.Advance(100.0);
      float headingDeg;
      Require(a.TryGetHeading("h", out headingDeg), "heading must be available");
      Require(Math.Abs(headingDeg) > 170f, "shortest arc must pass near +/-180, got " + headingDeg.ToString("0.##"));
    }

    static void HeadingRestoresToCanonical() {
      var a = new MultiPointerAnimator();
      Sync1(a, 0.0, Target("r", 0, 0, 0.0, float.NaN, true, 1f));
      a.Advance(0.0);
      Sync1(a, 0.0, Target("r", 100, 0, 100.0, 90f, true, 1f));
      a.Advance(100.0);
      a.Advance(240.0);
      float headingDeg;
      Require(a.TryGetHeading("r", out headingDeg), "heading must be available");
      Near(Math.Abs(headingDeg), 0.0, 1.0, "heading must ease back to canonical (0)");
    }

    static void OpacityFades() {
      var a = new MultiPointerAnimator();
      Sync1(a, 0.0, Target("o", 0, 0, 0.0, float.NaN, false, 0f));
      a.Advance(0.0);
      Sync1(a, 0.0, Target("o", 0, 0, 200.0, float.NaN, false, 1f));
      a.Advance(100.0);
      float mid;
      Require(a.TryGetOpacity("o", out mid), "opacity must be available");
      Near(mid, 0.5, 0.05, "opacity should be ~0.5 halfway through the fade");
      a.Advance(300.0);
      float done; a.TryGetOpacity("o", out done);
      Near(done, 1.0, 1e-3, "opacity must reach its target");
    }

    static void PerMotionDurationHonored() {
      var a = new MultiPointerAnimator();
      Sync1(a, 0.0, Target("d", 0, 0, 0.0, float.NaN, false, 1f));
      a.Advance(0.0);
      Sync1(a, 0.0, Target("d", 100, 0, 100.0, float.NaN, false, 1f));
      a.Advance(50.0);
      double x, y; Read(a, "d", out x, out y);
      Near(x, 50.0, 1.0, "per-motion duration must pace the tween (half at half time)");
      a.Advance(100.0);
      Read(a, "d", out x, out y);
      Near(x, 100.0, 1e-4, "must land exactly on target at the end of the motion");
    }

    static void SeqStaleSampleIgnored() {
      var a = new MultiPointerAnimator();
      var first = Target("s", 0, 0, 0.0, float.NaN, false, 1f); first.Seq = 5; first.SampleMs = 5000.0;
      Sync1(a, 0.0, first);
      a.Advance(0.0);
      var stale = Target("s", 200, 0, 200.0, float.NaN, false, 1f); stale.Seq = 4; stale.SampleMs = 4000.0;
      Sync1(a, 0.0, stale);
      a.Advance(200.0);
      double x, y; Read(a, "s", out x, out y);
      Near(x, 0.0, 1e-4, "an older seq/sampleMs must not move the pointer");
    }

    static void PathFollowsPolyline() {
      var a = new MultiPointerAnimator();
      Sync1(a, 0.0, Target("p", 0, 0, 0.0, float.NaN, false, 1f));
      a.Advance(0.0);
      Sync1(a, 0.0, Target("p", 100, 100, 100.0, float.NaN, false, 1f, Pt(0, 0), Pt(100, 0), Pt(100, 100)));
      a.Advance(50.0);
      double x, y; Read(a, "p", out x, out y);
      Near(x, 100.0, 1.0, "polyline halfway x");
      Near(y, 0.0, 1.0, "polyline halfway y");
      a.Advance(75.0);
      Read(a, "p", out x, out y);
      Near(x, 100.0, 1.0, "polyline 3/4 x");
      Near(y, 50.0, 1.0, "polyline 3/4 y");
    }

    static void OpacityZeroIsInvisible() {
      var screen = new Rectangle(0, 0, 160, 160);
      var visible = new PointerVisual("v", "V", Color.FromArgb(255, 0, 0), new Native.Point(80, 80), screen, 1f, float.NaN, 1f);
      var hidden = new PointerVisual("v", "V", Color.FromArgb(255, 0, 0), new Native.Point(80, 80), screen, 1f, float.NaN, 0f);
      using (var a = PointerFrame.DrawVisuals(new List<PointerVisual> { visible }, screen))
      using (var b = PointerFrame.DrawVisuals(new List<PointerVisual> { hidden }, screen)) {
        int fx, fy;
        int diff = PixelDiff(a, b, screen.Width, screen.Height, out fx, out fy);
        Require(diff > 0, "opacity 0 must differ from opacity 1");
      }
    }

    static void HeadingRotatesPixels() {
      var screen = new Rectangle(0, 0, 160, 160);
      var flat = new PointerVisual("v", "", Color.FromArgb(255, 0, 0), new Native.Point(80, 80), screen, 1f, 0f, 1f);
      var turned = new PointerVisual("v", "", Color.FromArgb(255, 0, 0), new Native.Point(80, 80), screen, 1f, 90f, 1f);
      using (var a = PointerFrame.DrawVisuals(new List<PointerVisual> { flat }, screen))
      using (var b = PointerFrame.DrawVisuals(new List<PointerVisual> { turned }, screen)) {
        int fx, fy;
        int diff = PixelDiff(a, b, screen.Width, screen.Height, out fx, out fy);
        Require(diff > 0, "a rotated glyph must paint different pixels than canonical");
      }
    }

    // ------------------------------------------------------------------
    // snapshot idempotency (task-60)
    // ------------------------------------------------------------------
    // The writer rewrites every row on every flush. When agent B moves, agent A
    // comes back with the same seq, sampleMs and coordinates plus the headingDeg
    // of its last real travel. That echo must not tilt A again after it had
    // already restored to the canonical tip.
    static void SnapshotEchoKeepsRestoredHeading() {
      var a = new MultiPointerAnimator();
      var spawn = Target("a", 100, 100, 200.0, 135f, true, 1f);
      spawn.HasFrom = true;
      spawn.FromPoint = Pt(0, 0);
      Sync1(a, 0.0, spawn);
      a.Advance(200.0);
      a.Advance(320.0);
      float canonical;
      Require(a.TryGetHeading("a", out canonical), "restored heading must be available");
      Near(canonical, 0.0, 0.5, "pointer must restore the canonical tip after arrival");

      var aEcho = Target("a", 100, 100, 200.0, 135f, true, 1f);
      var bMove = Target("b", 300, 0, 200.0, float.NaN, false, 1f);
      a.Sync(new List<MultiPointerAnimator.PointerTarget> { aEcho, bMove }, 320.0);
      a.Advance(400.0);
      float afterEcho;
      Require(a.TryGetHeading("a", out afterEcho), "heading must survive a full snapshot");
      Near(afterEcho, 0.0, 0.5, "an unchanged echo must not tilt a restored pointer");
      double bx, by;
      Require(a.TryGet("b", out bx, out by), "the other agent must still be tracked");
      Near(bx, 300.0, 1.0, "the other agent must still move");
    }

    // A full snapshot that arrives while the restore tail is still running must
    // neither re-tilt the pointer nor restart the tail: the tip keeps closing in
    // on the canonical angle on the original schedule.
    static void EchoDoesNotCutRestoreTail() {
      var a = new MultiPointerAnimator();
      var spawn = Target("t", 100, 0, 200.0, 90f, true, 1f);
      spawn.HasFrom = true;
      spawn.FromPoint = Pt(0, 0);
      Sync1(a, 0.0, spawn);
      a.Advance(200.0);
      float midTail;
      a.Advance(260.0);
      Require(a.TryGetHeading("t", out midTail), "tail heading must be available");
      Require(midTail > 1.0 && midTail < 89.0, "tail must be mid-flight, got " + midTail.ToString("0.##"));

      Sync1(a, 260.0, Target("t", 100, 0, 200.0, 90f, true, 1f));
      float stillClosing;
      a.Advance(280.0);
      Require(a.TryGetHeading("t", out stillClosing), "tail heading must survive the echo");
      Require(Math.Abs(stillClosing) < Math.Abs(midTail), "tail must keep closing after an echo");
      a.Advance(340.0);
      float done;
      Require(a.TryGetHeading("t", out done), "tail must finish");
      Near(done, 0.0, 0.5, "an echo must not postpone the restore tail");
    }

    // A genuinely new target (new seq, new coordinates) still takes effect even
    // though the writer keeps carrying the stale travel heading of the previous
    // move: the tip follows the tween that is actually drawn.
    static void NewTargetTurnsDespiteStaleEcho() {
      var a = new MultiPointerAnimator();
      Sync1(a, 0.0, Target("n", 0, 0, 0.0, float.NaN, false, 1f));
      a.Advance(0.0);
      Sync1(a, 0.0, Target("n", 100, 0, 200.0, float.NaN, false, 1f));
      a.Advance(200.0);

      var next = Target("n", 100, 100, 200.0, 45f, false, 1f);
      next.Seq = 2;
      next.SampleMs = 400.0;
      Sync1(a, 200.0, next);
      a.Advance(400.0);
      float heading;
      Require(a.TryGetHeading("n", out heading), "new target heading must be available");
      // Rendered point (100,0) -> (100,100) is straight down: 90 - (-135) = 225.
      Near(heading, 225.0, 0.5, "a new target must turn along its own travel vector");
      Require(Math.Abs(heading - 45.0) > 5.0, "a new target must not reuse the stale echo");
    }
  }
}
