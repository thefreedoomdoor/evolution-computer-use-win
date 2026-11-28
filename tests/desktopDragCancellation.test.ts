import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Controlled regression for the point a background drag lets go at (Desk.Drag in src/desktop/win32.ps1).
//
// The fixture cuts the helper's own Drag method out of the source and compiles it into a stub class with no P/Invoke:
// PostMessage only records the message it was asked to post, and Live/Under/ClientToScreen/Aware/Stopped/Rest are plain
// stubs whose only job is to answer. No window is opened, no pointer is touched, no process is started and the helper's
// own dispatch loop is never run, so nothing here can reach a real desktop.
//
// What it shows is the message sequence the helper would post for one drag, and where that sequence ends. It does not
// show that a real window performed a drop at that point: only a real window can show that, and nothing here claims it.
// The point of the exercise is that a drag which is stopped mid-way must not keep travelling to its destination: the
// release it posts has to land on the last point it actually posted, and the far end it reports has to be that same
// point. The helper used to stop moving once Rest reported a stop and then post the button-up at the far end anyway,
// which is what made the cancellation tests below red at first; it now keeps the last point it posted and lets go there.
//
// The complete-drag case is the control: it passed both before and after that fix, so the red was about cancelling and
// not about the sequence shape.

const SOURCE_FILE = fileURLToPath(new URL('../src/desktop/win32.ps1', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/desktop-drag-cancellation.ps1', import.meta.url));
const WINDOWS_ONLY = process.platform !== 'win32' && 'requires Windows PowerShell to compile the helper';

const HWND = 4242;
const MSG_MOVE = 0x200;
const MSG_PRESS_LEFT = 0x201;
const MSG_RELEASE_LEFT = 0x202;
const MSG_PRESS_RIGHT = 0x204;
const MSG_RELEASE_RIGHT = 0x205;

interface Inputs {
  hwnd: number;
  x: number;
  y: number;
  x2: number;
  y2: number;
  right: boolean;
  hold: number;
  cancelAfterRest: number;
  child: number;
  childLeft: number;
  childTop: number;
  screenLeft: number;
  screenTop: number;
}

interface Act {
  hasAct: boolean;
  sx: number;
  sy: number;
  hasAct2: boolean;
  sx2: number;
  sy2: number;
}

interface CaseReport {
  name: string;
  inputs: Inputs;
  restCalls: number;
  cancelled: boolean;
  act: Act;
  records: number[][];
  cursor: number[][];
  progress: number[][];
}

interface Report {
  schema: string;
  source: string;
  signature: string;
  dragChars: number;
  dragSteps: number;
  stubPinvoke: boolean;
  dragText: string;
  cases: CaseReport[];
}

interface Geometry {
  steps: number;
  start: { x: number; y: number };
  destination: { x: number; y: number };
  screenStart: { x: number; y: number };
  dx: number;
  dy: number;
  pointAt: (step: number) => { x: number; y: number };
}

let cached: Report | undefined;

function runFixture(): Report {
  if (cached) {
    return cached;
  }
  const root = process.env.SystemRoot;
  assert.ok(root, 'Windows SystemRoot is needed to locate PowerShell');
  const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', FIXTURE, '-Source', SOURCE_FILE,
  ], { windowsHide: true, encoding: 'utf8', timeout: 120_000 });
  assert.ifError(result.error);
  const stdout = result.stdout ?? '';
  assert.equal(result.status, 0, 'the controlled drag fixture failed\n' + stdout + (result.stderr ?? ''));
  const line = stdout.split(/\r?\n/).find(one => one.trimStart().startsWith('{'));
  assert.ok(line, 'the fixture printed no report\n' + stdout);
  const report = JSON.parse(line) as Report;
  assert.equal(report.schema, 'desktop-drag-cancellation/1');
  assert.ok(stdout.includes('DRAG_CANCELLATION_OK ' + report.cases.length), 'the fixture did not confirm its case count\n' + stdout);
  cached = report;
  return report;
}

function byName(report: Report, name: string): CaseReport {
  const one = report.cases.find(entry => entry.name === name);
  assert.ok(one, 'the fixture ran the case ' + name);
  return one;
}

