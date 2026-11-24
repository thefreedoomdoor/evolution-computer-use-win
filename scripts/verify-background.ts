// 全后台验证：让真实的 Windows 助手（后台模式）操作一个记事本窗口，同时用 scripts/verify-background.ps1
// 每 25 ms 取样：目标窗口有没有变成前台、鼠标有没有被移动、窗口有没有被最小化或藏起来、
// 窗口中心那个像素上到底是谁（被盖住时就不是它）。最后再把窗口真的提到前面一次，
// 证明取样器确实能看见"前台"，不是只会报 0。
//
// 记事本先正常启动（这一步会由程序自己冒到前面，属于程序行为，不在断言里），
// 然后把用户原来的窗口交还到最前，再开始取样与操作：open（找到窗口）→ click → type → 截图对比。
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopDriver } from '../src/desktop/driver.ts';
import { createDesktop } from '../src/desktop/desktop.ts';
import { Faults } from '../src/shared/faults.ts';

const dir = import.meta.dirname ?? '.';
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function run(command: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    child.on('close', code => resolve({ code: code ?? -1, out, err }));
  });
}

interface Sample { at: number; foreground: number; cursor: string; iconic: boolean; visible: boolean; atCenter: number; valid: boolean; rank: number; refRank: number; above: number }
function readSamples(file: string): Sample[] {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
  return lines.map(line => {
    const [at, foreground, cursor, iconic, visible, atCenter, valid, rank, refRank, above] = line.split('|');
    return { at: Number(at), foreground: Number(foreground), cursor, iconic: iconic === 'True', visible: visible === 'True', atCenter: Number(atCenter), valid: valid === 'True', rank: Number(rank), refRank: Number(refRank), above: Number(above) };
  });
}

/** 取样一段时间，期间做 during 里的事。 */
async function sample(seconds: number, hwnd: number, file: string, during?: () => Promise<void>, reference = 0) {
  const child: ChildProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(dir, 'verify-background.ps1'), '-Hwnd', String(hwnd), '-Ref', String(reference), '-Milliseconds', String(seconds * 1000), '-Out', file],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
  const finished = new Promise<number>(resolve => child.on('close', code => resolve(code ?? -1)));
  await wait(900);
  if (during) await during();
  const code = await finished;
  if (code !== 0) throw new Error('取样器退出码 ' + code + '：' + err.trim());
  return readSamples(file);
}

/** 只取样，不做任何操作。 */
async function sampleFile(milliseconds: number, hwnd: number, file: string, reference = 0) {
  return sample(milliseconds / 1000, hwnd, file, undefined, reference);
}

