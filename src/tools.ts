import { errorText } from './shared/faults.ts';
import type { Image } from './shared/image.ts';
import { defineTool, type ToolResult, type ToolSpec } from './tool.ts';
import { PAGE_KEYS, type Page, type Row } from './browser/page.ts';
import type { Browser } from './browser/browser.ts';
import type { ProcedureLibrary } from './procedures/library.ts';
import { catalogText } from './procedures/catalog.ts';
import { messageRecords, type MessageSink } from './procedures/messages.ts';
import { checkArgs, cut, failureText, fallbackText, noteRun, resultText, runVersions, type Args } from './procedures/run.ts';
import { desktopAdvice, isWebAddress, WEB_ONLY, type MessageMap } from './procedures/format.ts';
import { DESKTOP_KEYS, type Desktop, type DesktopInput, type DesktopResult } from './desktop/desktop.ts';
import { DESKTOP_MODES, isDesktopMode, type DesktopMode } from './desktop/mode.ts';

/** 每一步都可以说为什么做：这句话原样写进审计，用户看得见 agent 的打算。 */
const REASON = { type: 'string' as const, description: '为什么做这一步，写进审计记录' };

const POLICY_NOTE = '按应用设置的前后台策略优先于当前模式：策略要前台的程序会先申请管理员权限，用户拒绝时这一步失败；策略要后台的程序只把输入投给它的窗口。';

const DESKTOP_NOTE = `操作用户的电脑（后台模式）：看当前窗口的截图，按图上的像素操作；输入直接投给那个窗口，不动用户的鼠标、不抢焦点，用户用着电脑也能用。学会的操作先用 computer_use 找。以管理员权限运行的程序（很多游戏）后台够不着，要用就请用户切到前台模式。action 取一种：open（app 写程序名，打开它当作当前窗口，托盘里的会点开；path 写 exe 启动它；file 写文档用默认程序打开；url 写网址，用 agent 自己的后台浏览器（CDP，独立窗口）打开并截它的窗口，不碰用户已开的 Edge/Chrome、不抢焦点；不写就列出开着的窗口）｜shot（再截一张）｜click（x、y 是截图上的像素；double 双击，right 右键，hold 按住几秒是长按）｜drag（从 x、y 按住拖到 x2、y2 松开；hold 先按住几秒再拖，right 用右键）｜type（text；给 x、y 就先点那里；submit 再回车）｜press（key：${DESKTOP_KEYS}；hold 按住几秒）｜scroll（direction 为 up/down/left/right，可加 x、y）｜zoom（截图上 x、y 到 x2、y2 放大看）｜record（看视频这类会动的：先让它播起来，录 seconds 秒，最多 600；every 每几秒一帧，默认 1；pause 为 false 时录完不暂停）｜stop（停下正在录的）｜review（看录好的：不带参数看全片，from、to 细看一段，at 看某一秒）。每步之后都有新截图，自己看做对了没有；没反应就换个办法，别重复同一下。每一步都可以给 reason（为什么做这一步），它会写进用户能看的审计。`;
/** Foreground mode: the same actions over the whole screen with the real mouse and keyboard. */
const SCREEN_NOTE = `操作用户的电脑（前台模式）：用户把电脑交给了你。看整个屏幕的截图，用真的鼠标键盘按图上的像素操作，游戏和管理员程序也能用；用户的鼠标会跟着动。用户连按两下 Esc 或点屏幕顶上的「停下」就停。action 和后台模式一样：open（把程序放到最前面，没开的会启动；path 写 exe 启动它；file 写文档用默认程序打开；url 写网址交给浏览器打开；不写 app 就列出窗口）｜close（关闭当前窗口）｜move（x、y 只移动鼠标不点击）｜shot｜click（x、y，double、right，hold 长按几秒）｜drag（x、y 拖到 x2、y2；hold 先按住几秒，right）｜type（text，可先给 x、y，submit）｜press（key：${DESKTOP_KEYS}；hold 按住几秒，比如游戏里按住 w 走路）｜scroll（direction，可加 x、y）｜zoom（x、y 到 x2、y2）｜record（seconds、every、pause）｜stop｜review（from、to 或 at）。走通的步骤可以 procedure_save 存成 where:"screen" 的操作，以后在前台模式下用 procedure_run 回放。每一步都可以给 reason（为什么做这一步），它会写进用户能看的审计。`;

