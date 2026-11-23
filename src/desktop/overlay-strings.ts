/**
 * 浮窗界面文案（从 dsh-computer-use-win 的 overlay-strings.mjs 移植，MIT）。
 * C# 助手的 Words 表初始为空，找不到 key 时会把键名直接画出来，
 * 所以每个 begin/configure/progress 命令都必须带上这份 strings。
 * {0}, {1} 按顺序填充；未知语言读英文。
 */
export const OVERLAY_STRINGS = {
  zh: {
  "indicatorDefault": "DSH 正在控制电脑",
  "stopHint": "停止",
  "headerWorking": "DSH · 第 {0} 步 · {1}",
  "headerDone": "DSH · 已完成 · {0} 步{1}",
  "headerDoneOne": "DSH · 已完成 · {0} 步{1}",
  "headerDoneFew": "DSH · 已完成 · {0} 步{1}",
  "headerFailed": "DSH · 出错 · 第 {0} 步",
  "headerStopped": "DSH · 已停止 · 第 {0} 步",
  "took": " · {0} 秒",
  "statusThinking": "思考中",
  "statusActing": "执行中",
  "statusReplying": "回复中",
  "statusStopped": "已停止",
  "statusWorking": "处理中",
  "stepHeading": "第 {0} 步",
  "stepActions": "第 {0} 步 · {1}",
  "listSeparator": "、",
  "actionError": "{0}（出错）",
  "summaryResult": "AI 总结 · 结果",
  "summaryStep": "AI 总结 · 第 {0} 步",
  "summaryUnavailable": "总结暂不可用，先显示操作步骤。",
  "summarizingResult": "正在总结结果…",
  "summarizing": "正在生成总结…",
  "thinkingHeading": "思考",
  "replyHeading": "回复",
  "waiting": "等待 DSH 输出…",
  "image": "（图片）",
  "imageNamed": "（图片：{0}）",
  "hintUnlocked": "拖标题移动 · 边缘缩放 · 移开后自动锁定",
  "hintPreview": "拖标题移动 · 边缘缩放 · 点 × 完成调整",
  "hintAdjust": "拖标题移动 · 边缘缩放 · 滚动查看"
},
  en: {
  "indicatorDefault": "DSH is controlling your computer",
  "stopHint": "Stop",
  "headerWorking": "DSH · Step {0} · {1}",
  "headerDone": "DSH · Done · {0} steps{1}",
  "headerDoneOne": "DSH · Done · {0} step{1}",
  "headerDoneFew": "DSH · Done · {0} steps{1}",
  "headerFailed": "DSH · Error · step {0}",
  "headerStopped": "DSH · Stopped · step {0}",
  "took": " · {0} s",
  "statusThinking": "Thinking",
  "statusActing": "Acting",
  "statusReplying": "Replying",
  "statusStopped": "Stopped",
  "statusWorking": "Working",
  "stepHeading": "Step {0}",
  "stepActions": "Step {0} · {1}",
  "listSeparator": ", ",
  "actionError": "{0} (error)",
  "summaryResult": "AI summary · Result",
  "summaryStep": "AI summary · Step {0}",
  "summaryUnavailable": "No summary right now; showing the steps.",
  "summarizingResult": "Summarizing the result…",
  "summarizing": "Writing a summary…",
  "thinkingHeading": "Thinking",
  "replyHeading": "Reply",
  "waiting": "Waiting for DSH…",
  "image": "(image)",
  "imageNamed": "(image: {0})",
  "hintUnlocked": "Drag title to move · edges to resize · locks on leave",
  "hintPreview": "Drag title to move · edges to resize · click × when done",
  "hintAdjust": "Drag title to move · edges to resize · scroll to read"
},
} as const;

/** BCP 47 标签按语言段匹配已收录的字典，其余读英文。 */
export const overlayLocale = (tag?: string): keyof typeof OVERLAY_STRINGS => {
  const language = String(tag ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return language in OVERLAY_STRINGS ? (language as keyof typeof OVERLAY_STRINGS) : 'en';
};

/** C# 助手消费的字符串表（helperKeys 的完整覆盖）。 */
export const helperStrings = (locale?: string) => OVERLAY_STRINGS[overlayLocale(locale)];