// Where the drag is supposed to press, step and let go, read off the inputs the fixture ran it with. The step points are
// computed the way the helper computes them: "dx * i / DragSteps" in integers, which C# divides toward zero.
function geometry(one: CaseReport): Geometry {
  const steps = runFixture().dragSteps;
  const input = one.inputs;
  const start = { x: input.x - input.childLeft, y: input.y - input.childTop };
  const dx = input.x2 - input.x;
  const dy = input.y2 - input.y;
  return {
    steps,
    start,
    destination: { x: start.x + dx, y: start.y + dy },
    screenStart: { x: input.x + input.screenLeft, y: input.y + input.screenTop },
    dx,
    dy,
    pointAt: (step: number) => ({
      x: start.x + Math.trunc(dx * step / steps),
      y: start.y + Math.trunc(dy * step / steps),
    }),
  };
}

function label(record: number[]): string {
  const whole: Record<number, string> = {
    [MSG_MOVE]: 'move',
    [MSG_PRESS_LEFT]: 'press-left',
    [MSG_RELEASE_LEFT]: 'release-left',
    [MSG_PRESS_RIGHT]: 'press-right',
    [MSG_RELEASE_RIGHT]: 'release-right',
  };
  const name = whole[record[0]] ?? 'message-0x' + record[0].toString(16);
  return name + '@(' + record[1] + ',' + record[2] + ')' + (record[4] === 0 ? '' : ' button=' + record[4]);
}

// Everything the fixture recorded, so a failed assertion reads as the sequence it actually got.
function posted(one: CaseReport): string {
  const lines = [
    'case ' + one.name,
    '  drag: x=' + one.inputs.x + ' y=' + one.inputs.y + ' -> x2=' + one.inputs.x2 + ' y2=' + one.inputs.y2 +
      ' right=' + one.inputs.right + ' hold=' + one.inputs.hold + ' cancelAfterRest=' + one.inputs.cancelAfterRest +
      ' child=' + one.inputs.child,
    '  rest calls: ' + one.restCalls + '  cancelled: ' + one.cancelled,
    '  posted: ' + (one.records.length === 0 ? '(nothing)' : one.records.map(label).join(' ')),
    '  cursor samples: ' + (one.cursor.length === 0 ? '(none)' : one.cursor.map(point => '(' + point[0] + ',' + point[1] + ')').join(' ')),
  ];
  return lines.join('\n');
}

function assertPressed(one: CaseReport, where: Geometry): void {
  const press = one.inputs.right ? MSG_PRESS_RIGHT : MSG_PRESS_LEFT;
  assert.ok(one.records.length >= 2, 'a drag posts at least the arrival and the press\n' + posted(one));
  assert.deepEqual(one.records[0].slice(0, 3), [MSG_MOVE, where.start.x, where.start.y],
    'the drag first moves the pointer onto its start point\n' + posted(one));
  assert.equal(one.records[0][4], 0, 'the move onto the start names no button\n' + posted(one));
  assert.deepEqual(one.records[1].slice(0, 3), [press, where.start.x, where.start.y],
    'the press lands on the point the pointer arrived at\n' + posted(one));
  assert.equal(one.records[1][4], one.inputs.right ? 2 : 1, 'the press names its own button\n' + posted(one));
}

function assertMoves(one: CaseReport, where: Geometry, moves: number): void {
  const button = one.inputs.right ? 2 : 1;
  for (let step = 1; step <= moves; step += 1) {
    const record = one.records[1 + step];
    assert.ok(record, 'move ' + step + ' is missing\n' + posted(one));
    const point = where.pointAt(step);
    assert.deepEqual(record.slice(0, 3), [MSG_MOVE, point.x, point.y],
      'move ' + step + ' goes to the point the helper steps to\n' + posted(one));
    assert.equal(record[4], button, 'a move says the button is still down\n' + posted(one));
  }
}

function assertReleased(one: CaseReport, point: { x: number; y: number }, why: string): void {
  const release = one.inputs.right ? MSG_RELEASE_RIGHT : MSG_RELEASE_LEFT;
  const press = one.inputs.right ? MSG_PRESS_RIGHT : MSG_PRESS_LEFT;
  const last = one.records[one.records.length - 1];
  assert.deepEqual(last.slice(0, 3), [release, point.x, point.y], why + '\n' + posted(one));
  assert.equal(last[4], 0, 'the release names no button\n' + posted(one));
  assert.equal(one.records.filter(record => record[0] === release).length, 1, 'a drag lets go exactly once\n' + posted(one));
  assert.equal(one.records.filter(record => record[0] === press).length, 1, 'a drag presses exactly once\n' + posted(one));
  assert.equal(one.records.findIndex(record => record[0] === release), one.records.length - 1,
    'nothing is posted after the release\n' + posted(one));
}

