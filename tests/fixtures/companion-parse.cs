using System;
using System.Collections.Generic;
using System.Drawing;
using System.Text;

// Pure, window-free assertions for the Companion contract: the schema-1 live
// JSON -> view parse (CompanionParse) and the card-stack geometry
// (CompanionLayout). Compiled together with scripts/windows-takeover.cs by
// tests/desktopCompanionOverlay.test.ts. Never constructs a CompanionFrame,
// never opens a window, never injects input.
namespace DshTakeover {
// Public so Add-Type -PassThru can resolve the type and its Run() method, the
// same contract the pointer fixtures use.
public static class CompanionParseTests {
  static int ok;
  static void Check(bool cond, string name) { if (!cond) throw new Exception("companion parse failed: " + name); ok++; }
  public static string Run() {
    ok = 0;
    // 1: disabled payload -> no rows, not enabled
    var disabled = CompanionParse.Parse("{\"schema\":1,\"epoch\":0,\"enabled\":false,\"task\":\"\",\"banner\":{\"text\":\"\"},\"thinking\":{\"visible\":false,\"status\":\"idle\"},\"rows\":[]}");
    Check(!disabled.Enabled && disabled.Rows.Count == 0, "DisabledEmptyPayload");
    // 2: enabled flag + epoch carried
    var one = CompanionParse.Parse("{\"schema\":1,\"epoch\":42,\"enabled\":true,\"task\":\"\",\"banner\":{\"text\":\"\"},\"thinking\":{},\"rows\":[]}");
    Check(one.Enabled && one.Epoch == 42, "EnabledAndEpoch");
    // 3: banner text
    var ban = CompanionParse.Parse("{\"enabled\":true,\"epoch\":1,\"banner\":{\"text\":\"DSH正在完成任务A\"},\"thinking\":{},\"rows\":[]}");
    Check(ban.BannerText == "DSH正在完成任务A", "BannerText");
    // 4: task field
    var task = CompanionParse.Parse("{\"enabled\":true,\"epoch\":1,\"task\":\"整理报表\",\"banner\":{\"text\":\"x\"},\"thinking\":{},\"rows\":[]}");
    Check(task.Task == "整理报表", "TaskField");
    // 5: root thinking status/action
    var th = CompanionParse.Parse("{\"enabled\":true,\"epoch\":1,\"thinking\":{\"visible\":true,\"status\":\"acting\",\"action\":\"执行命令\"},\"rows\":[]}");
    Check(th.ThinkingVisible && th.ThinkingStatus == "acting" && th.ThinkingAction == "执行命令", "ThinkingRootStatus");
    // 6: missing status defaults to idle
    var thi = CompanionParse.Parse("{\"enabled\":true,\"epoch\":1,\"thinking\":{},\"rows\":[]}");
    Check(thi.ThinkingStatus == "idle", "ThinkingIdleDefault");
    // 7: rows sorted by ordinal asc
    var sorted = CompanionParse.Parse("{\"enabled\":true,\"epoch\":1,\"rows\":[{\"ordinal\":3,\"label\":\"C\"},{\"ordinal\":1,\"label\":\"A\"},{\"ordinal\":2,\"label\":\"B\"}]}");
    Check(sorted.Rows.Count == 3 && sorted.Rows[0].Ordinal == 1 && sorted.Rows[1].Ordinal == 2 && sorted.Rows[2].Ordinal == 3, "RowsSortedByOrdinal");
    // 8: no logical cap — a large fleet keeps every row (no 8/10 truncation)
    var sb = new StringBuilder("{\"enabled\":true,\"epoch\":1,\"rows\":[");
    for (int i = 1; i <= 34; i++) { if (i > 1) sb.Append(','); sb.Append("{\"ordinal\":" + i + ",\"label\":\"A" + i + "\"}"); }
    sb.Append("]}");
    var many = CompanionParse.Parse(sb.ToString());
    Check(many.Rows.Count == 34 && many.Rows[33].Ordinal == 34, "NoRowCapKeepsAll");
    // 9: label + state
    var label = CompanionParse.Parse("{\"enabled\":true,\"epoch\":1,\"rows\":[{\"ordinal\":1,\"label\":\"Agent A\",\"state\":\"acting\"}]}");
    Check(label.Rows.Count == 1 && label.Rows[0].Label == "Agent A" && label.Rows[0].State == "acting", "RowLabelState");
    // 10: action prefers last.label
    var al = CompanionParse.Parse("{\"enabled\":true,\"epoch\":1,\"rows\":[{\"ordinal\":1,\"last\":{\"kind\":\"move\",\"label\":\"点击确定\"}}]}");
    Check(al.Rows[0].Action == "点击确定", "RowActionFromLabel");
    // 11: action falls back to kind
    var ak = CompanionParse.Parse("{\"enabled\":true,\"epoch\":1,\"rows\":[{\"ordinal\":1,\"last\":{\"kind\":\"drag\",\"label\":\"\"}}]}");
    Check(ak.Rows[0].Action == "drag", "RowActionFromKind");
    // 12: reason/app/ok
    var ra = CompanionParse.Parse("{\"enabled\":true,\"epoch\":1,\"rows\":[{\"ordinal\":1,\"last\":{\"kind\":\"click\",\"reason\":\"ok\",\"app\":\"notepad\",\"ok\":true}}]}");
    Check(ra.Rows[0].Reason == "ok" && ra.Rows[0].App == "notepad" && ra.Rows[0].Ok, "RowReasonApp");
    // 13: idle state preserved
    var idle = CompanionParse.Parse("{\"enabled\":true,\"epoch\":1,\"rows\":[{\"ordinal\":1,\"state\":\"idle\"}]}");
    Check(idle.Rows[0].State == "idle", "RowIdleState");
    // 14: invalid json is safe
    var bad = CompanionParse.Parse("not json");
    Check(!bad.Enabled && bad.Rows.Count == 0, "InvalidJsonSafe");
    // 15: empty string is safe
    var empty = CompanionParse.Parse("");
    Check(!empty.Enabled && empty.Rows.Count == 0, "EmptyStringSafe");
    // 16+: one rounded card per sub-agent, stacked in ordinal order
    LayoutOneCardPerAgent();
    LayoutRootIsNeverACard();
    LayoutCaptionSitsAboveCards();
    LayoutStackGapsAreEqual();
    LayoutCardsNeverOverlap();
    LayoutKeepsEveryAgentAt34();
    LayoutDropsDetailBeforeAgents();
    LayoutScaleScalesGeometry();
    LayoutEmptyAndDisabledAreBlank();
    LayoutActingIsMarked();
    LayoutRootThinkingStaysInCaption();
    return "COMPANION_PARSE_OK " + ok;
  }

