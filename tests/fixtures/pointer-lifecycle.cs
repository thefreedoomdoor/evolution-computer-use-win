// Offline lifecycle regression for real-cursor spawn/release anchors. Compiled
// together with scripts/windows-takeover.cs by desktopPointerLifecycle.test.ts.
// The real GetCursorPos is replaced by an injected sampler, so no window is
// created, no input is synthesized and no shell/executor is needed.
using System;
using System.Collections.Generic;
using System.Drawing;

namespace DshTakeover {
  // Run() returns "POINTER_LIFECYCLE_OK <count>"; a failed check throws.
  public static class PointerLifecycleTests {
    public static string Run() {
      int cases = 0;
      SpawnWithoutTargetAnchorsAtCursor();   cases++;
      SpawnWithTargetTweensFromCursor();     cases++;
      OneSamplePerStateRead();               cases++;
      SpawnRepeatDoesNotResample();          cases++;
      SpawnDerivesHeading();                 cases++;
      SpawnSampleFailureHides();             cases++;
      ReleaseUsesFreshSample();              cases++;
      ReleaseUnknownIgnored();               cases++;
      ReleaseRepeatSeqNoResample();          cases++;
      ReleaseSampleFailureHides();           cases++;
      OldLifetimeDropped();                  cases++;
      OldSeqDropped();                       cases++;
      LegacyNeedsXY();                       cases++;
      SharedSampleSpawnAndRelease();         cases++;
      ReleaseFadesAndExpires();              cases++;
      ReleaseExpiryKeepsOtherPointers();     cases++;
      ReleaseAimsAtSampledCursor();          cases++;
      ReleaseDropsStaleWriterHeading();      cases++;
      SpawnAfterMergeStaysGone();            cases++;
      RepeatReleaseAfterMergeStaysGone();    cases++;
      return "POINTER_LIFECYCLE_OK " + cases;
    }

    static Native.Point Pt(int x, int y) { return new Native.Point(x, y); }

    static MultiPointerAnimator.PointerTarget T(string id, int x, int y, long seq, string anchor, string lifetime, bool hasPoint) {
      return new MultiPointerAnimator.PointerTarget {
        Id = id, Lifetime = lifetime == null ? "1" : lifetime,
        Key = id + "\u001f" + (lifetime == null ? "1" : lifetime),
        Name = id, Colour = Color.White, Point = Pt(x, y), HasPoint = hasPoint,
        CursorAnchor = anchor, HeadingDeg = float.NaN, HeadingRestore = false,
        Opacity = 1f, MotionMs = 200.0, SampleMs = 100.0, Seq = seq, Path = null
      };
    }

    static List<MultiPointerAnimator.PointerTarget> Resolve(
        PointerAnchorResolver resolver, IList<MultiPointerAnimator.PointerTarget> src,
        CursorSampler sampler, Func<string, bool> live, List<string> evidence) {
      return resolver.Resolve(src, sampler, live, delegate (string message) { if (evidence != null) evidence.Add(message); });
    }

    static CursorSampler Succeed(int[] calls, int[] point) {
      return delegate (out Native.Point p) { calls[0]++; p = Pt(point[0], point[1]); return true; };
    }

    static CursorSampler Fail(int[] calls) {
      return delegate (out Native.Point p) { calls[0]++; p = Pt(0, 0); return false; };
    }

    static Func<string, bool> Live(IList<MultiPointerAnimator.PointerTarget> targets) {
      var keys = new HashSet<string>(StringComparer.Ordinal);
      foreach (var t in targets) if (t != null && t.Key != null) keys.Add(t.Key);
      return delegate (string key) { return keys.Contains(key); };
    }

    static void Near(double actual, double expected, string message) {
      if (Math.Abs(actual - expected) > 0.01) throw new Exception(message + " expected " + expected + " got " + actual);
    }

