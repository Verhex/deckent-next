import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELIVERY_SUMMARY_ACTIONS, deliverySummarySchema, projectResultBrief, targetQueueViewSchema, type RunView } from '#engine/index.js';
import type { WorkLedgerEntry, WorklineLedgerPorts, WorklineApproval } from '#surfaces/core/terminal-ledger/index.js';
import { ticketSummaryBlock } from '#surfaces/core/delivery-summary/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { runDetailLines } from '#surfaces/core/terminal-work/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { SLASH_WINDOW_TEST_LABELS, TYPED_ARGUMENT_NOTE } from '../support/slash-window-labels.js';

const captured = vi.hoisted(() => ({ entries: [] as WorkLedgerEntry[], seen: new WeakSet<object>() }));
vi.mock('#surfaces/core/terminal-work/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('#surfaces/core/terminal-work/index.js')>();
  return { ...original, LedgerEntryRow(props: Parameters<typeof original.LedgerEntryRow>[0]) {
    if (!captured.seen.has(props.entry)) { captured.seen.add(props.entry); captured.entries.push(props.entry); }
    return createElement(original.LedgerEntryRow, props);
  } };
});
const EN = workSurfaceLabels('en'), ESC = '\u001B';
const runId = '3f2a9c1e-8b4d-4e7a-9c55-1d2e3f4a5b6c', attemptId = '4b0c9811-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const run = { schemaVersion: 3, runId, scopeId: 'scope-a', revision: 7, cancellationRequested: false, state: { kind: 'running' }, tasks: [{ id: 'task-id', phase: 'active',
  taskBrief: { schemaVersion: 1, task: 'Fix checkout', model: null, scopePaths: [], acceptance: null, criteria: [], profile: null, effort: null, contextRefs: [] }, resultBrief: projectResultBrief(attemptId, { verdict: 'accepted' }, null, { state: 'delivered', commit: '0123456789abcdef' }) }] } as unknown as RunView;
const approval: WorklineApproval = { approvalId: 'approval-1', revision: 2, summary: 'Review checkout', expiresAt: Date.now() + 600_000, runId, taskId: 'task-id', requester: 'owner', status: 'pending', decision: null };
function ports(extra: Partial<WorklineLedgerPorts> = {}): WorklineLedgerPorts {
  return { scopeId: 'scope-a', listRunIds: async () => [runId], inspectRun: async id => id === runId ? run : null,
    listWorkers: async () => ({ schemaVersion: 1, observedAt: Date.now(), scopeId: 'scope-a', sources: [{ workers: [{ taskId: 'task-id', process: 'running', provider: 'codex', authority: 'next-ledger',
      identity: { scopeId: 'scope-a', runId, taskId: 'task-id', attemptId, generation: 1, layoutRevision: 'layout' } }] }] }) as never,
    inspectTranscript: async () => Array.from({ length: 90 }, (_, i) => `TRANSCRIPT ${i}`).join('\n'), listApprovalPage: async () => ({ items: [approval], nextAfter: null }),
    decideApproval: async (_target, decision) => ({ ...approval, decision, status: 'decided' }), cancelRun: async () => 'Cancellation requested', ...extra };
}
const mounted: ReturnType<typeof mountWorkline>[] = [];
let renderDir: string;
beforeEach(async () => { captured.entries = []; captured.seen = new WeakSet(); renderDir = await mkdtemp(join(tmpdir(), 'sw2-window-render-')); });
afterEach(async () => { for (const view of mounted.splice(0)) view.instance.unmount(); await rm(renderDir, { recursive: true, force: true }); });
const open = async (command: string, ledger = ports(), locale: 'en' | 'tr' = 'en', rows = 60, rich = false) => {
  const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, work: workSurfaceLabels(locale), ...(rich ? { windows: SLASH_WINDOW_TEST_LABELS } : {}) }, ledger, pollMs: 60_000 }, 100, { rows }); mounted.push(view);
  await settle(30); view.stdin.write(`${command}\r`); return view;
};
const choose = async (view: ReturnType<typeof mountWorkline>) => { await settle(40); view.stdin.write('\r'); };
const close = async (view: ReturnType<typeof mountWorkline>) => { await settle(40); view.stdin.write(ESC); await until(() => captured.entries.length > 0, 'summary'); };
async function snapshot(name: string, view: ReturnType<typeof mountWorkline>) {
  await writeFile(join(renderDir, `${name}.txt`), view.stdout.frame);
  const captureRoot = process.env['SW2_CAPTURE_DIR'];
  if (captureRoot && captureRoot.startsWith(`${tmpdir()}/`)) await writeFile(join(captureRoot, `${name}.txt`), view.stdout.frame);
}
function onlySummary() { expect(captured.entries).toHaveLength(1); expect(captured.entries[0]).toMatchObject({ kind: 'notice', id: 'system-summary' }); }