test('the fixture cuts the helper own Drag method into a stub that declares no P/Invoke', { skip: WINDOWS_ONLY }, () => {
  const report = runFixture();
  const source = readFileSync(SOURCE_FILE, 'utf8');
  const fixture = readFileSync(FIXTURE, 'utf8');
  assert.equal(report.signature, 'public static void Drag(');
  assert.ok(report.dragText.startsWith(report.signature), 'the cut starts at the signature\n' + report.dragText.slice(0, 160));
  assert.ok(report.dragText.endsWith('}'), 'the cut ends at the closing brace of the method\n' + report.dragText.slice(-160));
  assert.equal(report.dragText.length, report.dragChars);
  assert.ok(source.includes(report.dragText),
    'the compiled text is a piece of the helper source itself, not a hand-written copy of its steps');
  assert.equal((report.dragText.match(/\{/g) ?? []).length, (report.dragText.match(/\}/g) ?? []).length,
    'the cut is one whole method body, not a fragment of one');
  assert.ok(report.dragText.includes('PostMessage'), 'the cut contains the messages a drag posts');
  assert.ok(report.dragText.includes('Rest('), 'the cut contains the place a stop is answered');
  assert.ok(!report.dragText.includes('DllImport'), 'the cut carries no P/Invoke of its own');
  assert.equal(report.stubPinvoke, false, 'the stub the fixture builds declares no P/Invoke');
  assert.ok(fixture.includes('Add-Type -TypeDefinition $stub'), 'the fixture compiles only the stub it builds');
  assert.equal((fixture.match(/Add-Type/g) ?? []).length, 1, 'the fixture compiles exactly one type: the stub it builds');
  assert.ok(!fixture.includes('-TypeDefinition $match'), 'the fixture never compiles the helper block itself');
  assert.ok(Number.isInteger(report.dragSteps) && report.dragSteps >= 2,
    'the helper steps a drag at least twice, got ' + report.dragSteps);
  assert.ok(source.includes('const int DragSteps = ' + report.dragSteps + ';'),
    'the step count is the helper own, not one copied into the fixture');
});

test('a complete drag presses at its start and lets go at its destination', { skip: WINDOWS_ONLY }, () => {
  const report = runFixture();
  for (const name of ['complete-left-forward-divisible', 'complete-right-backward-nondivisible', 'complete-left-child-routed']) {
    const one = byName(report, name);
    const where = geometry(one);
    assert.equal(one.cancelled, false, 'a complete drag is not stopped\n' + posted(one));
    assert.equal(one.records.length, 2 + where.steps + 1,
      'a complete drag moves on, presses, steps ' + where.steps + ' times and lets go\n' + posted(one));
    assertPressed(one, where);
    assertMoves(one, where, where.steps);
    assertReleased(one, where.destination, 'a complete drag lets go at its destination');
    assert.equal(one.restCalls, 1 + where.steps, 'the helper held once and then rested after every step\n' + posted(one));
    const handle = one.inputs.child === 0 ? HWND : one.inputs.child;
    assert.deepEqual([...new Set(one.records.map(record => record[3]))], [handle],
      'every message of one drag goes to the window that drag started in\n' + posted(one));
    assert.deepEqual([one.act.sx2, one.act.sy2], [where.screenStart.x + where.dx, where.screenStart.y + where.dy],
      'the reported end of the drag is the destination in screen pixels\n' + posted(one));
  }
});

test('a drag stopped during its initial hold lets go where it pressed, not at its destination', { skip: WINDOWS_ONLY }, () => {
  const report = runFixture();
  for (const name of ['cancel-in-hold-left', 'cancel-in-hold-right-backward']) {
    const one = byName(report, name);
    const where = geometry(one);
    assert.equal(one.cancelled, true, 'the stop arrived before the drag could step\n' + posted(one));
    assert.equal(one.restCalls, 1, 'the stop arrived during the hold, before any step\n' + posted(one));
    assert.equal(one.records.length, 3,
      'a drag stopped in its hold posts the arrival, the press and one release, and no move\n' + posted(one));
    assertPressed(one, where);
    assertReleased(one, where.start,
      'the button came down at the start, so it has to come up there as well: a drag that never moved must not let go at the destination it never reached');
  }
});

