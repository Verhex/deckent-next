import { DECISION_ARM_DEFAULT } from '#surfaces/core/terminal-window/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink';
import { Writable } from 'node:stream';
import type { RunView } from '#engine/index.js';
import type { WorklineApproval, WorklineLedgerPorts } from '#surfaces/core/terminal-ledger/index.js';
import { ActiveWorkStrip, activeWorkItems, activeWorkRows, activeWorkWindow, runDetailLines } from '#surfaces/core/terminal-work/index.js';
import { formatDuration } from '#surfaces/core/terminal-ledger/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { cells } from '#surfaces/core/terminal-render/index.js';
import { pendingBrainFixture } from '../support/brain-proposal.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { SLASH_WINDOW_TEST_LABELS } from '../support/slash-window-labels.js';

// TERMINAL-SABIT slice 2 (owner 2026-10-14): "/do gibi yüzeyleri terminalin altına 'aktif run/do süreci' diye (monitördeki gibi) tıklayıp ayrıca
// pencerede izleyebilmeliyiz." The strip lists this session's /do and the Runs it admitted above the composer; it never takes input on its own.
const EN = workSurfaceLabels('en'), TR = workSurfaceLabels('tr');
const focus = { composer: 'INPUT-FOCUS', window: 'WINDOW-FOCUS' }, CTRL_T = '\u0014', CTRL_O = '\u000f', ESC = '\u001b', DOWN = '\u001b[B';
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });

function run(state: RunView['state'], task: { phase: string; title?: string } = { phase: 'active' }, id = 'r'): RunView {
  return { schemaVersion: 3, scopeId: 's', runId: id, revision: 1, cancellationRequested: false, state,
    tasks: [{ id: 'task', kind: 'order', phase: task.phase, taskBrief: { schemaVersion: 1, task: task.title ?? 'ORDER-TASK', scopePaths: [], acceptance: null, criteria: [], profile: null, model: null, effort: null, contextRefs: [] } }] } as unknown as RunView;
}
const RUNNING = { kind: 'running' } as const, COMPLETED = { kind: 'terminal', outcome: 'completed', reason: 'completed' } as const;
const NEEDS = { kind: 'parked', reason: 'needs-input', since: 0, deadline: 1 } as const;