describe('SW-2 job windows', () => {
  it.each(['/workers', '/runs'] as const)('%s opens a list, never appends cards, and closes with one labelled line', async command => {
    const view = await open(command);
    await until(() => view.stdout.frame.includes(command === '/workers' ? 'worker 1' : 'Fix checkout'), 'list');
    expect(captured.entries).toEqual([]); expect(view.stdout.frame).not.toContain('Info:');
    await snapshot(command.slice(1), view);
    await close(view); onlySummary(); await snapshot(`${command.slice(1)}-summary`, view); expect(view.stdout.frame).toContain('◆ Deckent system ·'); expect(view.stdout.frame).not.toContain('rows 1');
  });
  it.each(['en', 'tr'] as const)('%s: run picker opens sections with human titles and muted short IDs', async locale => {
    const work = workSurfaceLabels(locale), view = await open('/run', ports(), locale);
    await until(() => view.stdout.frame.includes('> Fix checkout'), 'run picker'); await snapshot(`run-picker-${locale}`, view); expect(view.stdout.frame).not.toContain(runId);
    await choose(view); await until(() => view.stdout.frame.includes(work.jobs!.delivery), 'detail');
    for (const label of [work.jobs!.state, work.jobs!.tasks, work.jobs!.attempts, work.jobs!.delivery]) expect(view.stdout.frame).toContain(label);
    expect(view.stdout.frame).toContain('4b0c9811'); expect(view.stdout.frame).not.toContain(attemptId);
    await snapshot(`run-detail-${locale}`, view);
    expect(runDetailLines(run, work).some(line => line.spans.some(item => item.role === 'muted'))).toBe(true);
    await close(view); onlySummary();
  });
  it.each(['en', 'tr'] as const)('%s: /run shows the summary of a queue row read through the ledger port, and its not-available state when the read fails', async locale => {
    const subject = { scopeId: 'scope-a', runId, layoutRevision: 'layout', taskId: 'task-id', attemptId, generation: 1 };
    const ticket = targetQueueViewSchema.parse({ schemaVersion: 1, commandId: 'q1', identity: subject, operation: 'delivery', target: { kind: 'git-ref', id: 'refs/heads/integration' },
      display: { schemaVersion: 1, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' },
      state: 'awaiting-confirmation', outcome: null, revision: 1, observedAt: 1, freshness: 'last-known', position: 1, nextAction: 'confirm-batch', responsibility: 'human',
      basis: { observed: 'o', effective: 'e', candidate: 'c' }, verification: null, evidenceRefs: [], reason: null });
    const summary = deliverySummarySchema.parse({ schemaVersion: 1, operation: 'adopt', subject, target: { state: 'available', id: 'refs/heads/integration', protected: false },
      title: { source: 'work-input', text: 'Queue row headline' }, outcome: { state: 'withheld' }, acceptance: { verdict: 'accepted', criteriaCount: 1, evidence: [] },
      tests: { worker: { state: 'withheld' }, verification: { state: 'unavailable' } }, model: { state: 'withheld' },
      risk: { class: 'small', workClass: 'small', protectedTarget: false, sizeBucket: 'tiny', flags: [] }, actions: DELIVERY_SUMMARY_ACTIONS.adopt, change: { state: 'withheld' } });
    const queued = { ...run, targetQueue: { records: [ticket], truncated: false } } as unknown as RunView;
    const read = vi.fn(async () => [ticketSummaryBlock(summary, undefined, locale)]), shown = await open('/run', ports({ inspectRun: async () => queued, queueSummaryLines: read }), locale);
    await until(() => shown.stdout.frame.includes('> Fix checkout'), 'run picker'); await choose(shown);
    await until(() => shown.stdout.frame.includes('Queue row headline'), 'queue row summary'); expect(read).toHaveBeenCalledTimes(1); await snapshot(`run-queue-summary-${locale}`, shown);
    await close(shown); onlySummary();
    captured.entries = []; captured.seen = new WeakSet();
    const failing = await open('/run', ports({ inspectRun: async () => queued, queueSummaryLines: async () => { throw new Error('unreadable'); } }), locale);
    await until(() => failing.stdout.frame.includes('> Fix checkout'), 'run picker'); await choose(failing);
    await until(() => failing.stdout.frame.includes(workSurfaceLabels(locale).jobs!.delivery), 'detail'); await settle(40);
    expect(failing.stdout.frame).not.toContain('Queue row headline'); await close(failing);
  });
  it('picks the worker and pages the complete transcript by keys in a short terminal', async () => {
    const inspect = vi.fn(ports().inspectTranscript!), view = await open('/transcript', ports({ inspectTranscript: inspect }), 'en', 24);
    await until(() => view.stdout.frame.includes('> worker 1'), 'worker picker'); await choose(view);
    await until(() => view.stdout.frame.includes('TRANSCRIPT 0'), 'transcript'); await snapshot('transcript', view); expect(view.stdout.frame).not.toContain('TRANSCRIPT 89');
    await settle(40); view.stdin.write('\u001B[F'); await until(() => view.stdout.frame.includes('TRANSCRIPT 89'), 'last page');
    expect(inspect.mock.calls[0]![0].attemptId).toBe(attemptId); expect(captured.entries).toEqual([]); await close(view); onlySummary();
  });
  it.each(['y', 'n', ESC])('cancel picker excludes terminal/already cancelling runs; %s preserves revision authority', async key => {
    const cancel = vi.fn(async () => 'Cancellation requested');
    const ledger = ports({ listRunIds: async () => [runId, 'done', 'cancelling'], inspectRun: async id => id === runId ? run : { ...run, runId: id, cancellationRequested: id === 'cancelling', state: id === 'done' ? { kind: 'terminal', outcome: 'completed', reason: 'completed' } : { kind: 'running' }, tasks: [{ ...run.tasks[0]!, taskBrief: { ...run.tasks[0]!.taskBrief!, task: id } }] } as RunView, cancelRun: cancel });
    const view = await open('/cancel', ledger); await until(() => view.stdout.frame.includes('> Fix checkout'), 'cancel picker');
    expect(view.stdout.frame).not.toContain('> done'); expect(view.stdout.frame).not.toContain('cancelling'); await choose(view);
    await until(() => view.stdout.frame.includes('Cancel run 3f2a9c1e?'), 'card'); await snapshot('cancel', view); expect(captured.entries).toEqual([]);
    await settle(40); view.stdin.write(key); await until(() => captured.entries.length > 0, 'result'); onlySummary();
    expect(cancel.mock.calls).toEqual(key === 'y' ? [[runId, 7]] : []);
  });
  it('refreshes a chosen run and refuses cancellation if it became terminal', async () => {
    const inspect = vi.fn().mockResolvedValueOnce(run).mockResolvedValue({ ...run, state: { kind: 'terminal', outcome: 'completed' } }), cancel = vi.fn();
    const view = await open('/cancel', ports({ inspectRun: inspect, cancelRun: cancel }));
    await until(() => view.stdout.frame.includes('> Fix checkout'), 'picker'); await choose(view);
    await until(() => captured.entries.length > 0, 'closed'); expect(cancel).not.toHaveBeenCalled(); onlySummary();
  });
  it('approvals picker opens the unchanged card and aggregates its result into one line', async () => {
    const decide = vi.fn(ports().decideApproval!), view = await open('/approvals', ports({ decideApproval: decide }));
    await until(() => view.stdout.frame.includes('Review checkout'), 'approval picker'); expect(captured.entries).toEqual([]); await choose(view);
    await until(() => view.stdout.frame.includes('Approval needed'), 'approval card'); await snapshot('approval', view); await settle(40); view.stdin.write('y');
    await until(() => captured.entries.length > 0, 'approved'); onlySummary(); expect(decide).toHaveBeenCalledWith(approval, 'allow', undefined, undefined);
  });
  it.each(['y', 'n', ESC])('clear-session is a picker row and %s requires a confirmed window', async key => {
    const clear = vi.fn(async () => undefined), view = await open('/approvals', ports({ listApprovalPage: async () => ({ items: [], nextAfter: null }), clearSessionStanding: clear }));
    await until(() => view.stdout.frame.includes(EN.jobs!.clearSession), 'clear row'); await choose(view);
    await until(() => view.stdout.frame.includes(EN.jobs!.clearDetail), 'confirm window'); await snapshot('clear-session', view); expect(clear).not.toHaveBeenCalled(); await settle(40); view.stdin.write(key);
    await until(() => captured.entries.length > 0, 'summary'); onlySummary(); expect(clear).toHaveBeenCalledTimes(key === 'y' ? 1 : 0);
  });
  // SLASH-WINDOWS I-1 (owner 2026-10-08): in the rich terminal a typed argument opens the same window as the bare command; that window notes once
  // that the terminal takes no typed argument, and the typed text is never shown or used.
  it.each(['/run ARG-TYPED', '/transcript ARG-TYPED 2', '/cancel ARG-TYPED', '/approvals ARG-TYPED', '/approvals clear-session', '/workers ARG-TYPED', '/tasks ARG-TYPED', '/monitor --scope ARG-TYPED'])('%s opens the bare window with the one-time note, never the typed text', async command => {
    const decide = vi.fn(), inspect = vi.fn(), view = await open(command, ports({ decideApproval: decide, inspectTranscript: inspect }), 'en', 60, true);
    await until(() => view.stdout.frame.includes(TYPED_ARGUMENT_NOTE), 'window with the note'); expect(captured.entries).toEqual([]);
    expect(view.stdout.frame).not.toContain('ARG-TYPED'); expect(decide).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
    await close(view); onlySummary(); await settle(40);
    expect(view.stdout.frame).not.toContain(TYPED_ARGUMENT_NOTE);
  });
  it('/tasks keeps started/delivery words inside the window and leaves one summary when closed (Esc)', async () => {
    const view = await open('/tasks');
    await until(() => view.stdout.frame.includes('Watching · polling'), 'window status'); await snapshot('tasks', view);
    expect(captured.entries).toEqual([]); await close(view); onlySummary();
  });
  it('monitor uses one close summary and does not print its body', async () => {
    const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, work: EN }, monitorWindow: async () => () => createElement(Text, null, 'MONITOR-BODY') }); mounted.push(view);
    await settle(30); view.stdin.write('/monitor\r'); await until(() => view.stdout.frame.includes('MONITOR-BODY'), 'monitor'); await snapshot('monitor', view);
    expect(captured.entries).toEqual([]); await close(view); onlySummary(); expect(view.stdout.frame).not.toContain('MONITOR-BODY');
  });
  it('the opening snapshot leaves one system line for running work (I-5), never cards, and the window shows the rows', async () => {
    const ledger = ports({ followEvents: async function* (signal) {
      yield { control: 'start', scopeId: 'scope-a', cursors: { worker: 0, run: 0, approval: 0 } };
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    }, readSurfaceSnapshot: async () => ({ scopeId: 'scope-a', denied: [], runs: [run], workers: await ports().listWorkers(), approvals: [] }) });
    const view = await open('/tasks', ledger);
    await until(() => view.stdout.frame.includes('Fix checkout') && view.stdout.frame.includes('worker 1'), 'snapshot window');
    expect(captured.entries).toHaveLength(1); expect(captured.entries[0]).toMatchObject({ kind: 'notice', id: 'system-summary', text: 'Work running: 1 runs, 1 workers · /runs /workers' });
    view.stdin.write(ESC); await until(() => captured.entries.length === 2, 'close summary');
    expect(captured.entries.every(entry => entry.kind === 'notice' && entry.id === 'system-summary')).toBe(true);
  });
  it('keeps policy refusal inside a transcript window and leaves only one summary after close', async () => {
    const view = await open('/transcript', ports({ inspectTranscript: async () => { throw new Error('POLICY_DENIED'); } }));
    await until(() => view.stdout.frame.includes('> worker 1'), 'picker'); await choose(view);
    await until(() => view.stdout.frame.includes('ERR:POLICY_DENIED'), 'refusal window'); expect(captured.entries).toEqual([]); await close(view); onlySummary();
  });
});
