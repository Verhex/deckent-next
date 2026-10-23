import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLifecycleCommandSchema, type RunView } from '#engine/index.js';
import type { WorklineLedgerPorts } from '#surfaces/core/terminal-ledger/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { createWorklineLedgerPorts } from '#surfaces/core/cli-terminal/index.js';
import { runControlActions } from '#surfaces/core/terminal-work/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

// Y1 (owner 2026-10-14): the Runs window's hold / resume / close keys. Each key opens a y/N card; only a single typed y sends the command to
// the same lifecycle application as `deckent run hold|resume|close`, which authorizes it and checks the Run's state at the shown revision.
const EN = workSurfaceLabels('en'), TR = workSurfaceLabels('tr'), ESC = '\u001b', CTRL_O = '\u000f', CTRL_Y = '\u0019', DOWN = '\u001b[B', TAB = '\t';
const RUNNING = '3f2a9c1e-8b4d-4e7a-9c55-1d2e3f4a5b6c', HELD = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', DONE = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
function view(runId: string, state: RunView['state'], title: string, revision = 7): RunView {
  return { schemaVersion: 3, runId, scopeId: 'scope-a', revision, cancellationRequested: false, state, tasks: [{ id: 'task-id', phase: 'pending',
    taskBrief: { schemaVersion: 1, task: title, model: null, scopePaths: [], acceptance: null, criteria: [], profile: null, effort: null, contextRefs: [] } }] } as unknown as RunView;
}
const runs: Record<string, RunView> = {
  [RUNNING]: view(RUNNING, { kind: 'running' }, 'Fix checkout'),
  [HELD]: view(HELD, { kind: 'parked', reason: 'operator-hold', note: 'wait', since: 1, deadline: 2 } as never, 'Ship invoices', 4),
  [DONE]: view(DONE, { kind: 'terminal', outcome: 'completed', reason: 'completed' }, 'Old report', 9),
};
function ports(control?: WorklineLedgerPorts['controlRun']): WorklineLedgerPorts {
  return { scopeId: 'scope-a', listRunIds: async () => [RUNNING, HELD, DONE], inspectRun: async id => runs[id] ?? null,
    listWorkers: async () => ({ schemaVersion: 1, observedAt: Date.now(), scopeId: 'scope-a', sources: [] }) as never, listApprovalPage: async () => ({ items: [], nextAfter: null }),
    ...(control ? { controlRun: control } : {}) };
}
const mounted: ReturnType<typeof mountWorkline>[] = [];
afterEach(() => { for (const item of mounted.splice(0)) item.instance.unmount(); });
async function open(ledger: WorklineLedgerPorts, locale: 'en' | 'tr' = 'en') {
  const h = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, work: locale === 'en' ? EN : TR }, ledger, pollMs: 60_000 }, 160, { rows: 50 }); mounted.push(h);
  await settle(30); h.stdin.write('/runs\r');
  await until(() => h.stdout.frame.includes('Old report'), 'runs window');
  return h;
}
const press = async (h: ReturnType<typeof mountWorkline>, keys: string, ms = 60) => { h.stdin.write(keys); await settle(ms); };
const squeeze = (text: string) => text.replace(/[│┃\s]+/gu, '');

