import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopKey, dragged, holdMs, IMAGE_EDGE, largest, NOTCHES, pressed, VK, windowsNamed, ZOOM_GROW, type DesktopInput, type Listed } from './desktop.ts';
import { bannerText, readAppearance } from '../appearance.ts';
import type { AuditSink } from '../audit.ts';
import type { DesktopDriver } from './driver.ts';
import { createRecording } from './recording.ts';
import { createTurns, type DesktopResult } from './turns.ts';
import { watching } from './watching.ts';

export type Screen = ReturnType<typeof createScreen>;
const SETTLE_MS = 400, APPEAR_MS = 10_000, WINDOWS_SHOWN = 30;
/** The last picture of the screen: how many screen pixels one picture pixel is, its size, and where the screen starts. */
interface View { scale: number; width: number; height: number; left: number; top: number }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Here the agent has the whole computer: the sign stays up between the agent's steps, which take the agent a while to think out. */
const SCREEN_LINGER_MS = 30_000;

/**
 * Foreground mode: the user hands the agent the computer. The agent sees the whole screen and acts with the real mouse and
 * keyboard, so every program answers it, games and administrators' windows too. `hands` is the helper the user
 * approved as administrator: pictures, input and the sign go through it, so its stop key works over any window.
 * `eyes` is the ordinary helper: listing windows and starting programs stay out of the administrator's reach, so
 * nothing the agent opens runs as administrator. One action at a time; the user's stop works as in background mode.
 */
