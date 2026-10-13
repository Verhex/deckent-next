import { createElement } from 'react';
import { appendFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectResultBrief, type RunProposalResult, type RunView, type SurfaceFollowEvent } from '#engine/index.js';
import type { WorkLedgerEntry, WorklineLedgerPorts } from '#surfaces/core/terminal-ledger/index.js';
import { runCompletionText, runDetailLines } from '#surfaces/core/terminal-work/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { terminalConfigSchema } from '#adapters/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

const captured = vi.hoisted(() => ({ entries: [] as WorkLedgerEntry[], seen: new WeakSet<object>() }));
vi.mock('#surfaces/core/terminal-work/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('#surfaces/core/terminal-work/index.js')>();
  return { ...original, LedgerEntryRow(props: Parameters<typeof original.LedgerEntryRow>[0]) {
    if (!captured.seen.has(props.entry)) { captured.seen.add(props.entry); captured.entries.push(props.entry); }
    return createElement(original.LedgerEntryRow, props);
  } };
});
const runId = 'do-run', EN = workSurfaceLabels('en'), TR = workSurfaceLabels('tr');
const brief = projectResultBrief('attempt', { verdict: 'accepted' }, { schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report: {
  schemaVersion: 1, summary: 'CLAIM-SENTINEL', changedFiles: [], checks: [{ command: 'verify-order', outcome: 'failed' }], openIssues: ['ISSUE-SENTINEL'],
} }, null, { deliveryOutlook: 'awaiting-delivery', failedTests: { count: 2, names: ['TEST-SENTINEL'], truncated: true } });
function run(id = runId, terminal = false, output = true): RunView {
  return { schemaVersion: 3, scopeId: 'scope-a', runId: id, revision: terminal ? 2 : 1, cancellationRequested: false,
    state: terminal ? { kind: 'terminal', outcome: 'completed', reason: 'completed' } : { kind: 'running' },
    tasks: [{ id: 'task', phase: terminal ? 'accepted' : 'active',
      taskBrief: { schemaVersion: 1, task: 'TASK-SENTINEL', scopePaths: [], acceptance: null, criteria: [], profile: null, model: null, effort: null, contextRefs: [] },
      ...(output ? { resultBrief: brief } : {}) }] } as unknown as RunView;
}
const mounted: ReturnType<typeof mountWorkline>[] = [];
beforeEach(() => { captured.entries = []; captured.seen = new WeakSet(); });
afterEach(() => { for (const view of mounted.splice(0)) view.instance.unmount(); });
function harness(output = true, limit = 2, withPush = true) {
  let current = run(), tick: (() => void) | undefined, reads = 0;
  const ledger: WorklineLedgerPorts = { scopeId: 'scope-a', listWorkers: async () => ({ schemaVersion: 1, scopeId: 'scope-a', observedAt: Date.now(), sources: [] }),
    listRunIds: async () => [runId, 'foreign'], inspectRun: async id => id === runId ? current : run('foreign', true),
    ...(withPush ? { readSurfaceSnapshot: async () => { reads++; return { scopeId: 'scope-a', denied: [], runs: [current, run('foreign', true)] }; },
      followEvents: async function* (signal: AbortSignal): AsyncIterable<SurfaceFollowEvent> {
        while (!signal.aborted) {
          yield { control: 'start', scopeId: 'scope-a', cursors: { worker: 0, run: 0, approval: 0 } };
          await new Promise<void>(resolve => { tick = resolve; signal.addEventListener('abort', resolve, { once: true }); });
        }
      } } : {}) };
  const plan = vi.fn(async () => ({ schemaVersion: 1, proposal: { status: 'admitted' }, run: current } as unknown as RunProposalResult));
  const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, work: EN }, ledger, maxTrackedRuns: limit, pollMs: withPush ? 60_000 : 25,
    doPlan: { planning: 'PLANNING', cancelHint: 'ESC', requestHint: 'REQUEST', plan, lines: () => ['ADMITTED-PREVIEW'] } }, 220);
  mounted.push(view);
  return { view, plan, ledger, reads: () => reads, publish: (next: RunView) => { current = next; tick?.(); },
    finish: () => { current = run(runId, true, output); tick?.(); }, pulse: () => tick?.() };
}
const completions = () => captured.entries.filter(entry => entry.kind === 'notice' && entry.text.startsWith(`Run ${runId} [`));
async function admit(h: ReturnType<typeof harness>) {
  await settle(); h.view.stdin.write('/do process order\r');
  await until(() => h.view.stdout.frame.includes('ADMITTED-PREVIEW'), 'admission preview');
  h.view.stdin.write('\u001b');
  await until(() => h.view.stdout.frame.includes(EN.live!.tasksTitle), 'tasks window');
  h.view.stdin.write('\u001b'); await settle();
}