describe('Runs window control keys', () => {
  it('lists the runs with a selection and offers only the keys each state allows', async () => {
    const h = await open(ports(vi.fn()));
    expect(h.stdout.frame).toMatch(/› Fix checkout \[running\]/u);
    expect(h.stdout.frame).toContain(`${EN.runControl!.hints} · ${EN.runControl!.keyHold}`); expect(h.stdout.frame).not.toContain(EN.runControl!.keyResume);
    await press(h, DOWN);
    expect(h.stdout.frame).toContain(`${EN.runControl!.hints} · ${EN.runControl!.keyResume} · ${EN.runControl!.keyClose}`);
    await press(h, DOWN);
    expect(h.stdout.frame).toContain(`${EN.runControl!.hints} · ${EN.runControl!.noKeys}`);
  });

  it('h opens the hold card (Alt+h, Ctrl+H, coalesced hh do not); Ctrl+Y, Alt+y, Ctrl+O y never hold; a single typed y holds at the shown revision', async () => {
    const control = vi.fn(async () => 'HELD-RESULT'), h = await open(ports(control));
    for (const keys of [`${ESC}h`, '\u0008', 'hh']) { await press(h, keys); expect(h.stdout.frame).not.toContain('Hold run 3f2a9c1e'); } // Alt+h, Ctrl+H, coalesced
    await press(h, 'h', 120);
    await until(() => h.stdout.frame.includes('Hold run 3f2a9c1e: Fix checkout?'), 'hold card');
    expect(h.stdout.frame).toContain(EN.runControl!.holdDetail.slice(0, 40)); expect(h.stdout.frame).toContain('State running · revision 7');
    for (const keys of [CTRL_Y, `${ESC}y`, `${CTRL_O}y`]) { await press(h, keys, 100); expect(control).not.toHaveBeenCalled(); }
    expect(h.stdout.frame).toContain('Hold run 3f2a9c1e');
    await press(h, 'y', 150);
    await until(() => h.stdout.frame.includes('HELD-RESULT'), 'result as window status');
    expect(control).toHaveBeenCalledTimes(1); expect(control).toHaveBeenCalledWith(RUNNING, 'hold', 7, undefined);
    await press(h, ESC, 120);
    await until(() => h.stdout.text.includes('HELD-RESULT'), 'transcript summary');
  });

  it.each([['n'], ['\r'], [ESC], ['\u0003']])('%j on the card keeps the run and sends nothing', async key => {
    const control = vi.fn(async () => 'SENT'), h = await open(ports(control));
    await press(h, 'h', 120); await until(() => h.stdout.frame.includes('Hold run 3f2a9c1e'), 'card');
    await press(h, key, 150);
    await until(() => h.stdout.frame.includes('Run 3f2a9c1e unchanged; nothing was sent.'), 'kept status');
    expect(control).not.toHaveBeenCalled(); expect(h.stdout.frame).toContain('› Fix checkout');
  });

  it('a reason written with Tab is the hold note; resume and close carry no reason', async () => {
    const control = vi.fn(async () => 'OK'), h = await open(ports(control));
    await press(h, 'h', 120); await until(() => h.stdout.frame.includes('Hold run'), 'card');
    await press(h, TAB); await press(h, 'release window'); await press(h, TAB); await press(h, 'y', 150);
    await until(() => control.mock.calls.length === 1, 'hold sent');
    expect(control).toHaveBeenLastCalledWith(RUNNING, 'hold', 7, 'release window');
    await until(() => h.stdout.frame.includes('› Fix checkout'), 'list again');
    await press(h, DOWN); await press(h, 'r', 120); await until(() => h.stdout.frame.includes('Resume run 7a1b2c3d: Ship invoices?'), 'resume card');
    await press(h, 'y', 150); await until(() => control.mock.calls.length === 2, 'resume sent');
    expect(control).toHaveBeenLastCalledWith(HELD, 'resume', 4, undefined);
    await until(() => h.stdout.frame.includes('› Ship invoices'), 'list again, the acted-on run still selected');
    await press(h, 'c', 120); await until(() => h.stdout.frame.includes('Close parked run 7a1b2c3d'), 'close card');
    expect(h.stdout.frame).toContain(EN.runControl!.closeDetail.slice(0, 40));
    await press(h, 'y', 150); await until(() => control.mock.calls.length === 3, 'close sent');
    expect(control).toHaveBeenLastCalledWith(HELD, 'close', 4, undefined);
  });

  it('keys a state does not offer open nothing (a finished run, hold on a held run)', async () => {
    const control = vi.fn(), h = await open(ports(control));
    await press(h, 'r'); await press(h, 'c'); expect(h.stdout.frame).not.toMatch(/Resume run|Close parked run/u);
    await press(h, DOWN); await press(h, 'h'); expect(h.stdout.frame).not.toContain('Hold run');
    await press(h, DOWN); for (const key of ['h', 'r', 'c']) await press(h, key);
    expect(h.stdout.frame).not.toMatch(/Hold run|Resume run|Close parked run/u); expect(control).not.toHaveBeenCalled();
  });

  it('a policy refusal is the typed reason in the window and in the summary; the list stays open', async () => {
    const denied = Object.assign(new Error('Policy denied run:cancel for this principal'), { code: 'POLICY_DENIED' });
    const h = await open(ports(vi.fn(async () => { throw denied; })));
    await press(h, 'h', 120); await until(() => h.stdout.frame.includes('Hold run'), 'card'); await press(h, 'y', 150);
    await until(() => h.stdout.frame.includes('ERR:Policy denied run:cancel'), 'refusal in the window');
    expect(h.stdout.frame).toContain('› Fix checkout');
    await press(h, ESC, 120); await until(() => h.stdout.text.includes('ERR:Policy denied run:cancel'), 'refusal summary');
  });

  it('the TR window and card speak Turkish', async () => {
    const h = await open(ports(vi.fn(async () => 'TAMAM')), 'tr');
    expect(h.stdout.frame).toContain(`${TR.runControl!.hints} · ${TR.runControl!.keyHold}`);
    await press(h, 'h', 120); await until(() => h.stdout.frame.includes('3f2a9c1e işi bekletilsin mi: Fix checkout?'), 'TR card');
    expect(squeeze(h.stdout.frame)).toContain(squeeze(TR.runControl!.holdPrompt));
  });

  it('without the lifecycle port /runs stays the read-only list (no keys, no cards)', async () => {
    const h = await open(ports());
    expect(h.stdout.frame).not.toContain(EN.runControl!.keyHold); await press(h, 'h', 120);
    expect(h.stdout.frame).not.toContain('Hold run');
  });
});