describe('active work items (pure projection)', () => {
  it('orders /do first, then a Run that needs the person, running/evaluating, parked and finished; EN and TR words come from the catalog', () => {
    for (const labels of [EN, TR]) {
      const items = activeWorkItems({ labels: labels.activeWork!, jobs: labels.jobs!, duration: labels.workerLine, nowMs: 100_000,
        active: { title: 'process order', phase: 'waiting', sinceMs: 40_000, expiresAtMs: 190_000 },
        runs: [{ run: run(COMPLETED, { phase: 'accepted', title: 'DONE' }, 'a'), sinceMs: 1 }, { run: run(RUNNING, { phase: 'evaluating', title: 'EVAL' }, 'b'), sinceMs: 2 },
          { run: run(NEEDS, { phase: 'pending', title: 'ASK' }, 'c'), sinceMs: 3 }] });
      expect(items.map(item => item.title)).toEqual([`/do process order`, 'ASK', 'EVAL', 'DONE']);
      expect(items.map(item => item.state)).toEqual([labels.activeWork!.waiting.replace('{remaining}', labels.workerLine.durationMinutes.replace('{n}', '1')), labels.activeWork!.needsYou, labels.activeWork!.evaluating, labels.jobs!.runStates['completed']]);
      expect(items[0]!.elapsed).toBe(labels.workerLine.durationMinutes.replace('{n}', '1'));
    }
    const expired = activeWorkItems({ labels: EN.activeWork!, jobs: EN.jobs!, duration: EN.workerLine, nowMs: 10, runs: [], active: { title: 'x', phase: 'waiting', sinceMs: 0, expiresAtMs: 5 } });
    expect(expired[0]!.state).toBe(EN.activeWork!.expired);
    expect(activeWorkItems({ labels: EN.activeWork!, jobs: EN.jobs!, duration: EN.workerLine, nowMs: 0, runs: [], active: null })).toEqual([]);
  });

  it('bounds the visible rows (header, rows, "+N more") and keeps the selected row in view', () => {
    expect(activeWorkWindow(3, 0, 6)).toEqual({ first: 0, shown: 3, more: 0 });
    expect(activeWorkWindow(10, 0, 4)).toEqual({ first: 0, shown: 2, more: 8 });
    expect(activeWorkWindow(10, 9, 4)).toEqual({ first: 8, shown: 2, more: 8 });
    expect(activeWorkWindow(10, 0, activeWorkRows(4))).toEqual({ first: 0, shown: 1, more: 9 }); // the floor: header, one row, "+9 more" = 3 rows
    expect(activeWorkRows(4)).toBe(3); expect(activeWorkRows(40)).toBe(10);
  });

  it('renders bounded, width-fitting rows at a narrow terminal and nothing when empty', async () => {
    class Tty extends Writable { isTTY = true; rows = 20; columns = 28; frame = ''; writes: string[] = [];
      override _write(chunk: Buffer, _e: string, done: () => void) { const text = chunk.toString('utf8'); this.writes.push(text); if (text.includes('Active')) this.frame = text; done(); } }
    const items = activeWorkItems({ labels: EN.activeWork!, jobs: EN.jobs!, duration: EN.workerLine, nowMs: 0, active: null,
      runs: Array.from({ length: 6 }, (_, index) => ({ run: run(RUNNING, { phase: 'active', title: `a very long run title number ${index}` }, `r${index}`), sinceMs: 0 })) });
    const stdout = new Tty();
    const instance = render(createElement(ActiveWorkStrip, { items, labels: EN.activeWork!, rows: 4, focused: false, onFocus: () => undefined, onOpen: () => undefined }),
      { stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false });
    mounted.push(instance);
    await settle(40);
    const rows = stdout.frame.replace(/\n$/u, '').split('\n');
    expect(rows).toHaveLength(4); expect(rows[0]).toContain('Active work'); expect(rows.at(-1)).toContain('+4 more');
    expect(rows.every(row => cells(row) <= 28)).toBe(true);
    instance.rerender(createElement(ActiveWorkStrip, { items: [], labels: EN.activeWork!, rows: 4, focused: false, onFocus: () => undefined, onOpen: () => undefined }));
    await settle(40);
    expect(stdout.writes.filter(text => !text.startsWith('\u001b')).at(-1)).not.toContain('Active work');
  });
});