export const FORMAT_NOTE = '格式不对时保存会被拒绝并说明哪里不对。文件是 JSON：name（操作名，中文也行，不含 / 和 .）、category（分类，比如 wechat、bilibili）、description、params（{名字:{type,required?}}）、steps。步骤各取一种：open｜click｜type {into,text}｜press｜wait {text|anchor|url,seconds?}｜check｜extract {list,fields,limit?}｜script（可 return，as 存成值）。锚点 {role?,name?,text?,css?,nth?（从 0 数）}，role、name 用 page_read 里看到的；extract 的字段可以只写 attr，读列表项自己。文字里的 {{参数}} 会代入。会向外发出的步骤标 outward:true。extract 一条都没有、某个字段每条都空、带 as 的 script 结果为空，都算没跑通；本来就可能为空的（比如没有未读）在那一步加 allowEmpty:true。check 最多等 3 秒。没跑通而且还没有向外的动作时，会依次试最近 2 个旧版本。onAlarm:true 表示例行操作，procedure_routines 时自动跑（不能有必填参数和 outward 步骤）；summary 可用 {{as 名}} 和 {{count}}。messages 把 extract 的字段记成消息：channel、conversationType 写死，accountId、conversationId、messageId、speakerId、content 必填，其余可选，都是 {{字段}} 模板，outgoing 算出 true 表示是你自己发的。\n用户电脑上用 desktop 走通的：后台模式写 where:"desktop"，前台模式写 where:"screen"（只能在前台模式下跑）。步骤各取一种：open（程序名或窗口标题，比如「微信」「朋友圈」）｜click {x,y,double?,right?,hold?}｜drag {x,y,x2,y2,right?,hold?}｜type {text,x?,y?}｜press（同 desktop 的按键，可加 hold）｜scroll {direction,x?,y?}｜wait {seconds}；每一步都能加 reason（为什么做，写进审计）。x、y 是 desktop 截图上的像素（desktop 是窗口的截图，screen 是整个屏幕的截图），大小变了会按比例跟着变。回放时步与步之间不停，手动做时等过的地方（点完才弹出的窗口）要写 wait。不能用 onAlarm、summary、messages。跑完会给最后一张截图，自己看做成了没有。';

export interface ToolsDeps {
  browser: Pick<Browser, 'run'>; library: ProcedureLibrary;
  /** Where what procedures read as messages is filed; without one the rows are only returned. */
  messages?: MessageSink;
  /** Background mode: one window, posted input. */
  desktop?: Pick<Desktop, 'act'>;
  /** Foreground mode is on: the desktop tool works the whole screen through these instead; saved operations still replay through `desktop`. */
  screen?: Pick<Desktop, 'act'>;
  /** Per-app policies: which mode this one step should run in; absent when the host has no policies. */
  pick?(input: Record<string, unknown>): Promise<{ live: Pick<Desktop, 'act'>; screen: boolean } | undefined>;
  /** The mode the user's computer is in now; absent when the host does not offer desktop control at all. */
  mode?(): DesktopMode;
  /** Switches that mode; returns why it could not, or nothing. Asked for `foreground` it goes through UAC. */
  setMode?(mode: DesktopMode): Promise<string | undefined>;
  /** The routine: every `onAlarm` procedure once, a line each. */
  routines(): Promise<string | undefined>;
  /** What the inbox gathered since it was last read; absent when the inbox is off. */
  inbox?(): string | undefined;
  /** 第一次使用或用户要求时：扫描软件位置并自测，返回一份报告的文字。 */
  init?(input: { full?: boolean; selftest?: boolean }): Promise<string>;
  /** What is broken right now, said when the agent asks what it can use. */
  health(): string[];
}

/**
 * The page tools and the catalog: what the agent learns is found with `computer_use` and run with `procedure_run`, so
 * the tool list stays the same however much it learns. Only the user's switches (desktop, inbox) change the list.
 */