describe('offered keys by observed state (display only; the service decides)', () => {
  it.each([
    [{ kind: 'running' }, false, ['hold']], [{ kind: 'running' }, true, []], [{ kind: 'terminal', outcome: 'completed', reason: 'completed' }, false, []],
    [{ kind: 'parked', reason: 'operator-hold' }, false, ['resume', 'close']], [{ kind: 'parked', reason: 'progression-failed' }, false, ['hold', 'resume', 'close']],
    // Resume does not lift a question, a decision wait or a quota wait (domain resumeParkedRun): no `r` there, so no "resumed" line can mislead.
    [{ kind: 'parked', reason: 'needs-input' }, false, ['hold', 'close']], [{ kind: 'parked', reason: 'quota-exhausted' }, false, ['hold', 'close']],
    // MCP-AI-AKTOR: a hold over another park keeps that reason with an `operatorHold` overlay; `r` removes the overlay, `h` is not offered twice.
    [{ kind: 'parked', reason: 'needs-input', operatorHold: { schemaVersion: 1, note: 'wait' } }, false, ['resume', 'close']],
    [{ kind: 'parked', reason: 'progression-failed', operatorHold: { schemaVersion: 1, note: 'wait' } }, false, ['resume', 'close']],
  ] as const)('%j cancelling=%s → %j', (state, cancelling, keys) => {
    expect(runControlActions({ ...runs[RUNNING]!, state: { since: 1, deadline: 2, ...state } as never, cancellationRequested: cancelling })).toEqual(keys);
  });
});