export function createScreen(deps: {
  hands: Pick<DesktopDriver, 'call'>; eyes: Pick<DesktopDriver, 'call'>;
  companion?(): string; signFault?(text: string | undefined): void;
  /** 审计：agent 在用户电脑上的每一步都记一条，给用户看的那个窗口读。 */
  audit?: AuditSink;
  settleMs?: number; appearMs?: number; secondMs?: number; lingerMs?: number;
}) {
  const settleMs = deps.settleMs ?? SETTLE_MS, appearMs = deps.appearMs ?? APPEAR_MS;
  let view: View | undefined, shots = 0, front: string | undefined, frontInfo: { exe?: string; title?: string } | undefined, frontHwnd: number | undefined;
  const wrap = (driver: Pick<DesktopDriver, 'call'>) => (op: string, args: Record<string, unknown> = {}) => driver.call(op, args).catch((error: unknown) => {
    throw new Error(`没做成：${error instanceof Error ? error.message : String(error)}`);
  });
  const hands = wrap(deps.hands), eyes = wrap(deps.eyes);
  const recording = createRecording({ call: hands, ...(deps.secondMs === undefined ? {} : { secondMs: deps.secondMs }) });
  const windows = async () => ((await eyes('windows')).windows as Listed[] | undefined) ?? [];

  /** A picture pixel to a screen pixel; outside the picture is refused. */
  function onScreen(x: unknown, y: unknown): { x: number; y: number; local: { x: number; y: number } } {
    if (!view) throw new Error('还没看过屏幕：先 desktop shot');
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error('要给 x、y（截图上的像素）');
    if (x < 0 || y < 0 || x > view.width || y > view.height) throw new Error(`x、y 要在截图里面（${view.width}×${view.height}）`);
    const local = { x: Math.round(x * view.scale), y: Math.round(y * view.scale) };
    return { x: local.x + view.left, y: local.y + view.top, local };
  }
  async function picture(region?: { x: number; y: number; w: number; h: number }, mark?: { x: number; y: number }) {
    const file = join(tmpdir(), `evolution-cu-screen-${process.pid}-${++shots}.png`);
    try {
      const shot = await hands('screen', { file, edge: IMAGE_EDGE, grow: region ? ZOOM_GROW : 1, ...(region ?? { x: 0, y: 0, w: 0, h: 0 }), markX: mark?.x ?? -1, markY: mark?.y ?? -1 });
      return { data: readFileSync(file), width: Number(shot.width), height: Number(shot.height), clientWidth: Number(shot.clientWidth), left: Number(shot.left ?? 0), top: Number(shot.top ?? 0) };
    } finally { rmSync(file, { force: true }); }
  }
  async function shot(said = '', mark?: { x: number; y: number }): Promise<DesktopResult> {
    const taken = await picture(undefined, mark);
    if (mark) said += '图上的红圈是刚才点到的地方，没点中就看偏了多少，改了再点。';
    view = { scale: taken.clientWidth / taken.width, width: taken.width, height: taken.height, left: taken.left, top: taken.top };
    return { text: `${said}整个屏幕的截图附在结果里（${taken.width}×${taken.height}）。按图上的像素用 desktop click 带 x、y；字太小就 desktop zoom。`, image: { data: taken.data, mediaType: 'image/png' } };
  }
  async function after(done: string, clicked?: { x: number; y: number }): Promise<DesktopResult> {
    await pause(settleMs);
    return shot(done, clicked);
  }

  async function waitFresh(before: Set<number>): Promise<Listed | undefined> {
    for (const deadline = Date.now() + appearMs; ;) {
      const fresh = (await windows()).filter(entry => !before.has(entry.hwnd) && !entry.minimized && entry.title);
      if (fresh.length) return largest(fresh);
      if (Date.now() >= deadline) return undefined;
      await pause(400);
    }
  }
  async function adopt(entry: Listed, app: string, said: string): Promise<DesktopResult> {
    if ((await hands('refocus', { hwnd: entry.hwnd })).refocused !== true) said += '没能把它放到最前面，看截图确认。\n';
    front = app; frontInfo = { exe: entry.exe, title: entry.title }; frontHwnd = entry.hwnd;
    return after(said);
  }
  async function closeWindow(): Promise<DesktopResult> {
    if (frontHwnd === undefined) throw new Error('还没有在最前面的窗口：先 desktop open 它');
    const closing = frontHwnd;
    await hands('rclose', {});
    for (const deadline = Date.now() + 4000; Date.now() < deadline;) {
      if (!(await windows()).some(entry => entry.hwnd === closing)) break;
      await pause(200);
    }
    if ((await windows()).some(entry => entry.hwnd === closing)) {
      throw new Error('没能关闭最前面的窗口：它还开着，可能这个窗口不接受关闭请求（例如模态对话框）。不要改用命令行；先点它的关闭按钮，或请用户手动关闭。');
    }
    front = undefined; frontInfo = undefined; frontHwnd = undefined; view = undefined;
    return { text: '已关闭最前面的窗口。' };
  }
  /** A program's window in front: an open one, then its tray icon, then the Start menu. */
  async function open(app?: string, url?: string, path?: string, file?: string): Promise<DesktopResult> {
    if (path?.trim() || file?.trim()) {
      const before = new Set((await windows()).map(entry => entry.hwnd));
      const exe = path ? path.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '') : '文档';
      if (path) await eyes('launch', { path }); else await eyes('openfile', { file });
      const entry = await waitFresh(before);
      if (!entry) throw new Error(`启动了 ${path ?? file}，但 ${appearMs / 1000} 秒内没有出现窗口`);
      return adopt(entry, exe, `已启动 ${path ?? file}（窗口：${entry.title}）；看截图确认。`);
    }
    if (url?.trim()) {
      const target = url.trim();
      if (!/^https?:\/\//i.test(target)) throw new Error('url 要是 http:// 或 https:// 开头的网址');
      if (app?.trim()) await open(app.trim());
      await hands('url', { url: target });
      await pause(1500);
      return after(`已让浏览器打开 ${target}，等页面加载；看截图确认。\n`);
    }
    const listed = await windows();
    if (!app?.trim()) {
      const titles = [...new Set(listed.map(entry => entry.title))].slice(0, WINDOWS_SHOWN);
      return { text: `开着的窗口：${titles.join('、') || '（没有）'}。收在托盘里的、没开的，写它的名字也能打开。` };
    }
    const name = app.trim(), before = new Set(listed.map(entry => entry.hwnd));
    let mine = windowsNamed(listed, name), told = '';
    if (!mine.length && (await eyes('tray', { name })).result === 'opened') { mine = await appear(name, before); told = '它收在托盘里，已经从托盘图标点开。\n'; }
    if (!mine.length) {
      const apps = ((await eyes('apps')).apps as { name: string; appId: string }[] | undefined) ?? [];
      const wanted = name.toLowerCase();
      const found = apps.find(entry => entry.name.toLowerCase() === wanted) ?? apps.find(entry => entry.name.toLowerCase().includes(wanted));
      if (!found) throw new Error(`找不到叫「${name}」的程序：开着的窗口、托盘图标和开始菜单里都没有。不带 app 调 desktop open 看看开着哪些`);
      await eyes('launch', { appId: found.appId });
      mine = await appear(found.name, before);
      if (!mine.length) throw new Error(`${found.name} 启动了，但 ${appearMs / 1000} 秒内没有出现窗口；过一会儿 desktop shot 看看`);
      told = `${found.name} 没开，已经启动。\n`;
    }
    const chosen = mine.find(entry => entry.title.toLowerCase() === name.toLowerCase()) ?? largest(mine.filter(entry => !entry.owner)) ?? largest(mine)!;
    if (chosen.minimized) await hands('restore', { hwnd: chosen.hwnd });
    if ((await hands('refocus', { hwnd: chosen.hwnd })).refocused !== true) told += '没能把它放到最前面，看截图确认。\n';
    front = name;
    frontInfo = { exe: chosen.exe, title: chosen.title };
    return after(told);
  }
  async function appear(name: string, before: Set<number>): Promise<Listed[]> {
    for (const deadline = Date.now() + appearMs; ;) {
      const listed = await windows();
      const mine = windowsNamed(listed, name);
      if (mine.length) return mine;
      if (Date.now() >= deadline) { const fresh = listed.filter(entry => !before.has(entry.hwnd)); return fresh.length === 1 ? fresh : []; }
      await pause(Math.min(500, appearMs));
    }
  }

  // The sign covers the whole screen here, and lives in the administrator helper so its stop key is heard over any window.
  async function sign(show: boolean): Promise<void> {
    if (!deps.companion) return;
    try {
      // 字和样式都由 appearance.json 说了算：{app} 换成现在最前面的那个程序。
      const banner = readAppearance().banner;
      await hands('sign', show
        ? { show: true, hwnd: 0, text: bannerText(front), hint: banner.hint, stop: banner.stop, stopped: banner.stopped, style: banner }
        : { show: false });
      deps.signFault?.(undefined);
    } catch (error) { deps.signFault?.(`操作提示没能显示：${error instanceof Error ? error.message : String(error)}`); }
  }
  const watch = watching({
    recording, what: () => '整个屏幕', keep: '',
    target: async () => ({
      key: 'screen', app: '屏幕',
      capture: async (file, edge) => String((await hands('screen', { file, edge, grow: 1, x: 0, y: 0, w: 0, h: 0, markX: -1, markY: -1 })).print ?? ''),
      space: () => hands('rkey', { vk: VK.space, modifiers: [] }),
    }),
  });

  const run: Record<string, (input: DesktopInput) => Promise<DesktopResult>> = {
    record: input => watch.record(input),
    stop: () => watch.stop(),
    review: input => watch.review(input),
    open: input => open(input.app, input.url, input.path, input.file),
    shot: () => shot(),
    close: () => closeWindow(),
    click: async input => {
      const at = onScreen(input.x, input.y);
      await hands('rclick', { x: at.x, y: at.y, right: input.right === true, count: input.double ? 2 : 1, hold: holdMs(input.hold) });
      return after(pressed('点击', input.hold), at.local);
    },
    drag: async input => {
      const from = onScreen(input.x, input.y), to = onScreen(input.x2, input.y2);
      await hands('rdrag', { x: from.x, y: from.y, x2: to.x, y2: to.y, right: input.right === true, hold: holdMs(input.hold) });
      return after(dragged(input.hold), to.local);
    },
    move: async input => {
      const at = onScreen(input.x, input.y);
      await hands('rmove', { x: at.x, y: at.y });
      return after('已把鼠标移过去，没有点击。', at.local);
    },
    type: async input => {
      if (typeof input.text !== 'string' || !input.text) throw new Error('text 不能是空的');
      const at = input.x !== undefined || input.y !== undefined ? onScreen(input.x, input.y) : undefined;
      if (at) await hands('rclick', { x: at.x, y: at.y, right: false, count: 1 });
      await hands('rtype', input.stream === true ? { text: input.text, delay: 40 } : { text: input.text });
      if (input.submit) await hands('rkey', { vk: VK.return, modifiers: [] });
      return after(input.submit ? '已输入并回车。' : '已输入。', at?.local);
    },
    press: async input => {
      await hands('rkey', { ...desktopKey(String(input.key ?? '')), hold: holdMs(input.hold) });
      return after(pressed(`按 ${input.key}`, input.hold));
    },
    scroll: async input => {
      const step = { up: [NOTCHES, 0], down: [-NOTCHES, 0], left: [0, -NOTCHES], right: [0, NOTCHES] }[String(input.direction)];
      if (!step) throw new Error('direction 只能是 up、down、left 或 right');
      if (!view) throw new Error('还没看过屏幕：先 desktop shot');
      const at = input.x === undefined && input.y === undefined ? onScreen(view.width / 2, view.height / 2) : onScreen(input.x, input.y);
      await hands('rscroll', { x: at.x, y: at.y, up: step[0], right: step[1] });
      return after('已滚动。');
    },
    zoom: async input => {
      const from = onScreen(input.x, input.y).local, to = onScreen(input.x2, input.y2).local;
      if (!(to.x > from.x && to.y > from.y)) throw new Error('zoom 要给左上角 x、y 和右下角 x2、y2（截图上的像素）');
      const part = await picture({ x: from.x, y: from.y, w: to.x - from.x, h: to.y - from.y });
      return { text: '放大的局部附在结果里；在它上面量的坐标不能直接点，回到整张截图上点。', image: { data: part.data, mediaType: 'image/png' } };
    },
  };
  const turns = createTurns<DesktopInput>({ run, sign, recording, app: () => front, about: () => frontInfo, ...(deps.audit ? { audit: deps.audit } : {}), lingerMs: deps.lingerMs ?? SCREEN_LINGER_MS });
  return {
    actions: turns.actions, act: turns.act, recent: turns.recent, halt: turns.halt, release: turns.release, halted: turns.halted,
    /** The program in front, for the per-app policies and the audit window. */
    about: () => front === undefined ? undefined : { app: front, exe: frontInfo?.exe, title: frontInfo?.title },
    /** Every window on the desktop, so a policy can name one by its executable. */
    windows: async () => windows(),
    /** When foreground mode is turned off: what the agent saw and recorded goes with it. */
    reset(): void { view = undefined; front = undefined; frontInfo = undefined; recording.clear(); turns.reset(); },
  };
}