describe('active work rows: one line per Run (owner 2026-10-17)', () => {
  const brief = (task: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, task, scopePaths: [], acceptance: null, criteria: [], profile: null, model: null, effort: null, contextRefs: [], ...extra });
  const view = (id: string, state: RunView['state'], tasks: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    ({ schemaVersion: 3, scopeId: 's', runId: id, revision: 1, cancellationRequested: false, state, tasks, ...extra }) as unknown as RunView;
  const NOW = 2 * 3_600_000 + 18 * 60_000;
  const items = (labels: typeof EN, runs: readonly { run: RunView; sinceMs: number }[]) => activeWorkItems({ labels: labels.activeWork!, jobs: labels.jobs!, duration: labels.workerLine, nowMs: NOW, active: null, runs });
  it('shows the Brain title or the first task line, the short run id, model or kind, state and the age with hours and minutes', () => {
    const long = view('0123456789abcdef0123456789abcdef', RUNNING, [{ id: 't', kind: 'coding', phase: 'active',
      taskBrief: brief('Fix   the\tlogin flow\nSecond line with every detail of the task', { model: { channelId: 'c', modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [] } }) }]);
    const titled = view('r2', RUNNING, [{ id: 't', kind: 'verify', phase: 'active', taskBrief: brief('A long instruction', { title: 'Verify release' }) },
      { id: 'u', kind: 'verify', phase: 'pending', taskBrief: brief('x') }]);
    for (const [labels, hours] of [[EN, '2h 18m'], [TR, '2 sa 18 dk']] as const) {
      const rows = items(labels, [{ run: long, sinceMs: 0 }, { run: titled, sinceMs: NOW - 5 * 60_000 }]);
      // Most recently registered first.
      expect(rows[0]).toMatchObject({ title: 'Verify release', detail: 'r2 · verify +1', elapsed: labels.workerLine.durationMinutes.replace('{n}', '5') });
      expect(rows[1]).toMatchObject({ title: 'Fix the login flow', detail: '01234567 · claude-sonnet-5-5', elapsed: hours });
    }
    expect(formatDuration(3_600_000, EN.workerLine)).toBe('1h 0m'); expect(formatDuration(26 * 3_600_000 + 60_000, TR.workerLine)).toBe('26 sa 1 dk');
  });
  it('keeps every unfinished Run and only the three most recent finished ones', () => {
    const runs = [...Array.from({ length: 5 }, (_, index) => ({ run: view(`done${index}`, COMPLETED, [{ id: 't', kind: 'k', phase: 'accepted', taskBrief: brief(`DONE${index}`) }]), sinceMs: index })),
      ...Array.from({ length: 2 }, (_, index) => ({ run: view(`open${index}`, RUNNING, [{ id: 't', kind: 'k', phase: 'active', taskBrief: brief(`OPEN${index}`) }]), sinceMs: index }))];
    expect(items(EN, runs).map(row => row.title)).toEqual(['OPEN1', 'OPEN0', 'DONE4', 'DONE3', 'DONE2']);
  });
  it('names the park reason on the row and the reason, failure code and note in the Run window', () => {
    const held = view('h', { kind: 'parked', reason: 'operator-hold', since: 0, deadline: 1, operatorHold: { schemaVersion: 1, note: 'waiting for the vendor' } },
      [{ id: 't', kind: 'k', phase: 'pending', dependencies: [], acceptanceCriteria: [], taskBrief: brief('HELD') }]);
    const failed = view('f', { kind: 'parked', reason: 'progression-failed', failureCode: 'RUN_STORE_CONFLICT', since: 0, deadline: 1 },
      [{ id: 't', kind: 'k', phase: 'pending', dependencies: [], acceptanceCriteria: [], taskBrief: brief('STUCK') }]);
    for (const labels of [EN, TR]) {
      const rows = items(labels, [{ run: held, sinceMs: 0 }, { run: failed, sinceMs: 0 }]);
      expect(rows.map(row => row.state)).toEqual([`${labels.jobs!.runStates['parked']} · ${labels.jobs!.parkReasons!['operator-hold']}`,
        `${labels.jobs!.runStates['parked']} · ${labels.jobs!.parkReasons!['progression-failed']}`]);
      const window = (run: RunView) => runDetailLines(run, labels).map(line => [...(line.label ?? []), ...line.spans].map(part => part.text).join('')).join('\n');
      expect(window(held)).toContain(labels.jobs!.parkReasons!['operator-hold']); expect(window(held)).toContain('waiting for the vendor');
      expect(window(failed)).toContain('RUN_STORE_CONFLICT');
    }
  });
});