  // ---- card-stack geometry (CompanionLayout): one rounded card per sub-agent ----
  static CompanionView V(bool enabled, string rootId, string banner, string task, params CompanionRow[] rows) {
    var v = new CompanionView();
    v.Enabled = enabled; v.RootId = rootId; v.BannerText = banner; v.Task = task;
    if (rows != null) v.Rows.AddRange(rows);
    return v;
  }
  static CompanionRow R(int ordinal, string agentId, string label, string state, string action) {
    var r = new CompanionRow();
    r.Ordinal = ordinal; r.AgentId = agentId; r.Label = label; r.State = state; r.Action = action;
    return r;
  }

  static void LayoutOneCardPerAgent() {
    var view = V(true, "", "DSH正在完成任务A", "", R(1, "a1", "Agent 1", "acting", ""), R(2, "a2", "Agent 2", "idle", ""), R(3, "a3", "Agent 3", "idle", ""));
    var layout = CompanionLayout.Build(view, 1f, 600);
    Check(layout.Cards.Count == 3, "LayoutCardsPerRow");
    Check(layout.Cards[0].AgentId == "a1" && layout.Cards[2].AgentId == "a3", "LayoutCardsKeepAgentIds");
  }

  static void LayoutRootIsNeverACard() {
    var view = V(true, "root", "DSH正在完成任务A", "", R(1, "root", "root", "acting", ""), R(2, "a1", "Agent 1", "acting", ""), R(3, "a2", "Agent 2", "idle", ""));
    var layout = CompanionLayout.Build(view, 1f, 600);
    Check(layout.Cards.Count == 2, "LayoutRootExcludedFromCards");
    bool leaked = false;
    foreach (var card in layout.Cards) if (card.AgentId == "root") leaked = true;
    Check(!leaked, "LayoutNoRootCard");
  }

  static void LayoutCaptionSitsAboveCards() {
    var view = V(true, "", "DSH正在完成任务A", "", R(1, "a1", "Agent 1", "idle", ""));
    var layout = CompanionLayout.Build(view, 1f, 600);
    Check(layout.Caption.Count >= 1, "LayoutCaptionPresent");
    Check(layout.Cards[0].Bounds.Top == layout.Outer + layout.CaptionHeight + layout.Gap, "LayoutCaptionAboveCards");
    Check(layout.CaptionHeight == layout.Caption.Count * layout.LineHeight, "LayoutCaptionHeight");
  }

  static void LayoutStackGapsAreEqual() {
    var view = V(true, "", "b", "", R(1, "a1", "A1", "idle", ""), R(2, "a2", "A2", "idle", ""), R(3, "a3", "A3", "idle", ""));
    var layout = CompanionLayout.Build(view, 1f, 600);
    Check(layout.Gap == CompanionLayout.Px(4f, 1f), "LayoutGapScaled");
    Check(layout.Cards[1].Bounds.Top - layout.Cards[0].Bounds.Bottom == layout.Gap, "LayoutGapBetweenCards1");
    Check(layout.Cards[2].Bounds.Top - layout.Cards[1].Bounds.Bottom == layout.Gap, "LayoutGapBetweenCards2");
    Check(layout.Cards[0].Bounds.Left == layout.Outer, "LayoutCardsStartAtOuter");
    Check(layout.Cards[0].Bounds.Width == layout.Width - 2 * layout.Outer, "LayoutCardsFullWidth");
  }