export function computerTools(deps: ToolsDeps): ToolSpec[] {
  const run = <T>(work: (page: Page, signal: AbortSignal) => Promise<T>) => deps.browser.run(work);
  // Checked before anything is queued, so a bad argument never launches or waits on the browser.
  const whole = (value: unknown, message: string) => { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(message); return value as number; };
  const REF = 'ref 是 page_read 里方括号中的编号';
  const ref = (value: unknown) => ({ ref: whole(value, REF) });
  const where = (page: Page) => page.brief().then(text => text.split('\n')[0]);
  const page: ToolSpec[] = [
    defineTool({ name: 'page_open', description: '在专用浏览器里打开一个地址（浏览器没开会先打开它，窗口在桌面上，不用用户的鼠标键盘），返回页面上的元素和文字，同 page_read。要登录时请用户在那个窗口里扫码或输入，登录态会留下。', parameters: { url: { type: 'string', required: true }, reason: REASON },
      execute: async ({ url }) => { if (!isWebAddress(url)) throw new Error(WEB_ONLY); return run(async p => { await p.open(url); return p.read(); }); } }),
    defineTool({ name: 'page_read', description: '读当前页面：每个可操作元素一行，[编号] 角色 名称；编号在页面不跳转时一直有效。page 翻看更多元素，ref 只看某个元素里面。之后附可见文字（截断）。', parameters: { page: { type: 'integer' }, ref: { type: 'integer' }, reason: REASON },
      execute: async ({ page: index, ref: scope }) => {
        const options = { ...(index === undefined ? {} : { page: whole(index, 'page 应该是 1 以上的整数') }), ...(scope === undefined ? {} : ref(scope)) };
        return run(p => p.read(options));
      } }),
    defineTool({ name: 'page_click', description: '点 page_read 给出的编号。', parameters: { ref: { type: 'integer', required: true }, reason: REASON },
      execute: async args => { const target = ref(args.ref); return run(async p => { await p.click(target); return `已点击 [${args.ref}]，现在：${await where(p)}`; }); } }),
    defineTool({ name: 'page_type', description: '在编号对应的输入框里输入文字（整段输入，中文也行），框里原有的内容会被替换；submit 为 true 时再按回车。', parameters: { ref: { type: 'integer', required: true }, text: { type: 'string', required: true }, submit: { type: 'boolean' }, reason: REASON },
      execute: async args => { const target = ref(args.ref); return run(async p => { await p.type(target, args.text); if (args.submit) await p.press('Enter'); return `已输入，现在：${await where(p)}`; }); } }),
    defineTool({ name: 'page_press', description: `按一个键：${PAGE_KEYS.join('、')}。`, parameters: { key: { type: 'string', required: true }, reason: REASON },
      execute: async ({ key }) => run(async p => { await p.press(key); return `已按 ${key}，现在：${await where(p)}`; }) }),
    defineTool({ name: 'page_scroll', description: '滚动一屏左右：direction 为 up 或 down；给 ref 就在那个元素上滚。', parameters: { direction: { type: 'string', required: true }, ref: { type: 'integer' }, reason: REASON },
      execute: async args => {
        if (args.direction !== 'up' && args.direction !== 'down') throw new Error('direction 只能是 up 或 down');
        const direction = args.direction, target = args.ref === undefined ? undefined : ref(args.ref);
        return run(async p => { await p.scroll(direction, target); return '已滚动。'; });
      } }),
    defineTool({ name: 'page_wait', description: '等某段文字出现（text，最多等 seconds 秒，默认 10）；或检查某个编号的元素还在（ref，立即返回）。seconds 最多 60。', parameters: { text: { type: 'string' }, ref: { type: 'integer' }, seconds: { type: 'number' }, reason: REASON },
      execute: async ({ text, ref: id, seconds = 10 }) => {
        if (text === undefined && id === undefined) throw new Error('要给 text 或 ref');
        if (text !== undefined && !text.trim()) throw new Error('text 不能是空的');
        const target = id === undefined ? undefined : whole(id, REF);
        if (seconds <= 0 || seconds > 60) throw new Error('seconds 应该在 0 到 60 之间');
        return run(async (p, signal) => {
          if (target !== undefined) { await p.read({ ref: target }); return `[${target}] 还在。`; }
          await p.wait({ text: text! }, seconds * 1000, signal); return `等到了「${text}」。`;
        });
      } }),
    defineTool({ name: 'page_shot', description: '截当前页面一张图；只在读文字看不明白时用，图片很占地方。', parameters: { reason: REASON },
      execute: async () => ({ text: '这是专用浏览器当前页面的截图。', images: [{ data: await run(p => p.shot()), mediaType: 'image/png' }] }) }),
    defineTool({ name: 'page_eval', description: '在当前页面里执行一段 JS（可 return 一个能转成 JSON 的值），只在专用浏览器的页面里，碰不到电脑上的文件。十秒超时，结果截到 2000 字。', parameters: { script: { type: 'string', required: true }, reason: REASON },
      execute: async ({ script }) => run(async p => cut(JSON.stringify(await p.evaluate(script, {})) ?? 'null', 2000)) }),
  ];
  const procedures: ToolSpec[] = [
    ...(deps.init ? [defineTool({ name: 'init', description: '第一次使用，或用户要求重新检查时：扫描这台电脑里的软件位置（加密保存，之后打开程序不用用户再报路径）并自测电脑操作能不能完成，返回一份报告。平时不用调；每次启动会自动做增量检查。', parameters: { full: { type: 'boolean', description: '完整重新扫描（默认整合已有结果做增量）' }, selftest: { type: 'boolean', description: '顺便跑自测（默认跑）' }, reason: REASON },
      execute: async ({ full, selftest }) => deps.init!({ ...(full === undefined ? {} : { full }), ...(selftest === undefined ? {} : { selftest }) }) })] : []),
    defineTool({ name: 'computer_use', description: '用电脑之前先说这次要用的程序或网站（target 只写对象，比如「微信」「B站」，不写要做的事），返回这一类的说明、学会的操作名和文件所在的文件夹；要看某个操作的参数和步骤就读它的文件。不说就列出现在能用的模块、学会的操作有哪些分类，以及哪里坏了。', parameters: { target: { type: 'string' }, reason: REASON },
      // Asked without naming anything, the agent is first told which modules it has right now, and what is broken.
      execute: async ({ target }) => target?.trim() ? catalogText(deps.library, target) : [modules(), catalogText(deps.library), health()].filter(Boolean).join('\n') }),
    defineTool({ name: 'procedure_run', description: '跑一个学会的操作：path 写「分类/操作」，args 是它声明的参数。不调模型，直接回放；没跑通会说第几步、为什么。', parameters: { path: { type: 'string', required: true }, args: { type: 'object' }, reason: REASON },
      execute: async ({ path, args }, context) => runStored(path, args ?? {}, context.signal) }),
    // The format is long and only needed when the agent writes one, so it is handed over on asking rather than sent with every step.
    defineTool({ name: 'procedure_save', description: `把用 page_* 或 desktop 走通的步骤存成一个操作，以后用 procedure_run 直接跑；同名覆盖、留下旧版本。文件在 ${deps.library.dir}，也可以直接改。json 是整份操作；第一次写或记不清格式，就不带 json 调一次，会给出完整的格式说明。`, parameters: { json: { type: 'string' }, reason: REASON },
      execute: async ({ json }) => {
        if (!json?.trim()) return `操作文件的格式：\n${FORMAT_NOTE}`;
        try {
          const { path, version } = deps.library.save(json);
          const advice = desktopAdvice(deps.library.get(path)!);
          return `已保存 ${path}（第 ${version} 版），可以用 procedure_run 跑了。${advice.length ? `\n先看看这几处：\n${advice.map(line => `- ${line}`).join('\n')}` : ''}`;
        }
        catch (error) { throw new Error(`没有保存：${errorText(error)}（完整格式：不带 json 调一次 procedure_save）`); }
      } }),
    defineTool({ name: 'procedure_note', description: '写某一类操作的说明：这一类对应哪个程序或网站（写上程序名、网址和别称，computer_use 靠它找到这一类）、要注意什么。整份替换，旧的留作版本，最多 1000 字。', parameters: { category: { type: 'string', required: true }, text: { type: 'string', required: true }, reason: REASON },
      execute: async ({ category, text }) => {
        try { return `已写好 ${category} 的说明（第 ${deps.library.saveGuide(category, text)} 版）。`; }
        catch (error) { throw new Error(`没有保存：${errorText(error)}`); }
      } }),
    defineTool({ name: 'procedure_routines', description: '把所有标了 onAlarm 的网页操作（例行操作，比如看各处的未读）各跑一次，在单独的标签页里，不动当前页面；每个操作一行结果，没跑通的照实说。', parameters: { reason: REASON },
      execute: async () => (await deps.routines()) ?? '没有例行操作：网页操作里写 "onAlarm": true 就会在这里跑。' }),
  ];
  const live = deps.screen ?? deps.desktop;
  const desktop: ToolSpec[] = !live ? [] : [
    defineTool({ name: 'desktop', description: (deps.screen ? SCREEN_NOTE : DESKTOP_NOTE) + (deps.pick ? POLICY_NOTE : ''), parameters: {
      action: { type: 'string', required: true }, app: { type: 'string' }, url: { type: 'string' }, path: { type: 'string' }, file: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
      double: { type: 'boolean' }, right: { type: 'boolean' }, hold: { type: 'number' }, text: { type: 'string' }, stream: { type: 'boolean' }, submit: { type: 'boolean' }, key: { type: 'string' }, direction: { type: 'string' },
      seconds: { type: 'number' }, every: { type: 'number' }, from: { type: 'number' }, to: { type: 'number' }, at: { type: 'number' }, pause: { type: 'boolean' }, reason: REASON,
    }, execute: async (input, context) => {
      context.signal.throwIfAborted();
      const routed = deps.pick ? await deps.pick(input) : undefined;
      const wholeScreen = routed ? routed.screen : deps.screen !== undefined;
      return pictured(await (routed?.live ?? live).act(input), wholeScreen ? '这是用户电脑整个屏幕的截图。' : '这是用户电脑上当前窗口的截图。');
    } }),
  ];
  const inbox = deps.inbox;
  /** The switch itself stays offered whatever the mode, or turning it back on could only be done outside the agent. */
  const switching: ToolSpec[] = !deps.setMode ? [] : [
    defineTool({ name: 'desktop_mode', description: `设置怎么操作用户的电脑，现在：${deps.mode?.() ?? 'off'}。mode 取 off（关掉，不再用用户的电脑）｜background（后台：只往当前窗口投递输入，不动用户的鼠标、不抢焦点，用户用着电脑也能用）｜foreground（前台：整个屏幕，真的鼠标键盘，用户的鼠标会跟着动，要管理员权限）。切到前台等于接管用户的鼠标键盘，必须先问用户同不同意，同意了再带 confirm: true 调用；不带 confirm 不会去请求管理员权限。从后台切到前台失败时后台模式会留着。`, parameters: {
      mode: { type: 'string', required: true }, confirm: { type: 'boolean', description: '切到前台要用户明确同意，传 true' }, reason: REASON,
    }, execute: async ({ mode, confirm }) => {
      if (!isDesktopMode(mode)) throw new Error(`mode 只能是 ${DESKTOP_MODES.join('、')}`);
      if (mode === 'foreground' && confirm !== true) return '还没有切换：前台模式会接管用户的鼠标键盘，并请用户确认管理员权限。先问用户同不同意，同意了再带 confirm: true 调用。';
      const why = await deps.setMode!(mode);
      if (why) return mode === 'foreground' && deps.mode?.() === 'background' ? `前台模式没有打开，仍保持后台模式：${why}` : `没能切换：${why}`;
      return mode === 'off' ? '已关闭桌面控制。' : mode === 'background' ? '已切换到后台模式：只向目标窗口投递输入，不动用户的鼠标、不抢焦点。' : '已切换到前台模式：整个屏幕，使用真实的鼠标和键盘。';
    } }),
  ];
  const mail: ToolSpec[] = !inbox ? [] : [
    defineTool({ name: 'inbox_read', description: '看信箱：任务栏上有程序在闪、或者来了系统通知时，这里汇总一句（每个程序一行）。只告诉你有动静，不替你打开；看不看、回不回你自己定。', parameters: { reason: REASON },
      execute: async () => inbox() ?? '信箱里没有新的动静。' }),
  ];
  return [...page, ...procedures, ...switching, ...desktop, ...mail];

  /** The modules the agent can use now; the desktop line follows its switch and mode. */
  function modules(): string {
    // 按应用策略可能同时借来前台助手，所以先看用户自己选的是哪个模式，只有没给 mode 时才按有没有整屏工具来猜。
    const chosen = deps.mode?.();
    const whole = chosen === 'foreground' || (chosen === undefined && deps.screen !== undefined);
    const desktop = deps.desktop || deps.screen ? `desktop（用户的电脑，${whole ? '前台模式：整个屏幕，真的鼠标键盘' : '后台模式：一个窗口，不动用户的鼠标'}）` : '';
    const switching = deps.setMode ? `desktop_mode（关闭、后台、前台之间切换，现在：${deps.mode?.() ?? 'off'}）` : '';
    return `现在能用：page_*（专用浏览器）、${desktop ? `${desktop}、` : ''}${switching ? `${switching}、` : ''}procedure_*（学会的操作）${inbox ? '、inbox_read（信箱）' : ''}。`;
  }
  function health(): string {
    const faults = deps.health();
    return faults.length ? `现在有问题的：\n${faults.map(line => `- ${line}`).join('\n')}` : '';
  }
  function pictured(result: DesktopResult, caption: string): ToolResult {
    if (!result.image) return { text: result.text };
    const image: Image = { ...result.image, caption: result.image.caption ?? caption };
    return { text: result.text, images: [image] };
  }

  /** Filing what was read must never cost the read itself, so a failure is a line after the result. */
  async function filed(path: string, map: MessageMap, rows: Row[], args: Args): Promise<string> {
    if (!deps.messages) return '';
    try {
      const { records, skipped } = messageRecords(path, map, rows, args);
      const { written } = records.length ? await deps.messages.record(records) : { written: 0 };
      return `\n新记进消息记录 ${written} 条${skipped ? `，跳过 ${skipped} 条缺字段的` : ''}。`;
    } catch (error) { return `\n（没能记进消息记录：${errorText(error)}）`; }
  }

  /** A saved operation, newest version first, falling back to the ones it replaced. */
  async function runStored(path: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const procedure = deps.library.get(path);
    if (!procedure) throw new Error(`没有 ${path} 这个操作，先用 computer_use 看看有哪些`);
    checkArgs(procedure, input);
    const kept = deps.library.kept(path);
    // Each mode replays what was found in it: one window in the background, the whole screen in the foreground.
    const live = procedure.where === 'screen' ? deps.screen : procedure.where === 'desktop' ? deps.desktop : undefined;
    if (procedure.where === 'desktop' && !live) throw new Error(`${path} 是用户电脑上的操作（后台模式），要用户先打开桌面控制`);
    if (procedure.where === 'screen' && !live) throw new Error(`${path} 是在整个屏幕上做的操作（前台模式），要请用户把桌面控制切到前台模式`);
    let outcome, last: DesktopResult['image'];
    // On the desktop every step answers with a picture; the last one is what the run is checked by.
    const hands = live && { act: async (step: DesktopInput) => { const result = await live.act(step); last = result.image ?? last; return result; } };
    try {
      outcome = procedure.where !== undefined
        ? await runVersions(procedure, kept, input, hands!, signal)
        : await run((p, queued) => runVersions(procedure, kept, input, p, AbortSignal.any([queued, signal])));
    } catch (error) { noteRun(deps.library, path, { thrown: error }); throw error; }
    noteRun(deps.library, path, outcome);
    const { result, ran, fallback } = outcome;
    const images: Image[] = last ? [{ ...last, caption: '这是操作跑完时用户电脑上的截图。' }] : [];
    const seen = last ? '\n最后一张截图附在结果里，看看做成了没有。' : '';
    if (!result.ok) return { text: failureText(path, result) + seen, images };
    if (procedure.where !== undefined) return { text: '做完了。' + (fallback ? `（${fallbackText(fallback)}趁现在用 desktop 把最新版走通再存。）` : '') + (seen || '（没有截图，用 desktop shot 看看结果）'), images };
    // The version that ran declares what it read, and its own arguments are what fill the records.
    const messages = ran.messages && result.rows.length ? await filed(path, ran.messages, result.rows, checkArgs(ran, input)) : '';
    return { text: resultText(result) + messages + (fallback ? `\n（${fallbackText(fallback)}页面可能改了，或新旧页面并存。趁现在修：用 page_* 看看现在的页面，改好再 procedure_save，新旧页面都要能跑。）` : '') };
  }
}