describe('terminal lifecycle port over the CLI handler', () => {
  const lifecycle = () => ({ schemaVersion: 1 as const, layout: {} as never,
    lifecycle: { schemaVersion: 1 as const, commandId: 'x', run: { ...runs[RUNNING]!, revision: 8 } } });
  const make = (apply: ReturnType<typeof vi.fn>, locale: 'en' | 'tr' = 'en') => createWorklineLedgerPorts({ root: '/project', scopeId: 'scope-a', options: { env: {} }, locale, renderRunCancellation: () => '',
    inspectWorkers: async () => ({}) as never, inspectRun: async () => ({}) as never, applyRunLifecycle: apply as never })!;

  it('builds exactly the CLI lifecycle command (one schema), with the default or the person\'s hold note, and names the command id', async () => {
    const apply = vi.fn<(root: string, command: unknown) => Promise<ReturnType<typeof lifecycle>>>(async () => lifecycle()), port = make(apply);
    const held = await port.controlRun!(RUNNING, 'hold', 7);
    const [root, command] = apply.mock.calls[0]! as unknown as [string, Record<string, unknown>];
    expect(root).toBe('/project'); expect(runLifecycleCommandSchema.parse(command)).toEqual(command);
    expect(command).toMatchObject({ schemaVersion: 1, scopeId: 'scope-a', runId: RUNNING, action: 'hold', expectedRevision: 7, holdReason: 'Held by the person in the Deckent terminal.' });
    expect(String(command['commandId'])).toMatch(/^terminal-run-hold-[0-9a-f-]{36}$/u);
    expect(held).toBe(`Run 3f2a9c1e hold recorded, now running (revision 8): no new task starts; running work continues. Command ${String(command['commandId'])}`);
    await port.controlRun!(RUNNING, 'hold', 7, '  release window  ');
    expect(apply.mock.calls[1]![1]).toMatchObject({ holdReason: 'release window' });
    for (const action of ['resume', 'close'] as const) {
      await port.controlRun!(HELD, action, 4, 'ignored');
      const sent = apply.mock.calls.at(-1)![1] as Record<string, unknown>;
      expect(sent).toEqual({ schemaVersion: 1, commandId: sent['commandId'], scopeId: 'scope-a', runId: HELD, action, expectedRevision: 4 });
    }
    expect(await make(vi.fn<(root: string, command: unknown) => Promise<ReturnType<typeof lifecycle>>>(async () => lifecycle()), 'tr').controlRun!(RUNNING, 'resume', 7)).toMatch(/^3f2a9c1e işi için sürdürme kaydedildi, şimdi çalışıyor \(revizyon 8\)\. Komut terminal-run-resume-/u);
  });

  it('a refusal is the application\'s typed error, unchanged; without the handler there is no port', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'POLICY_DENIED' });
    await expect(make(vi.fn(async () => { throw denied; })).controlRun!(RUNNING, 'hold', 7)).rejects.toBe(denied);
    expect(createWorklineLedgerPorts({ root: '/p', scopeId: 's', options: {}, renderRunCancellation: () => '', inspectWorkers: async () => ({}) as never, inspectRun: async () => ({}) as never })!.controlRun).toBeUndefined();
  });
});