test('a drag stopped after some moves lets go at the last point it posted', { skip: WINDOWS_ONLY }, () => {
  const report = runFixture();
  const cases: Array<[string, number]> = [['cancel-after-three-moves-left', 3], ['cancel-after-seven-moves-right', 7]];
  for (const [name, moves] of cases) {
    const one = byName(report, name);
    const where = geometry(one);
    assert.equal(one.cancelled, true, 'the stop arrived before the last step\n' + posted(one));
    assert.equal(one.restCalls, 1 + moves, 'the stop arrived on the rest after move ' + moves + '\n' + posted(one));
    assert.equal(one.records.length, 2 + moves + 1,
      'the drag posts ' + moves + ' moves and then its release, and no move after the stop\n' + posted(one));
    assertPressed(one, where);
    assertMoves(one, where, moves);
    assertReleased(one, where.pointAt(moves),
      'the pointer stopped at the last point it posted, so that is where the button has to come up: letting go at the destination moves the drag the rest of the way after the stop');
    const last = one.records[one.records.length - 1];
    assert.notDeepEqual([last[1], last[2]], [where.destination.x, where.destination.y],
      'sanity: this case has to stop short of the destination, or it would not tell the two behaviours apart');
  }
});

test('the reported end of a stopped drag is the point it let go at', { skip: WINDOWS_ONLY }, () => {
  const report = runFixture();
  // The far end the helper reports has to be the point the drag reached, not the one it was heading for: a report that
  // still named the destination would claim travel that never happened. The release point has its own tests above;
  // what is pinned here is the audit pair, for every stopped drag.
  for (const name of ['cancel-in-hold-left', 'cancel-after-three-moves-left', 'cancel-after-seven-moves-right', 'cancel-in-hold-right-backward']) {
    const one = byName(report, name);
    const where = geometry(one);
    const moves = one.cancelled ? one.inputs.cancelAfterRest - 1 : where.steps;
    const reached = where.pointAt(moves);
    const onScreen = [where.screenStart.x + (reached.x - where.start.x), where.screenStart.y + (reached.y - where.start.y)];
    assert.deepEqual([one.act.hasAct, one.act.sx, one.act.sy], [true, where.screenStart.x, where.screenStart.y],
      'the drag reports where it pressed\n' + posted(one));
    assert.deepEqual([one.act.hasAct2, one.act.sx2, one.act.sy2], [true, onScreen[0], onScreen[1]],
      'the drag reports the last point it posted as its other end, not the destination it never reached\n' + posted(one));
    assert.notDeepEqual(onScreen, [where.screenStart.x + where.dx, where.screenStart.y + where.dy],
      'sanity: a stopped drag has to report something short of the destination, or this test tells nothing apart');
  }
});

test('the drawn pointer follows the same points the messages use', { skip: WINDOWS_ONLY }, () => {
  const report = runFixture();
  for (const name of ['complete-left-forward-divisible', 'cancel-after-three-moves-left']) {
    const one = byName(report, name);
    const where = geometry(one);
    // The points themselves come from the messages this case posted; the count of them from what stopped it.
    const moves = one.cancelled ? one.inputs.cancelAfterRest - 1 : where.steps;
    assert.deepEqual(one.cursor[0], [where.screenStart.x, where.screenStart.y],
      'the pointer is drawn at the start before anything is posted\n' + posted(one));
    assert.equal(one.progress.length, moves, 'the pointer is told about each move and no more\n' + posted(one));
    for (let step = 1; step <= moves; step += 1) {
      const point = where.pointAt(step);
      const drawn = [where.screenStart.x + (point.x - where.start.x), where.screenStart.y + (point.y - where.start.y)];
      assert.deepEqual(one.cursor[step], drawn, 'the pointer is drawn where move ' + step + ' goes\n' + posted(one));
      assert.deepEqual(one.progress[step - 1], drawn, 'the path sample is the same point move ' + step + ' goes to\n' + posted(one));
    }
    assert.equal(one.cursor.length, 1 + moves, 'one start sample and one per move\n' + posted(one));
  }
});