describe('session /do completion and shared /run briefs', () => {
  it('notifies through the real Workline with /tasks closed, once across duplicate snapshots', async () => {
    const h = harness(); await admit(h);
    expect(h.view.stdout.frame).not.toContain(EN.live!.tasksTitle); h.finish();
    await until(() => completions().length === 1, 'completion');
    expect(completions()[0]).toMatchObject({ kind: 'notice', id: 'system-summary', level: 'info' });
    const text = (completions()[0] as Extract<WorkLedgerEntry, { kind: 'notice' }>).text;
    expect(text).toContain(`[${EN.jobs!.runStates['completed']}]`); expect(text).toContain('accepted 1'); expect(text).toContain('awaiting delivery 1'); expect(text).toContain(`/run ${runId}`);
    await until(() => h.view.stdout.text.includes(text), 'completion scrollback');
    if (process.env['DONGU_FRAME_PROOF']) appendFileSync(process.env['DONGU_FRAME_PROOF'], `\n## Completion, tasks closed\n${h.view.stdout.frame}\n`);
    const before = h.reads(); h.pulse(); await until(() => h.reads() > before, 'repeated snapshot'); await settle();
    expect(completions()).toHaveLength(1); expect(captured.entries.some(entry => entry.kind === 'notice' && entry.text.startsWith('Run foreign ['))).toBe(false);
  });
  it('does not notify runs that this session did not admit with /do', async () => {
    const h = harness(); await until(() => h.reads() > 0, 'opening'); h.finish();
    await until(() => h.reads() > 1, 'terminal snapshot'); await settle(); expect(completions()).toHaveLength(0);
  });
  it('ignores stale revisions and foreign-scope snapshots without losing the eventual completion', async () => {
    const h = harness(); await admit(h);
    for (const invalid of [{ ...run(runId, true), revision: 0 }, { ...run(runId, true), scopeId: 'other-scope' }]) {
      const before = h.reads(); h.publish(invalid); await until(() => h.reads() > before, 'invalid snapshot'); await settle();
      expect(completions()).toHaveLength(0);
    }
    h.finish(); await until(() => completions().length === 1, 'current completion');
  });
  it('announces a completion racing with admission only after its authorized snapshot', async () => {
    const h = harness(); h.finish(); await until(() => h.reads() > 0, 'opening terminal snapshot');
    expect(completions()).toHaveLength(0); await admit(h); await until(() => completions().length === 1, 'raced completion');
    h.pulse(); await settle(); expect(completions()).toHaveLength(1);
  });
  it('keeps the first open Run tracked and visibly warns when config capacity is full', async () => {
    const h = harness(true, 1); await admit(h);
    h.plan.mockResolvedValueOnce({ schemaVersion: 1, proposal: { status: 'accepted' }, run: run('second-run') } as unknown as RunProposalResult);
    h.view.stdin.write('/do another order\r');
    await until(() => captured.entries.some(entry => entry.kind === 'notice' && entry.text.includes('Completion tracking is full (1)')), 'capacity warning');
    expect(h.plan).toHaveBeenCalledTimes(2); h.finish(); await until(() => completions().length === 1, 'first Run retained');
  });
  it('keeps state/counts and an explicit unavailable line without read-output details or invented delivery totals', async () => {
    const h = harness(false); await admit(h); h.finish(); await until(() => completions().length === 1, 'redacted completion');
    const text = (completions()[0] as Extract<WorkLedgerEntry, { kind: 'notice' }>).text;
    expect(text).toContain('accepted 1'); expect(text).toContain('unknown 1');
    expect(captured.entries.filter(entry => entry.kind === 'notice' && entry.text === EN.jobs!.detailsUnavailable)).toHaveLength(1);
    for (const secret of ['TASK-SENTINEL', 'CLAIM-SENTINEL', 'ISSUE-SENTINEL', 'TEST-SENTINEL']) expect(text).not.toContain(secret);
    expect(text).not.toContain('Delivery is pending');
    h.pulse(); await settle(); expect(completions()).toHaveLength(1);
    expect(captured.entries.filter(entry => entry.kind === 'notice' && entry.text === EN.jobs!.detailsUnavailable)).toHaveLength(1);
  });
  it('observes admitted runs when only the existing inspection/poll ports are available', async () => {
    const h = harness(true, 2, false); await admit(h); h.finish(); await until(() => completions().length === 1, 'poll completion');
    await settle(60); expect(completions()).toHaveLength(1);
  });
  it.each(['en', 'tr'] as const)('%s /run renders shared CLAIM, open issues, failed tests and delivery outlook', async locale => {
    const work = workSurfaceLabels(locale), current = run(runId, true);
    const text = runDetailLines(current, work).map(line => line.spans.map(item => item.text).join('')).join('\n');
    for (const detail of ['CLAIM-SENTINEL', 'ISSUE-SENTINEL', 'TEST-SENTINEL', 'verify-order']) expect(text).toContain(detail);
    const h = harness(); h.view.instance.unmount();
    const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, work }, ledger: { ...h.ledger, followEvents: undefined, readSurfaceSnapshot: undefined, inspectRun: async () => current } }, 220, { rows: 100 });
    mounted.push(view); await settle(); view.stdin.write('/run\r'); await until(() => view.stdout.frame.includes('> TASK-SENTINEL'), 'run picker');
    view.stdin.write('\r'); await until(() => view.stdout.frame.includes('CLAIM-SENTINEL'), 'rendered brief');
    expect(view.stdout.frame).toContain('ISSUE-SENTINEL'); expect(view.stdout.frame).toContain('TEST-SENTINEL');
    if (process.env['DONGU_FRAME_PROOF']) appendFileSync(process.env['DONGU_FRAME_PROOF'], `\n## /run ${locale}\n${view.stdout.frame}\n`);
  });
  it('withholds denied task briefs while keeping authorized task details in a mixed /run', () => {
    const visible = run(runId, true), denied = run('denied', true, false).tasks[0]!;
    const text = runDetailLines({ ...visible, tasks: [visible.tasks[0]!, { ...denied, taskBrief: { ...denied.taskBrief!, task: 'DENIED-TASK' } }] }, EN)
      .flatMap(line => [...(line.label ?? []), ...line.spans]).map(item => item.text).join('\n');
    expect(text).toContain('CLAIM-SENTINEL'); expect(text).toContain(EN.jobs!.detailsUnavailable); expect(text).not.toContain('DENIED-TASK');
  });
  it('uses config defaults and validates bounds instead of a surface fallback literal', () => {
    expect(terminalConfigSchema.parse({ maxTrackedRuns: 1 }).maxTrackedRuns).toBe(1);
    for (const maxTrackedRuns of [0, -1, 1.5, 10_001]) expect(terminalConfigSchema.safeParse({ maxTrackedRuns }).success).toBe(false);
    expect(runCompletionText(run(runId, true), TR.jobs!)).toContain('kabul 1');
  });
});