/** A real Workline with a /do whose run-create approval is pending until the person decides it on the card. */
function harness(decisionArmMs = 0) {
  let current: RunView = run(RUNNING), release: (() => void) | undefined, decided = false, plans = 0;
  const decisions: string[] = [], pending = pendingBrainFixture(), gate = new Promise<void>(resolve => { release = resolve; });
  const approval: WorklineApproval = { approvalId: pending.proposal.approval!.approvalId, runId: 'r', taskId: '-', requester: 'owner', revision: 0,
    status: 'pending', decision: null, summary: 'Create proposed Run', expiresAt: pending.proposal.approval!.expiresAt };
  const ledger = { scopeId: 's', workerHeartbeatMs: 60_000, listRunIds: async () => ['r'], inspectRun: async () => current,
    listWorkers: async () => ({ schemaVersion: 1, scopeId: 's', sources: [] }), listApprovalPage: async () => ({ items: decided ? [] : [approval], nextAfter: null }),
    decideApproval: async (target: WorklineApproval, answer: 'allow' | 'deny') => { decisions.push(answer); decided = true; return { ...target, revision: 1, status: 'decided', decision: answer }; } } as unknown as WorklineLedgerPorts;
  const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, windows: SLASH_WINDOW_TEST_LABELS, focus, work: EN }, ledger, pollMs: 25, maxTrackedRuns: 4, decisionArmMs,
    doPlan: { planning: 'PLANNING', cancelHint: 'CANCEL', requestHint: 'REQUEST', lines: () => ['PLAN-RESULT'],
      plan: async () => { plans++; if (!decided) { await gate; return pending; }
        return { ...pending, run: current, proposal: { ...pending.proposal, status: 'accepted', approval: null } }; } } }, 160, { rows: 40 });
  mounted.push(view.instance);
  return { view, decisions, plans: () => plans, release: () => release!(), set: (next: RunView) => { current = next; } };
}
const frame = (h: ReturnType<typeof harness>) => h.view.stdout.frame;
const press = async (h: ReturnType<typeof harness>, keys: string, ms = 60) => { h.view.stdin.write(keys); await settle(ms); };