// BR2 (K7 port, owner 2026-10-23 Q1): a worker's needs-input question is answered from the Runs window (`a` on its row) through the same in-process
// lifecycle command as `deckent run resume --task --answer`; the answer is typed in the card (Tab) and sent only with a single typed y.
const ASKING = '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
function asking(revision = 5): RunView {
  return { ...view(ASKING, { kind: 'parked', reason: 'needs-input', since: 1, deadline: 2 } as never, 'Pick a branch', revision),
    tasks: [{ id: 'task-ask', phase: 'awaiting-decision', decision: { reason: 'needs-input', question: 'Which branch should I use?', since: 1, deadline: 2 },
      taskBrief: { schemaVersion: 1, task: 'Pick a branch', model: null, scopePaths: [], acceptance: null, criteria: [], profile: null, effort: null, contextRefs: [] } }] } as unknown as RunView;
}
describe('needs-input answer from the Runs window (BR2)', () => {
  function answerPorts(answer: WorklineLedgerPorts['answerTask'], current: () => RunView = () => asking()): WorklineLedgerPorts {
    return { ...ports(vi.fn()), listRunIds: async () => [ASKING], inspectRun: async id => id === ASKING ? current() : null, ...(answer ? { answerTask: answer } : {}) };
  }
  async function openAsking(ledger: WorklineLedgerPorts, locale: 'en' | 'tr' = 'en') {
    const h = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, work: locale === 'en' ? EN : TR }, ledger, pollMs: 60_000 }, 160, { rows: 50 }); mounted.push(h);
    await settle(30); h.stdin.write('/runs\r');
    await until(() => h.stdout.frame.includes('› Pick a branch'), 'asking run row');
    return h;
  }
  it('a opens the card with the question; y with no answer sends nothing; a written answer goes with one y at the shown revision', async () => {
    const answer = vi.fn(async () => 'ANSWER-RESULT'), h = await openAsking(answerPorts(answer));
    expect(h.stdout.frame).toContain(EN.runControl!.keyAnswer!);
    for (const keys of [`${ESC}a`, 'aa']) { await press(h, keys); expect(h.stdout.frame).not.toContain('Answer run'); } // Alt+a, coalesced
    await press(h, 'a', 120); await until(() => h.stdout.frame.includes('Answer run 9c8b7a6d: Pick a branch?'), 'answer card');
    expect(h.stdout.frame).toContain('The worker asks: Which branch should I use?'); expect(h.stdout.frame).toContain('State parked · revision 5');
    await press(h, 'y', 150);
    await until(() => h.stdout.frame.includes('Run 9c8b7a6d: no answer was written; nothing was sent.'), 'empty answer refused here');
    expect(answer).not.toHaveBeenCalled();
    await until(() => h.stdout.frame.includes('› Pick a branch'), 'the Runs window is back');
    await press(h, 'a', 120); await until(() => h.stdout.frame.includes('Answer run'), 'card again');
    for (const keys of [CTRL_Y, `${ESC}y`, `${CTRL_O}y`]) { await press(h, keys, 100); expect(answer).not.toHaveBeenCalled(); }
    await press(h, TAB); await press(h, 'use release/2 (y is text here)'); await press(h, TAB);
    expect(answer).not.toHaveBeenCalled();
    await press(h, 'y', 150); await until(() => answer.mock.calls.length === 1, 'answer sent');
    expect(answer).toHaveBeenCalledWith(ASKING, 'task-ask', 'use release/2 (y is text here)', 5);
    await until(() => h.stdout.frame.includes('ANSWER-RESULT'), 'result as window status');
    await press(h, ESC, 120); await until(() => h.stdout.text.includes('ANSWER-RESULT'), 'result summary');
  });
  it.each([['n'], ['\r'], [ESC], ['\u0003']])('%j on the answer card keeps the run and sends nothing, even with an answer written', async key => {
    const answer = vi.fn(async () => 'SENT'), h = await openAsking(answerPorts(answer));
    await press(h, 'a', 120); await until(() => h.stdout.frame.includes('Answer run'), 'card');
    await press(h, TAB); await press(h, 'main'); await press(h, TAB); await press(h, key, 150);
    await until(() => h.stdout.frame.includes('Run 9c8b7a6d unchanged; nothing was sent.'), 'kept');
    expect(answer).not.toHaveBeenCalled();
  });
  it('a stale revision rereads the run and asks again (bounded); a Run that stopped asking sends nothing', async () => {
    const stale = Object.assign(new Error('store conflict'), { code: 'RUN_STORE_CONFLICT' });
    let current = asking(), calls = 0;
    const answer = vi.fn(async () => { calls++; if (calls === 1) { current = asking(6); throw stale; } return 'AFTER-REREAD'; }), h = await openAsking(answerPorts(answer, () => current));
    await press(h, 'a', 120); await until(() => h.stdout.frame.includes('Answer run'), 'card');
    await press(h, TAB); await press(h, 'main'); await press(h, TAB); await press(h, 'y', 150);
    await until(() => h.stdout.frame.includes('read again') && h.stdout.frame.includes('revision 6'), 'reread card at the new revision');
    await press(h, TAB); await press(h, 'main'); await press(h, TAB); await press(h, 'y', 150);
    await until(() => h.stdout.frame.includes('AFTER-REREAD'), 'sent after reread');
    expect(answer).toHaveBeenCalledTimes(2); expect(answer).toHaveBeenLastCalledWith(ASKING, 'task-ask', 'main', 6);
    current = { ...asking(7), state: { kind: 'running' }, tasks: [{ ...asking().tasks[0]!, phase: 'active', decision: undefined }] } as unknown as RunView;
    await press(h, ESC, 120); await settle(60); h.stdin.write('/runs\r');
    await until(() => h.stdout.frame.includes('› Pick a branch'), 'window again');
    await press(h, 'a', 150); expect(h.stdout.frame).not.toContain('Answer run'); expect(answer).toHaveBeenCalledTimes(2);
  });
  it('stale conflicts stop after the registry retries and show the typed error', async () => {
    const stale = Object.assign(new Error('store conflict'), { code: 'RUN_STORE_CONFLICT' }), answer = vi.fn(async () => { throw stale; }), h = await openAsking(answerPorts(answer));
    await press(h, 'a', 120);
    for (let round = 0; round < 3; round++) {
      await until(() => h.stdout.frame.includes('Answer run'), `card round ${round}`);
      await press(h, TAB); await press(h, 'main'); await press(h, TAB); await press(h, 'y', 150);
    }
    await until(() => h.stdout.frame.includes('ERR:store conflict'), 'typed error after the retries');
    expect(answer).toHaveBeenCalledTimes(3);
  });
  it('a dropped connection is the typed line, the list stays open and nothing is retried on its own', async () => {
    const dropped = Object.assign(new Error('connection lost'), { code: 'SERVICE_UNAVAILABLE' }), answer = vi.fn(async () => { throw dropped; }), h = await openAsking(answerPorts(answer));
    await press(h, 'a', 120); await until(() => h.stdout.frame.includes('Answer run'), 'card');
    await press(h, TAB); await press(h, 'main'); await press(h, TAB); await press(h, 'y', 150);
    await until(() => h.stdout.frame.includes('ERR:connection lost'), 'typed line');
    await settle(200); expect(answer).toHaveBeenCalledTimes(1); expect(h.stdout.frame).toContain('› Pick a branch');
  });
  it('without the answer port the row offers no a and opens no card; the TR card speaks Turkish', async () => {
    const h = await openAsking(answerPorts(undefined));
    expect(h.stdout.frame).not.toContain(EN.runControl!.keyAnswer!); await press(h, 'a', 120); expect(h.stdout.frame).not.toContain('Answer run');
    const tr = await openAsking(answerPorts(vi.fn(async () => 'TAMAM')), 'tr');
    expect(tr.stdout.frame).toContain(TR.runControl!.keyAnswer!); await press(tr, 'a', 120);
    await until(() => tr.stdout.frame.includes('9c8b7a6d işine cevap verilsin mi: Pick a branch?'), 'TR card');
    expect(tr.stdout.frame).toContain('İşçi soruyor: Which branch should I use?');
  });
  it('a run not waiting on a question never offers a (running, held)', async () => {
    const h = await open(ports(vi.fn()), 'en'); await press(h, 'a', 120); expect(h.stdout.frame).not.toContain('Answer run');
  });
});