  static void LayoutCardsNeverOverlap() {
    var rows = new CompanionRow[12];
    for (int i = 0; i < rows.Length; i++) rows[i] = R(i + 1, "a" + (i + 1), "Agent " + (i + 1), "acting", "点击确定");
    var layout = CompanionLayout.Build(V(true, "", "b", "", rows), 1f, 600);
    Check(layout.Cards.Count == 12, "LayoutTwelveCards");
    bool overlap = false, ascending = true;
    for (int i = 1; i < layout.Cards.Count; i++) {
      if (layout.Cards[i].Bounds.Top < layout.Cards[i - 1].Bounds.Bottom) overlap = true;
      if (layout.Cards[i].Ordinal < layout.Cards[i - 1].Ordinal) ascending = false;
    }
    Check(!overlap, "LayoutNoOverlap");
    Check(ascending, "LayoutOrdinalsStable");
  }

  static void LayoutKeepsEveryAgentAt34() {
    var rows = new CompanionRow[34];
    for (int i = 0; i < rows.Length; i++) rows[i] = R(i + 1, "a" + (i + 1), "Agent " + (i + 1), "idle", "");
    var layout = CompanionLayout.Build(V(true, "", "b", "", rows), 1f, 600);
    // A ten-agent fleet (or larger) must never lose a member to a row cap.
    Check(layout.Cards.Count == 34, "LayoutNoAgentDroppedAt34");
    Check(layout.Cards[33].Ordinal == 34, "LayoutLastAgentKept");
    // Overflow is reported, never resolved by dropping a member.
    Check(layout.Clipped, "LayoutOverflowIsMarkedNotDropped");
  }

  static void LayoutDropsDetailBeforeAgents() {
    var rows = new CompanionRow[4];
    for (int i = 0; i < rows.Length; i++) rows[i] = R(i + 1, "a" + (i + 1), "Agent " + (i + 1), "acting", "点击确定");
    var view = V(true, "", "b", "", rows);
    var roomy = CompanionLayout.Build(view, 1f, 600);
    Check(roomy.Cards.Count == 4 && roomy.Cards[0].Lines.Count == 2, "LayoutDetailWhenRoomy");
    var tight = CompanionLayout.Build(view, 1f, 150);
    Check(tight.Cards.Count == 4, "LayoutKeepsAllAgentsWhenTight");
    bool single = true;
    foreach (var card in tight.Cards) if (card.Lines.Count != 1) single = false;
    Check(single, "LayoutDropsDetailNotAgents");
    Check(tight.LineHeight >= CompanionLayout.Px(11f, 1f), "LayoutMinLineHeight");
  }

  static void LayoutScaleScalesGeometry() {
    var layout = CompanionLayout.Build(V(true, "", "b", "", R(1, "a1", "A1", "idle", "")), 2f, 2000);
    Check(layout.Outer == CompanionLayout.Px(2f, 2f), "LayoutScaleOuter");
    Check(layout.Padding == CompanionLayout.Px(6f, 2f), "LayoutScalePadding");
    Check(layout.Gap == CompanionLayout.Px(4f, 2f), "LayoutScaleGap");
    Check(layout.Radius == CompanionLayout.Px(8f, 2f), "LayoutScaleRadius");
    Check(layout.Width == CompanionLayout.Px(300f, 2f), "LayoutScaleWidth");
    Check(layout.Cards[0].Bounds.Left == layout.Outer && layout.Cards[0].Bounds.Width == layout.Width - 2 * layout.Outer, "LayoutScaleCardBox");
  }

  static void LayoutEmptyAndDisabledAreBlank() {
    var none = CompanionLayout.Build(null, 1f, 600);
    Check(!none.HasContent && none.Cards.Count == 0, "LayoutNullViewIsEmpty");
    var off = CompanionLayout.Build(V(false, "", "", ""), 1f, 600);
    Check(!off.HasContent && off.Cards.Count == 0, "LayoutDisabledIsEmpty");
  }

  static void LayoutActingIsMarked() {
    var layout = CompanionLayout.Build(V(true, "", "b", "", R(1, "a1", "Agent 1", "acting", ""), R(2, "a2", "Agent 2", "idle", "")), 1f, 600);
    Check(layout.Cards[0].Acting && !layout.Cards[1].Acting, "LayoutActingFlag");
    Check(layout.Cards[0].Lines[0].Acting, "LayoutActingLineFlag");
    Check(layout.Cards[0].Lines[0].Text.Contains("执行中"), "LayoutActingText");
  }

  static void LayoutRootThinkingStaysInCaption() {
    var view = V(true, "root", "b", "");
    view.ThinkingVisible = true; view.ThinkingStatus = "acting"; view.ThinkingAction = "执行命令";
    var layout = CompanionLayout.Build(view, 1f, 600);
    bool inCaption = false;
    for (int i = 0; i < layout.Caption.Count; i++) if (layout.Caption[i].Text.Contains("执行命令")) inCaption = true;
    Check(inCaption, "LayoutRootThinkingInCaption");
    Check(layout.Cards.Count == 0, "LayoutRootThinkingIsNotACard");
  }
}
}