describe('active work strip on the real Workline', () => {
  it('is hidden with no active work, appears for /do without taking the composer, and Enter on /do focuses its card without deciding', async () => {
    const h = harness(DECISION_ARM_DEFAULT); await settle(80);
    expect(frame(h)).not.toContain('Active work');
    await press(h, '/do process order\r');
    await until(() => frame(h).includes(`/do process order · ${EN.activeWork!.planning}`), 'planning row');
    // The strip appearing never takes input: typing continues in the composer.
    await press(h, 'next idea'); expect(frame(h)).toContain('next idea'); expect(frame(h)).toContain('INPUT-FOCUS');
    await press(h, '\u0015'); // Ctrl+U clears the draft
    h.release();
    await until(() => frame(h).includes('Create proposed Run') && frame(h).includes('waiting for you'), 'waiting row with the card');
    expect(frame(h)).toMatch(/waiting for you · \d+ min left/u);
    // Slice 2: the card takes the keyboard by itself and arms first, so a key at once is no decision; Ctrl+O gives input back.
    expect(frame(h)).toContain('WINDOW-FOCUS'); await press(h, 'y'); expect(h.decisions).toEqual([]);
    await press(h, CTRL_O); expect(frame(h)).toContain('INPUT-FOCUS');
    await press(h, CTRL_T); expect(frame(h)).toContain(EN.activeWork!.focused); expect(frame(h)).toContain('› /do process order');
    await press(h, 'y'); expect(h.decisions).toEqual([]); // a letter in the strip is no decision either
    await press(h, '\r'); expect(frame(h)).toContain('WINDOW-FOCUS'); expect(h.decisions).toEqual([]); // Enter on /do = focus transfer only (re-arms)
    await settle(DECISION_ARM_DEFAULT + 80); await press(h, 'y'); // the explicit key on the focused original card
    await until(() => h.decisions.length === 1, 'decision on the card'); expect(h.decisions).toEqual(['allow']);
    await until(() => h.plans() === 2 && frame(h).includes(`ORDER-TASK · r · order · ${EN.jobs!.runStates['running']}`), 'admitted Run row');
  });

  it('follows the Run state, opens its existing window from the strip and drops a finished Run once opened', async () => {
    const h = harness(); await settle(80);
    await press(h, '/do process order\r'); h.release();
    await until(() => frame(h).includes('Create proposed Run'), 'card');
    await press(h, 'y'); // slice 2: the card holds the keyboard by itself
    await until(() => frame(h).includes('PLAN-RESULT'), 'result window');
    await press(h, CTRL_O); await press(h, ESC); // close the automatic /do result
    await until(() => frame(h).includes(EN.live!.tasksTitle), 'automatic /tasks');
    await press(h, CTRL_O); await press(h, ESC);
    await until(() => frame(h).includes(`ORDER-TASK · r · order · ${EN.jobs!.runStates['running']}`), 'running row');
    h.set({ ...run(NEEDS, { phase: 'pending' }), revision: 2 });
    await until(() => frame(h).includes(`ORDER-TASK · r · order · ${EN.activeWork!.needsYou}`), 'needs-you row');
    h.set({ ...run(COMPLETED, { phase: 'accepted' }), revision: 3 });
    await until(() => frame(h).includes(`ORDER-TASK · r · order · ${EN.jobs!.runStates['completed']}`), 'completed row');
    await press(h, 'draft stays');
    await press(h, CTRL_T); await press(h, '\r');
    await until(() => frame(h).includes(`[${EN.jobs!.runStates['completed']}] · r`), 'run detail window (the /run read model)');
    expect(frame(h)).toContain('WINDOW-FOCUS');
    await press(h, ESC, 100);
    expect(frame(h)).not.toContain('Active work'); // the finished Run left the strip once the person opened it
    await press(h, ' more'); expect(frame(h)).toContain('draft stays more'); // the composer holds input again
  });

  it.each(['/run', '/runs'])('a finished Run also leaves the strip once the person opens it with %s', async command => {
    const h = harness(); await settle(80);
    await press(h, '/do process order\r'); h.release();
    await until(() => frame(h).includes('Create proposed Run'), 'card');
    await press(h, 'y'); // slice 2: the card holds the keyboard by itself
    await until(() => frame(h).includes('PLAN-RESULT'), 'result window');
    await press(h, CTRL_O); await press(h, ESC);
    await until(() => frame(h).includes(EN.live!.tasksTitle), 'automatic /tasks');
    await press(h, CTRL_O); await press(h, ESC);
    h.set({ ...run(COMPLETED, { phase: 'accepted' }), revision: 3 });
    await until(() => frame(h).includes(`ORDER-TASK · r · order · ${EN.jobs!.runStates['completed']}`), 'completed row');
    await press(h, `${command}\r`, 120);
    if (command === '/run') { await until(() => frame(h).includes(EN.live!.runsTitle), 'run picker'); await press(h, '\r', 120); }
    await until(() => frame(h).includes(command === '/run' ? `[${EN.jobs!.runStates['completed']}] · r` : EN.live!.runsTitle), 'run window');
    if (!frame(h).includes('WINDOW-FOCUS')) await press(h, CTRL_O);
    await press(h, ESC, 120);
    await until(() => !frame(h).includes('Active work'), 'finished Run left the strip');
  });

  it('Esc and Ctrl+T give input back to the composer; arrows move the selection only while the strip holds input', async () => {
    const h = harness(); await settle(80);
    await press(h, '/do process order\r');
    await until(() => frame(h).includes(EN.activeWork!.title), 'strip');
    await press(h, CTRL_T); expect(frame(h)).toContain(EN.activeWork!.focused);
    await press(h, 'abc'); expect(frame(h)).not.toContain('abc'); // the strip holds input: nothing reaches the composer
    await press(h, ESC); expect(frame(h)).toContain(EN.activeWork!.title);
    await press(h, 'abc'); expect(frame(h)).toContain('abc');
    await press(h, CTRL_T); await press(h, DOWN); await press(h, CTRL_T); expect(frame(h)).toContain(EN.activeWork!.title);
    h.release();
  });
});