describe('terminal answer port over the CLI handler (BR2)', () => {
  it('builds exactly the CLI lifecycle answer command (one schema) and names the command id; a refusal is the typed error unchanged', async () => {
    const lifecycle = { schemaVersion: 1 as const, layout: {} as never, lifecycle: { schemaVersion: 1 as const, commandId: 'x', run: { ...asking(), revision: 6, state: { kind: 'running' } } } };
    const apply = vi.fn<(root: string, command: unknown) => Promise<typeof lifecycle>>(async () => lifecycle);
    const port = createWorklineLedgerPorts({ root: '/project', scopeId: 'scope-a', options: { env: {} }, locale: 'en', renderRunCancellation: () => '',
      inspectWorkers: async () => ({}) as never, inspectRun: async () => ({}) as never, applyRunLifecycle: apply as never })!;
    const text = await port.answerTask!(ASKING, 'task-ask', 'use main', 5);
    const [root, command] = apply.mock.calls[0]! as unknown as [string, Record<string, unknown>];
    expect(root).toBe('/project'); expect(runLifecycleCommandSchema.parse(command)).toEqual(command);
    expect(command).toEqual({ schemaVersion: 1, commandId: command['commandId'], scopeId: 'scope-a', runId: ASKING, action: 'answer', taskId: 'task-ask', answer: 'use main', expectedRevision: 5 });
    expect(String(command['commandId'])).toMatch(/^terminal-run-answer-[0-9a-f-]{36}$/u);
    expect(text).toBe(`Answer for run 9c8b7a6d recorded, now running (revision 6). Command ${String(command['commandId'])}`);
    const denied = Object.assign(new Error('denied'), { code: 'POLICY_DENIED' });
    const refusing = createWorklineLedgerPorts({ root: '/p', scopeId: 's', options: {}, renderRunCancellation: () => '', inspectWorkers: async () => ({}) as never, inspectRun: async () => ({}) as never,
      applyRunLifecycle: vi.fn(async () => { throw denied; }) as never })!;
    await expect(refusing.answerTask!(ASKING, 'task-ask', 'x', 1)).rejects.toBe(denied);
    expect(createWorklineLedgerPorts({ root: '/p', scopeId: 's', options: {}, renderRunCancellation: () => '', inspectWorkers: async () => ({}) as never, inspectRun: async () => ({}) as never })!.answerTask).toBeUndefined();
  });
});
