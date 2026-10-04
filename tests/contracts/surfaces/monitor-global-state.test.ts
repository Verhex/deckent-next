import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { createRun, reserveRunTasks, parkTaskAwaitingDecision } from '#domain/index.js';
import { MonitorApplication, type MonitorWorker, type MonitorLedgerAttempt } from '#engine/index.js';
import { cells } from '#surfaces/core/terminal-render/index.js';
import { resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { t } from '#platform/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { fullSnapshot, emptySnapshot, OBSERVED_AT } from '../../fixtures/monitor/snapshots.js';
const surface = await loadMonitorSurface();
for (const locale of ['en', 'tr'] as const) describe(`global monitor states ${locale}`, () => {
  it('human rows and shared text/fullscreen details show hold owner and every unknown, while snapshot JSON is preserved', () => {
    const run = { ...fullSnapshot.installs[0]!.runs[0]!, runId: 'held-source', state: 'blocked' as const,
      blocker: { code: 'unknown' as const, taskId: null, sinceMs: null, detail: 'worker-unobserved' } };
    const snapshot = { ...emptySnapshot, installs: [{ ...emptySnapshot.installs[0]!, runs: [run] }] }, before = JSON.stringify(snapshot);
    const view = surface.buildMonitorView(snapshot, locale, true), block = view.tabs.runs[0]!;
    if (block.kind !== 'table') throw new Error('expected table');
    expect(block.rows[0]!.cells[1]!.text).toBe(t('monitor.global.heldBy', { state: t('monitor.global.held', {}, locale), waitingOn: t('monitor.global.system', {}, locale) }, locale));
    const details = block.rows[0]!.detail().flat().map(span => span.text).join(' ');
    expect(details).toContain(t('monitor.global.inspectRun', {}, locale)); expect(details.match(new RegExp(t('monitor.time.unknown', {}, locale), 'g'))!.length).toBeGreaterThanOrEqual(2);
    expect(details).not.toContain(t('monitor.time.noExpiry', {}, locale));
    const text = surface.renderMonitorText(snapshot, { locale, width: 400, ascii: true });
    expect(text).toContain(t('monitor.global.system', {}, locale)); expect(text).toContain('worker-unobserved'); expect(text).not.toContain('\u001b[');
    expect(JSON.stringify(snapshot)).toBe(before); expect(snapshot.schemaVersion).toBe(1); expect(snapshot.observedAt).toBe(OBSERVED_AT);
  });
  it('queued and checking are distinct, failed is stopped, summary counts match projection', () => {
    const seed = fullSnapshot.installs[0]!.runs[0]!;
    const runs = [{ ...seed, runId: 'queued', state: 'waiting' as const, blocker: { code: 'waiting-pool-slot' as const, taskId: null, sinceMs: 0, detail: null } },
      { ...seed, runId: 'checking', state: 'waiting' as const, blocker: { code: 'worker-exited-unevaluated' as const, taskId: null, sinceMs: 0, detail: null } },
      { ...seed, runId: 'failed', state: 'failed' as const, blocker: null }];
    const snapshot = { ...emptySnapshot, installs: [{ ...emptySnapshot.installs[0]!, runs }] };
    const view = surface.buildMonitorView(snapshot, locale, true), block = view.tabs.runs[0]!;
    if (block.kind !== 'table') throw new Error('expected table');
    expect(block.rows.map(row => row.cells[1]!.text)).toEqual([t('monitor.global.queued', {}, locale), t('monitor.global.checking', {}, locale), t('monitor.global.stopped', {}, locale)]);
    const text = surface.renderMonitorText(snapshot, { locale, width: 400, ascii: true });
    expect(text).toContain(t('monitor.global.counts', { queued: 1, running: 0, checking: 1, held: 0, done: 0, stopped: 1 }, locale));
  });
});

const identity = (taskId: string) => ({ runId: 'parallel', scopeId: 'scope-parallel', layoutRevision: 'layout-1', taskId, attemptId: `attempt-${taskId}`, generation: 1 });
const observedWorker = (taskId: string): MonitorWorker => ({ taskId, identity: identity(taskId), authority: 'next-ledger', provider: 'claude', workspace: null,
  process: 'running', handle: null, terminal: null, outputRecorded: false, patchRecorded: false, diagnostics: [], files: {
    provider: 'claude', heartbeat: { state: 'available', ageMs: 0, freshness: 'fresh', phase: 'running' },
    log: { state: 'available', byteLength: 0, truncated: false, sampledLines: 0, diagnostics: [], events: [] },
    result: { state: 'missing', exitCode: null, reportedAssessment: null }, pid: null, activity: null, usage: null, eventsTruncated: false } });
async function parallelProducer(workers: readonly MonitorWorker[], unrelatedDecision = false) {
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: ['first', 'second'].map(id => ({ id, kind: 'coding', dependencies: [], acceptanceCriteria: ['ok'] })),
    criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'process-exit', version: 1 }, parameters: {} }] };
  const created = createRun({ runId: 'parallel', scopeId: 'scope-parallel', layoutRevision: 'layout-1' }, graph, 0, fixtureExecution(graph));
  const reserved = reserveRunTasks(created, created.revision, [identity('first'), identity('second')], 100);
  const snapshot = unrelatedDecision ? parkTaskAwaitingDecision({ ...reserved, bindings: reserved.bindings.map(binding => binding.identity.taskId === 'first' ? { ...binding, observedKind: 'exited' as const, observedRevision: 1 } : binding), progress: reserved.progress.map(task => task.taskId === 'first' ? { ...task, phase: 'evaluating' as const } : task) }, reserved.revision, 'first', 'evaluation-unknown', 200, 1000) : reserved;
  const attempts: MonitorLedgerAttempt[] = ['first', 'second'].map(taskId => ({ attemptId: identity(taskId).attemptId, generation: 1, observedKind: null, observedRevision: null,
    evaluationObserved: false, reservedAtMs: 100, sealedAtMs: null, dispatch: { launch: 'granted', grantedAtMs: 100, terminal: null, outputRecorded: false } }));
  const app = new MonitorApplication({ now: () => 300, describeService: async () => { throw Object.assign(new Error(), { code: 'LOCAL_RUNTIME_UNAVAILABLE' }); },
    readLedger: async () => ({ ledgerVersion: 44, diagnostics: [], scopeIds: ['scope-parallel'], approvals: [], pools: [], runs: [{ snapshot, admitted: true, poolId: null, createdAtMs: 0, attempts }] }),
    observeScope: async () => ({ access: 'admitted', workers, workerStatus: 'available', truncated: false }) });
  return app.inspect([{ id: 'current', path: '/fixture' }]);
}
function taskCell(snapshot: typeof fullSnapshot, locale: 'en' | 'tr', taskId: string) {
  const block = surface.buildMonitorView(snapshot, locale, true).tabs.runs[0]!;
  if (block.kind !== 'table') throw new Error('Run table expected');
  return block.rows[0]!.detail().find(line => line.some(part => part.text.startsWith(`  ${taskId} (`)))![0]!.text;
}
for (const locale of ['en', 'tr'] as const) describe(`S2 review corrections ${locale}`, () => {
  it.each([false, true])('domain reservation -> real monitor producer -> both parallel consumers agree (unrelated decision %s)', async decision => {
    const snapshot = await parallelProducer([observedWorker('first'), observedWorker('second')], decision), before = JSON.stringify(snapshot);
    expect(snapshot.installs[0]!.runs[0]!.blocker?.taskId).toBe('first');
    for (const taskId of decision ? ['second'] : ['first', 'second']) {
      expect(taskCell(snapshot, locale, taskId)).toBe(t('monitor.global.running', {}, locale));
      const block = surface.buildMonitorView(snapshot, locale, true).tabs.workers[0]!;
      if (block.kind !== 'table') throw new Error('worker table expected');
      expect(block.rows.find(row => row.key === `current:attempt-${taskId}`)!.cells[1]!.text).toBe(taskCell(snapshot, locale, taskId));
    }
    expect(JSON.stringify(snapshot)).toBe(before);
  });
  it('secondary task never borrows missing/stale/denied or foreign installation/scope/run/task/attempt/generation worker custody', async () => {
    const fresh = observedWorker('second');
    const variants = [undefined, { ...fresh, process: 'missing' as const }, { ...fresh, process: 'denied' as const, files: null },
      { ...fresh, files: { ...fresh.files!, heartbeat: { ...fresh.files!.heartbeat, freshness: 'stale' as const } } },
      ...[{ scopeId: 'other' }, { runId: 'other' }, { taskId: 'other' }, { attemptId: 'other' }, { generation: 2 }].map(delta => ({ ...fresh, identity: { ...fresh.identity!, ...delta } })),
      { ...fresh, taskId: 'other' }];
    for (const value of variants) {
      const snapshot = await parallelProducer([observedWorker('first'), ...(value ? [value] : [])], true);
      expect(taskCell(snapshot, locale, 'second')).toContain(t('monitor.global.held', {}, locale));
    }
    const snapshot = await parallelProducer([observedWorker('first')], true);
    const foreign = { ...snapshot.installs[0]!, id: 'foreign', runs: [], workers: [fresh] };
    expect(taskCell({ ...snapshot, installs: [...snapshot.installs, foreign] }, locale, 'second')).toContain(t('monitor.global.held', {}, locale));
  });
  it.each([80, 40])('closed worker rows retain complete you/operator/system labels at %s cells and grouped state', async width => {
    const produced = await parallelProducer([observedWorker('second')], true), seed = produced.installs[0]!.runs[0]!;
    const codes = ['awaiting-approval', 'pool-held', 'unknown'] as const;
    const runs = codes.map((code, i) => ({ ...seed, runId: `hold-${i}`, tasks: seed.tasks.filter(task => task.taskId === 'second'), blocker: { code, taskId: 'second', sinceMs: null, detail: null } }));
    const workers = runs.map(run => ({ ...observedWorker('second'), identity: { ...identity('second'), runId: run.runId } }));
    const snapshot = { ...produced, installs: [{ ...produced.installs[0]!, runs, workers }] };
    const blocks = surface.buildMonitorView(snapshot, locale, true).tabs.workers;
    const flat = surface.flattenBlocks(blocks, width, '...'), text = flat.map(entry => surface.lineText(entry.line)).join('\n');
    expect(flat.filter(entry => entry.item !== undefined)).toHaveLength(3);
    for (const who of ['you', 'operator', 'system']) {
      const label = t('monitor.global.heldBy', { state: t('monitor.global.held', {}, locale), waitingOn: t(`monitor.global.${who}`, {}, locale) }, locale);
      expect(text).toContain(label);
      const table = blocks[0]!; if (table.kind !== 'table') throw new Error('worker table expected');
      expect(table.rows.map(row => row.facets?.stateLabel)).toContain(label);
    }
    expect(Math.max(...text.split('\n').map(cells))).toBeLessThanOrEqual(width);
    const frame = renderToString(createElement(surface.MonitorApp, { load: async () => snapshot, initial: snapshot, intervalMs: 60_000, locale, ascii: true, palette: resolveWorklinePalette('none'), errorText: () => 'error', size: { columns: width, rows: 40 } }), { columns: width });
    for (const who of ['you', 'operator', 'system']) expect(frame).toContain(t('monitor.global.heldBy', { state: t('monitor.global.held', {}, locale), waitingOn: t(`monitor.global.${who}`, {}, locale) }, locale));
    expect(frame).not.toContain('\u001b['); expect(Math.max(...frame.split('\n').map(cells))).toBeLessThanOrEqual(width);
  });
});