    // 1: spawn with no target appears exactly where the real cursor is.
    static void SpawnWithoutTargetAnchorsAtCursor() {
      var resolver = new PointerAnchorResolver();
      var t = T("a", 0, 0, 1, "spawn", null, false);
      var calls = new int[1];
      var res = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { t }, Succeed(calls, new[] { 10, 20 }), null, null);
      if (res.Count != 1) throw new Exception("spawn-less-target must stay visible");
      if (res[0].Point.x != 10 || res[0].Point.y != 20) throw new Exception("spawn must anchor at real cursor");
      if (res[0].HasFrom || res[0].MotionMs != 0.0) throw new Exception("no-target spawn must not tween");
      if (calls[0] != 1) throw new Exception("spawn-less-target needs exactly one sample");
      if (resolver.HasSpawned(res[0].Key) != true) throw new Exception("spawn must be remembered");
    }

    // 2: spawn with target tweens from the real cursor to the first action target.
    static void SpawnWithTargetTweensFromCursor() {
      var resolver = new PointerAnchorResolver();
      var t = T("a", 300, 200, 1, "spawn", null, true);
      var res = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { t }, Succeed(new int[1], new[] { 10, 20 }), null, null);
      if (!res[0].HasFrom) throw new Exception("spawn with target must tween from cursor");
      if (res[0].FromPoint.x != 10 || res[0].FromPoint.y != 20) throw new Exception("spawn From must be real cursor");
      if (res[0].Point.x != 300 || res[0].Point.y != 200) throw new Exception("spawn To must be first real target");
      if (res[0].MotionMs != 200.0) throw new Exception("spawn tween must default to 200 ms");
    }

    // 3: every pointer in one state read shares a single sample (multi-monitor).
    static void OneSamplePerStateRead() {
      var resolver = new PointerAnchorResolver();
      var src = new List<MultiPointerAnimator.PointerTarget> { T("a", 100, 100, 1, "spawn", null, true), T("b", 200, 100, 1, "spawn", null, true) };
      var calls = new int[1];
      var res = Resolve(resolver, src, Succeed(calls, new[] { 7, 8 }), null, null);
      if (res.Count != 2 || calls[0] != 1) throw new Exception("two spawns must share one sample, calls=" + calls[0]);
      if (res[0].FromPoint.x != 7 || res[1].FromPoint.x != 7) throw new Exception("both pointers must share the same anchor");
    }

    // 4: a repeated spawn version never resamples or resets the origin.
    static void SpawnRepeatDoesNotResample() {
      var resolver = new PointerAnchorResolver();
      var calls = new int[1];
      var sampler = Succeed(calls, new[] { 7, 8 });
      var first = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("a", 300, 200, 1, "spawn", null, true) }, sampler, null, null);
      var again = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("a", 300, 200, 1, "spawn", null, true) }, sampler, null, null);
      if (calls[0] != 1) throw new Exception("repeated spawn must not resample, calls=" + calls[0]);
      if (again[0].HasFrom) throw new Exception("repeated spawn must not restart from the cursor again");
      if (again[0].Point.x != first[0].Point.x) throw new Exception("repeated spawn must keep the target");
    }

    // 5: heading is derived from cursor -> target when the writer omits it.
    static void SpawnDerivesHeading() {
      var resolver = new PointerAnchorResolver();
      var res = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("a", 100, 0, 1, "spawn", null, true) },
          Succeed(new int[1], new[] { 0, 0 }), null, null);
      // Real heading 0 deg -> rotation 0 - (-135) = 135 deg about the tip.
      Near(res[0].HeadingDeg, 135.0, "derived heading rotation");
    }

    // 6: failed sample hides the spawn instead of inventing 0,0 / center.
    static void SpawnSampleFailureHides() {
      var resolver = new PointerAnchorResolver();
      var evidence = new List<string>();
      var res = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("a", 300, 200, 1, "spawn", null, true) },
          Fail(new int[1]), null, evidence);
      if (res.Count != 0) throw new Exception("failed spawn sample must hide the pointer");
      if (evidence.Count == 0) throw new Exception("failed sample must leave evidence");
      if (resolver.HasSpawned("a\u001f1")) throw new Exception("failed spawn must not be marked anchored");
    }

    // 7: release ignores stale x/y and samples the real cursor at release time.
    static void ReleaseUsesFreshSample() {
      var resolver = new PointerAnchorResolver();
      int[] calls = new int[1];
      int sx = 10, sy = 20;
      CursorSampler sampler = delegate (out Native.Point p) { calls[0]++; p = Pt(sx, sy); return true; };
      var spawn = T("a", 300, 200, 1, "spawn", null, true);
      Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { spawn }, sampler, null, null);
      sx = 50; sy = 60;
      var release = T("a", 999, 999, 2, "release", null, true);
      release.Opacity = 0f;
      var live = Live(new List<MultiPointerAnimator.PointerTarget> { release });
      var res = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { release }, sampler, live, null);
      if (res.Count != 1) throw new Exception("release must stay until it fades");
      if (res[0].Point.x != 50 || res[0].Point.y != 60) throw new Exception("release To must be the fresh cursor sample");
      if (!res[0].RemoveWhenHidden) throw new Exception("release must expire by itself");
      if (res[0].Opacity != 0f) throw new Exception("release must fade out");
      if (res[0].HasFrom) throw new Exception("release must tween from its on-screen position, not the cursor");
      if (calls[0] != 2) throw new Exception("spawn and release sample once each, calls=" + calls[0]);
    }

    // 8: releasing a pointer that was never spawned must not create one.
    static void ReleaseUnknownIgnored() {
      var resolver = new PointerAnchorResolver();
      var calls = new int[1];
      var evidence = new List<string>();
      var res = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("ghost", 50, 50, 2, "release", null, true) },
          Succeed(calls, new[] { 1, 2 }), delegate (string key) { return false; }, evidence);
      if (res.Count != 0) throw new Exception("unknown release must be ignored");
      if (calls[0] != 0) throw new Exception("unknown release must not sample");
      if (evidence.Count == 0) throw new Exception("unknown release must leave evidence");
    }

    // 9: repeating the same release seq never takes a second sample.
    static void ReleaseRepeatSeqNoResample() {
      var resolver = new PointerAnchorResolver();
      var calls = new int[1];
      var sampler = Succeed(calls, new[] { 5, 6 });
      Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("a", 10, 10, 1, "spawn", null, true) }, sampler, null, null);
      var release = T("a", 10, 10, 2, "release", null, true);
      var live = Live(new List<MultiPointerAnimator.PointerTarget> { release });
      Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { release }, sampler, live, null);
      int after = calls[0];
      var again = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { release }, sampler, live, null);
      if (again.Count != 1) throw new Exception("duplicate release must keep the fade alive");
      if (calls[0] != after) throw new Exception("duplicate release must not resample");
      if (!again[0].RemoveWhenHidden || again[0].HasFrom) throw new Exception("duplicate release must reuse the stored destination");
      if (again[0].Point.x != 5 || again[0].Point.y != 6) throw new Exception("duplicate release must keep the sampled point");
    }

    // 10: a failed release sample hides the pointer rather than freezing it.
    static void ReleaseSampleFailureHides() {
      var resolver = new PointerAnchorResolver();
      int[] calls = new int[1];
      int mode = 0;
      CursorSampler sampler = delegate (out Native.Point p) { calls[0]++; p = Pt(10, 10); return mode == 0; };
      Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("a", 10, 10, 1, "spawn", null, true) }, sampler, null, null);
      mode = 1;
      var release = T("a", 10, 10, 2, "release", null, true);
      var evidence = new List<string>();
      var res = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { release }, sampler, Live(new List<MultiPointerAnimator.PointerTarget> { release }), evidence);
      if (res.Count != 0) throw new Exception("failed release sample must hide the pointer");
      if (evidence.Count == 0) throw new Exception("failed release sample must leave evidence");
    }

    // 11: an old lifetime row in the same state must not roll the pointer back.
    static void OldLifetimeDropped() {
      var resolver = new PointerAnchorResolver();
      var src = new List<MultiPointerAnimator.PointerTarget> { T("a", 1, 1, 5, null, "1", true), T("a", 2, 2, 1, null, "2", true) };
      var res = Resolve(resolver, src, null, null, null);
      if (res.Count != 1) throw new Exception("old lifetime must be dropped");
      if (res[0].Point.x != 2 || res[0].Point.y != 2) throw new Exception("newest lifetime must win");
    }

    // 12: an older seq for the same key must not rewind the pointer.
    static void OldSeqDropped() {
      var resolver = new PointerAnchorResolver();
      var src = new List<MultiPointerAnimator.PointerTarget> { T("a", 10, 10, 10, null, null, true), T("a", 3, 3, 3, null, null, true) };
      var res = Resolve(resolver, src, null, null, null);
      if (res.Count != 1 || res[0].Point.x != 10) throw new Exception("older seq must be dropped");
    }

    // 13: legacy entries still work, and a missing x/y without an anchor is
    // dropped instead of falling back to 0,0 / screen center / cached point.
    static void LegacyNeedsXY() {
      var resolver = new PointerAnchorResolver();
      var kept = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("a", 4, 5, 1, null, null, true) }, null, null, null);
      if (kept.Count != 1 || kept[0].HasFrom) throw new Exception("legacy target must render unchanged");
      var evidence = new List<string>();
      var dropped = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("b", 0, 0, 1, null, null, false) }, null, null, evidence);
      if (dropped.Count != 0) throw new Exception("missing x/y must be dropped");
      if (evidence.Count == 0) throw new Exception("missing x/y must leave evidence");
    }

    // 14: one state read that spawns one pointer and releases another uses one
    // sample for both (all monitors share the same anchor).
    static void SharedSampleSpawnAndRelease() {
      var resolver = new PointerAnchorResolver();
      var calls = new int[1];
      var sampler = Succeed(calls, new[] { 20, 30 });
      Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("b", 200, 200, 1, "spawn", null, true) }, sampler, null, null);
      int before = calls[0];
      var release = T("b", 200, 200, 2, "release", null, true);
      var spawn = T("a", 100, 100, 1, "spawn", null, true);
      var src = new List<MultiPointerAnimator.PointerTarget> { spawn, release };
      var res = Resolve(resolver, src, sampler, Live(new List<MultiPointerAnimator.PointerTarget> { release }), null);
      if (calls[0] - before != 1) throw new Exception("spawn+release in one read must share one sample");
      if (res.Count != 2) throw new Exception("both pointers must resolve");
    }

    // 15: release tween + fade expire the motion without any writer sweep.
    static void ReleaseFadesAndExpires() {
      var animator = new MultiPointerAnimator();
      animator.Sync(new List<MultiPointerAnimator.PointerTarget> { T("a", 0, 0, 1, null, null, true) }, 0.0);
      var release = T("a", 100, 100, 2, null, null, true);
      release.RemoveWhenHidden = true; release.Opacity = 0f; release.MotionMs = 200.0;
      animator.Sync(new List<MultiPointerAnimator.PointerTarget> { release }, 20.0);
      if (animator.Count != 1) throw new Exception("release must exist while fading");
      animator.Advance(400.0);
      if (animator.Count != 0) throw new Exception("release must expire after tween and fade");
    }

    // 17: the return trip aims the tip at the real cursor sampled at release,
    // derived by the animator from the point it is currently rendering.
    static void ReleaseAimsAtSampledCursor() {
      var animator = new MultiPointerAnimator();
      var spawn = T("a", 0, 0, 1, "spawn", null, true);
      spawn.HeadingDeg = 90f;
      spawn.HeadingRestore = true;
      animator.Sync(new List<MultiPointerAnimator.PointerTarget> { spawn }, 0.0);
      int[] calls = new int[1];
      int[] point = new int[] { 100, 0 };
      var resolver = new PointerAnchorResolver();
      var live = new List<MultiPointerAnimator.PointerTarget> { spawn };
      var release = T("a", 0, 0, 2, "release", null, true);
      release.HeadingDeg = 90f; release.HeadingRestore = false;
      var res = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { release }, Succeed(calls, point), Live(live), null);
      if (res.Count != 1) throw new Exception("release must resolve");
      animator.Sync(res, 0.0);
      animator.Advance(400.0);
      float heading;
      if (!animator.TryGetHeading("a\u001f1", out heading)) throw new Exception("release heading must be available");
      // Rendered (0,0) -> sampled cursor (100,0) is straight right: 0 - (-135) = 135.
      Near(heading, 135.0, "release must aim the tip at the sampled cursor");
    }

    // 18: a stale writer heading never survives a release; the resolver clears it
    // so the animator owns the return direction.
    static void ReleaseDropsStaleWriterHeading() {
      var resolver = new PointerAnchorResolver();
      int[] calls = new int[1];
      int[] point = new int[] { 40, 40 };
      var spawn = T("a", 10, 10, 1, "spawn", null, true);
      Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { spawn }, Succeed(calls, point), null, null);
      var release = T("a", 10, 10, 2, "release", null, true);
      release.HeadingDeg = 45f;
      var res = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { release }, Succeed(calls, point), Live(new List<MultiPointerAnimator.PointerTarget> { spawn }), null);
      if (res.Count != 1) throw new Exception("release must resolve");
      if (!Single.IsNaN(res[0].HeadingDeg)) throw new Exception("release must drop the writer heading");
      if (!res[0].HeadingRestore) throw new Exception("release must restore the canonical tip");
    }

    // 16: expiry removes only the released marker, never the other agents.
    static void ReleaseExpiryKeepsOtherPointers() {
      var animator = new MultiPointerAnimator();
      animator.Sync(new List<MultiPointerAnimator.PointerTarget> { T("a", 0, 0, 1, null, null, true), T("b", 50, 50, 1, null, null, true) }, 0.0);
      var release = T("a", 100, 100, 2, null, null, true);
      release.RemoveWhenHidden = true; release.Opacity = 0f; release.MotionMs = 200.0;
      animator.Sync(new List<MultiPointerAnimator.PointerTarget> { release, T("b", 50, 50, 1, null, null, true) }, 20.0);
      animator.Advance(400.0);
      if (animator.Count != 1) throw new Exception("expiry must remove only the released pointer");
      if (!animator.ContainsKey("b\u001f1")) throw new Exception("other pointer must survive expiry");
    }

    // 19: after the pointer was merged back and the animator dropped it, a stale
    // spawn row that the writer still rewrites must not resurrect it.
    static void SpawnAfterMergeStaysGone() {
      var resolver = new PointerAnchorResolver();
      int[] calls = new int[1];
      int[] point = new int[] { 30, 40 };
      var spawn = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("a", 10, 10, 1, "spawn", null, true) }, Succeed(calls, point), null, null);
      if (spawn.Count != 1) throw new Exception("spawn must resolve");
      var release = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("a", 10, 10, 2, "release", null, true) }, Succeed(calls, point), null, null);
      if (release.Count != 1) throw new Exception("release must resolve");
      if (calls[0] != 2) throw new Exception("spawn and release must each sample once");

      // The animator already dropped the pointer; the writer still rewrites the
      // spawn row until its own sweep removes the entry.
      var evidence = new List<string>();
      var again = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("a", 10, 10, 1, "spawn", null, true) },
        Succeed(calls, point), delegate (string key) { return false; }, evidence);
      if (again.Count != 0) throw new Exception("a spawn after merge must not resurrect the pointer");
      if (evidence.Count == 0) throw new Exception("resurrection must be reported as evidence");
      if (calls[0] != 2) throw new Exception("a stale spawn after merge must not sample again");
    }

    // 20: the same for the release row: once the fade expired and the animator
    // dropped the marker, repeating the row must stay gone and must not sample.
    static void RepeatReleaseAfterMergeStaysGone() {
      var resolver = new PointerAnchorResolver();
      int[] calls = new int[1];
      int[] point = new int[] { 30, 40 };
      var spawn = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("a", 10, 10, 1, "spawn", null, true) }, Succeed(calls, point), null, null);
      if (spawn.Count != 1) throw new Exception("spawn must resolve");
      var release = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("a", 10, 10, 2, "release", null, true) }, Succeed(calls, point), null, null);
      if (release.Count != 1) throw new Exception("release must resolve");

      var evidence = new List<string>();
      var again = Resolve(resolver, new List<MultiPointerAnimator.PointerTarget> { T("a", 10, 10, 2, "release", null, true) },
        Succeed(calls, point), delegate (string key) { return false; }, evidence);
      if (again.Count != 0) throw new Exception("a merged release must not be revived");
      if (evidence.Count == 0) throw new Exception("the merged release must be reported as evidence");
      if (calls[0] != 2) throw new Exception("a merged release must not sample again");
    }
  }
}