async function main(): Promise<number> {
  const work = mkdtempSync(join(tmpdir(), 'evocu-verify-bg-'));
  const faults = new Faults();
  const driver = createDesktopDriver({ faults });
  const desktop = createDesktop({ driver, running: async () => false });
  let pid = 0, hwnd = 0, ownerPid = 0, named = 'notepad.exe';
  try {
    // 启动记事本之前先记住用户原来的前台窗口：Start-Process 会让记事本自己冒到前面，
    // 启动后再读前台只会读到记事本，等于没有还原，取样基线就会把记事本当成「本来就是前台」。
    const beforeLaunch = await driver.call('windows');
    let original = Number(beforeLaunch.foreground ?? 0);
    // 记事本正常启动：程序自己会出现在前面，这是程序的行为；随后把用户原来的窗口交还到最前，再开始取样。
    const launched = await run('powershell.exe', ['-NoProfile', '-Command',
      '$p = Start-Process -FilePath notepad.exe -PassThru; $p.Id']);
    pid = Number(launched.out.trim());
    for (let i = 0; i < 40; i++) {
      const windows = await driver.call('windows');
      const list = (windows.windows as { hwnd: number; pid: number; exe: string }[] | undefined) ?? [];
      const all = list.filter(entry => entry.exe.toLowerCase().includes('notepad'));
      const mine = all.filter(entry => pid === 0 || entry.pid === pid);
      const found = mine[0] ?? all[0];
      // 用窗口自己的标题当名字：记事本的标题是「无标题 - 记事本」，按 exe 名字找不到它。
      if (found) { hwnd = found.hwnd; ownerPid = found.pid; named = found.title || named; break; }
      await wait(150);
    }
    if (!hwnd) throw new Error('没找到记事本窗口（pid=' + pid + '）');
    // 启动前没有前台窗口（例如桌面）或前台恰好是残留的记事本时，挑一个别的窗口当参照。
    if (!original || original === hwnd) {
      const windows = await driver.call('windows');
      const list = (windows.windows as { hwnd: number; pid: number; visible?: boolean }[] | undefined) ?? [];
      const other = list.find(entry => entry.hwnd !== hwnd && entry.pid !== pid && entry.visible !== false);
      original = other?.hwnd ?? 0;
    }
    if (original && original !== hwnd) await driver.call('refocus', { hwnd: original }).catch(() => ({}));
    await wait(400);

    // 静默基线：先不操作地录 1.2 秒。如果这段时间鼠标自己在动，说明用户正在用电脑，
    // 就不能把「鼠标动过」算到助手头上——后面按环境噪声处理，单独报出来。
    const quiet = await sampleFile(1200, hwnd, join(work, 'sample-quiet.tsv'), original);
    const ambientCursor = new Set(quiet.map(row => row.cursor)).size > 1;

    const first = await sample(9, hwnd, join(work, 'sample-1.tsv'), async () => {
      const opened = await desktop.act({ action: 'open', app: named });
      const size = /（(\d+)×(\d+)）/.exec(opened.text);
      if (!size) throw new Error('打开后没有截图尺寸：' + opened.text);
      const width = Number(size[1]), height = Number(size[2]);
      const before = await desktop.act({ action: 'shot' });
      await desktop.act({ action: 'click', x: Math.round(width * 0.5), y: Math.round(height * 0.2) });
      await desktop.act({ action: 'type', text: 'DSH-BG-OK' });
      const after = await desktop.act({ action: 'shot' });
      if (!before.image || !after.image) throw new Error('截图没拿到');
      if (before.image.data.equals(after.image.data)) throw new Error('输入之后画面没有变化：键鼠输入没进到窗口');
    }, original);

    // 取样器自检：refocus 真的把窗口提到前面时，它必须看见目标窗口成为前台。
    const originalFg = first.find(row => row.foreground !== 0)?.foreground ?? 0;
    const second = await sample(2, hwnd, join(work, 'sample-2.tsv'), async () => {
      await driver.call('refocus', { hwnd });
    });
    if (originalFg && originalFg !== hwnd) await driver.call('refocus', { hwnd: originalFg }).catch(() => ({}));

    const rows = first.filter(row => row.valid);
    const hits = rows.filter(row => row.foreground === hwnd).length;
    const cursors = new Set(first.map(row => row.cursor));
    const iconics = rows.filter(row => row.iconic).length;
    const hidden = rows.filter(row => !row.visible).length;
    const calibrationHits = second.filter(row => row.valid && row.foreground === hwnd).length;

    // 基线：取样开始后的前 700 ms（这时还没有任何助手操作）。窗口可能本来就露在屏幕上（记事本自己启动时就露着），
    // 那不算助手把它显示出来；要断言的是「操作期间露出状态和 Z 序都没有变」，也就是助手没有把它翻到上面。
    const baseline = rows.filter(row => row.at <= 700);
    const middle = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : -1;
    const baselineRank = middle(baseline.map(row => row.rank).filter(rank => rank > 0));
    const baselineExposed = baseline.some(row => row.atCenter === hwnd);
    const exposedSamples = rows.filter(row => row.atCenter === hwnd).length;
    let exposureTransitions = 0;
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i].atCenter === hwnd) !== (rows[i - 1].atCenter === hwnd)) exposureTransitions++;
    }
    const raised = baselineRank > 0 ? rows.filter(row => row.rank > 0 && row.rank < baselineRank - 2).length : 0;
    // 真正要看的是：目标窗口有没有跑到用户原来那个窗口的前面（跑上去就等于出现在显示屏最上层）。
    const aboveRefSamples = rows.filter(row => row.above === 1).length;
    const result = {
      mode: 'background',
      app: named,
      pid: ownerPid,
      hwnd,
      samples: first.length,
      validSamples: rows.length,
      foregroundHits: hits,
      cursorMoved: cursors.size > 1,
      cursorPositions: cursors.size,
      iconicSamples: iconics,
      hiddenSamples: hidden,
      baselineExposed,
      exposedSamples,
      exposureTransitions,
      baselineRank,
      lowestRank: rows.filter(row => row.rank > 0).reduce((low, row) => Math.min(low, row.rank), baselineRank > 0 ? baselineRank : 9999),
      zRaisedSamples: raised,
      referenceHwnd: original,
      aboveReferenceSamples: aboveRefSamples,
      calibrationForegroundHits: calibrationHits,
      ambientCursor,
      ok: rows.length > 100 && hits === 0 && (cursors.size <= 1 || ambientCursor) && iconics === 0 && hidden === 0 && calibrationHits > 0 && exposureTransitions === 0 && raised === 0 && aboveRefSamples === 0,
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error('未通过：' + [
        rows.length <= 100 ? '有效样本太少（' + rows.length + '）' : '',
        hits ? '目标窗口成为前台 ' + hits + ' 次' : '', cursors.size > 1 && !ambientCursor ? '鼠标被移动过' : '',
        iconics ? '窗口被最小化' : '', hidden ? '窗口被藏起来' : '',
        calibrationHits === 0 ? '取样器自检失败（refocus 前后都没看见前台）' : '',
        exposureTransitions ? '目标窗口的露出状态变了 ' + exposureTransitions + ' 次' : '',
        aboveRefSamples ? '目标窗口跑到用户窗口前面 ' + aboveRefSamples + ' 次' : '',
        raised ? '目标窗口在 Z 序里被提到前面 ' + raised + ' 次（基线 ' + baselineRank + '）' : '',
      ].filter(Boolean).join('；'));
    }
    return result.ok ? 0 : 1;
  } finally {
    if (ownerPid) { await run('powershell.exe', ['-NoProfile', '-Command', 'Stop-Process -Id ' + ownerPid + ' -Force -ErrorAction SilentlyContinue']); }
    desktop.reset();
    driver.stop();
    const leftovers = faults.list();
    if (leftovers.length) console.error('助手报告的问题：' + leftovers.join('；'));
    rmSync(work, { recursive: true, force: true });
  }
}
process.exitCode = await main();
