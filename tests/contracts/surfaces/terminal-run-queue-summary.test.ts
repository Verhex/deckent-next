import { describe, expect, it } from 'vitest';
import { DELIVERY_SUMMARY_ACTIONS, deliverySummarySchema, targetQueueViewSchema, type DeliverySummary, type RunView, type TargetQueueView } from '#engine/index.js';
import { renderDeliverySummary, ticketSummaryBlock } from '#surfaces/core/delivery-summary/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { queueRowSummaries, runDetailLines, runListStateText } from '#surfaces/core/terminal-work/index.js';
import { createWorklineLedgerPorts } from '../support/cli-ledger-ports.js';

/** alpha.54 g (1)+(2): the Run window's queue rows carry the same summary lines as the card; the Runs list names a held Run. */
const identity = { scopeId: 'scope', runId: 'run', layoutRevision: 'layout', taskId: 'task', attemptId: 'attempt', generation: 1 };
const evidence = { evaluator: { id: 'process-exit', version: 1 }, kind: 'exit-code', independent: false } as const;
const summary = (patch: Partial<DeliverySummary> = {}): DeliverySummary => deliverySummarySchema.parse({ schemaVersion: 1, operation: 'adopt', subject: identity,
  target: { state: 'available', id: 'refs/heads/integration', protected: false }, title: { source: 'work-input', text: 'Login banner fix' },
  outcome: { state: 'available', claim: true, summary: 'Banner fixed.', truncated: false }, acceptance: { verdict: 'accepted', criteriaCount: 2, evidence: [evidence] },
  tests: { worker: { state: 'withheld' }, verification: { state: 'unavailable' } }, model: { state: 'withheld' },
  risk: { class: 'small', workClass: 'small', protectedTarget: false, sizeBucket: 'tiny', flags: [] }, actions: DELIVERY_SUMMARY_ACTIONS.adopt,
  change: { state: 'withheld' }, ...patch });
const view = (commandId: string): TargetQueueView => targetQueueViewSchema.parse({ schemaVersion: 1, commandId, identity, operation: 'delivery',
  target: { kind: 'git-ref', id: 'refs/heads/integration' }, display: { schemaVersion: 1, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' },
  state: 'awaiting-confirmation', outcome: null, revision: 1, observedAt: 1, freshness: 'last-known', position: 1, nextAction: 'confirm-batch', responsibility: 'human',
  basis: { observed: 'o', effective: 'e', candidate: 'c' }, verification: null, evidenceRefs: [], reason: null });
const base = { schemaVersion: 3, runId: 'r1', scopeId: 'scope', revision: 1, cancellationRequested: false, state: { kind: 'running' }, tasks: [] };
const withQueue = (...records: TargetQueueView[]) => ({ ...base, targetQueue: { records, truncated: false } }) as unknown as RunView;
const text = (lines: ReturnType<typeof runDetailLines>) => lines.map(line => [...(line.label ?? []), ...line.spans].map(part => part.text).join('')).join('\n');
const held = (state: Record<string, unknown>) => ({ ...base, state: { kind: 'parked', since: 1, deadline: 99, ...state } }) as unknown as RunView;

describe.each(['en', 'tr'] as const)('Run window queue rows (%s)', locale => {
  const work = workSurfaceLabels(locale);
  it('shows the ticket summary lines under its row, the same lines as the card', () => {
    const run = withQueue(view('q1')), lines = ticketSummaryBlock(summary(), undefined, locale), out = text(runDetailLines(run, work, [lines]));
    expect(lines).toEqual(renderDeliverySummary(summary(), locale));
    for (const line of lines) expect(out).toContain(line);
  });
  it('no summary reader adds nothing', async () => {
    const run = withQueue(view('q1'));
    expect(text(runDetailLines(run, work))).not.toContain('Login banner fix');
    expect(await queueRowSummaries(run, undefined)).toBeUndefined();
  });
  it('queueRowSummaries reads the rows once, in order; a failed read adds nothing and no rows read nothing', async () => {
    const run = withQueue(view('q1'), view('q2')), seen: string[] = [];
    expect(await queueRowSummaries(run, async views => { seen.push(...views.map(item => item.commandId)); return views.map(() => ['a']); })).toEqual([['a'], ['a']]);
    expect(seen).toEqual(['q1', 'q2']);
    expect(await queueRowSummaries(run, async () => { throw new Error('boom'); })).toEqual([[], []]);
    expect(await queueRowSummaries(base as unknown as RunView, async () => { throw new Error('unused'); })).toBeUndefined();
  });
  it('the terminal ledger port renders each row with the card renderer; an unreadable summary is the not-available line, a failed reader too', async () => {
    const root = { root: '/p', scopeId: 'scope', options: {}, locale, async inspectWorkers() { throw new Error('unused'); }, async inspectRun() { throw new Error('unused'); } } as const;
    const ports = createWorklineLedgerPorts({ ...root, describeQueueSummaries: async (_root, requests) => requests.map((_, index) => index === 0 ? summary() : null) })!;
    const [first, second] = await ports.queueSummaryLines!([view('q1'), view('q2')].map(item => item) as never);
    expect(first).toEqual(renderDeliverySummary(summary(), locale)); expect(second).toEqual(ticketSummaryBlock(null, undefined, locale)); expect(second).toHaveLength(1);
    const failing = createWorklineLedgerPorts({ ...root, describeQueueSummaries: async () => { throw new Error('down'); } })!;
    expect(await failing.queueSummaryLines!([view('q1')] as never)).toEqual([ticketSummaryBlock(null, undefined, locale)]);
    expect(createWorklineLedgerPorts({ ...root })!.queueSummaryLines).toBeUndefined();
  });
});

describe.each(['en', 'tr'] as const)('Run list label of a held Run (%s)', locale => {
  const labels = workSurfaceLabels(locale).jobs!;
  it('a plain hold names the hold; a hold over another park names both', () => {
    const plain = held({ reason: 'operator-hold', note: 'wait' }), over = held({ reason: 'quota-exhausted', operatorHold: { schemaVersion: 1, note: 'wait' } });
    expect(runListStateText(plain, labels)).toContain(labels.parkReasons!['operator-hold']!);
    expect(runListStateText(over, labels)).toContain(labels.parkReasons!['quota-exhausted']!);
    expect(runListStateText(over, labels)).toContain(labels.parkReasons!['operator-hold']!);
    expect(runListStateText({ ...base } as unknown as RunView, labels)).toBe(labels.runStates['running']);
  });
});
