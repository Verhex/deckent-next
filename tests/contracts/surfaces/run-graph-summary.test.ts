import { expect, it } from 'vitest';
import { createRun, summarizeTaskGraph, type RunSnapshot } from '#domain/index.js';
import { projectMonitorRun, projectRunView } from '#engine/index.js';
import { main } from '#surfaces/index.js';
import { loadMonitorSurface, renderGraphSummaryLines } from '#surfaces/core/monitor/index.js';
import { emptySnapshot } from '../../fixtures/monitor/snapshots.js';
import { fixtureExecution } from '../support/execution-registry.js';

// PARALLEL-S3: a 16-task graph in every phase; `run inspect` and the monitor render one typed engine summary.
const deps: Record<string, string[]> = { t01: [], t02: ['t01'], t03: ['t01'], t04: ['t02'], t05: ['t02'], t06: ['t03'], t07: ['t04'], t08: ['t07'],
  t09: ['t08'], t10: ['t05'], t11: ['t09', 't10'], t12: ['t04'], t13: [], t14: ['t13'], t15: ['t11'], t16: [] };
const phase: Record<string, string> = { t01: 'accepted', t02: 'accepted', t03: 'failed', t04: 'active', t05: 'evaluating', t06: 'skipped', t13: 'cancelled', t14: 'skipped', t16: 'awaiting-decision' };
const graph = { schemaVersion: 2, revision: 1, tasks: Object.entries(deps).map(([id, dependencies]) => ({ id, kind: 'coding', dependencies, acceptanceCriteria: ['ok'] })),
  criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'process-exit', version: 1 }, parameters: {} }] };
const base = createRun({ scopeId: 's', runId: 'r', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph));
const bound = ['t04', 't05', 't16'];
const run = { ...base, progress: base.progress.map(task => { const value = phase[task.taskId] ?? 'pending';
  return { ...task, phase: value, ...(value === 'skipped' ? { skippedReason: task.taskId === 't06' ? 'dependency-failed' : 'dependency-cancelled' } : {}),
    ...(value === 'awaiting-decision' ? { decision: { reason: 'evaluation-unknown', since: 1, deadline: 2 } } : {}) }; }),
  bindings: bound.map(taskId => ({ identity: { scopeId: 's', runId: 'r', layoutRevision: 'l', taskId, attemptId: `attempt-${taskId}`, generation: 1 },
    observedRevision: taskId === 't16' ? 1 : null, observedKind: taskId === 't16' ? 'exited' : null })) } as RunSnapshot;
const expected = { schemaVersion: 1, shape: { tasks: 16, edges: 14, depth: 8 },
  counts: { pending: 7, running: 2, attention: 1, accepted: 2, failed: 1, stopped: 3, total: 16 }, criticalPath: ['t04', 't07', 't08', 't09', 't11', 't15'] };
const monitorRun = () => projectMonitorRun({ run: { snapshot: run, poolId: null, admitted: true, createdAtMs: null, attempts: [] }, approvals: [], pool: null, workers: new Map(), observedAt: 10 });

it('run view and monitor carry the same typed DAG summary: counts, shape and the longest open chain', () => {
  expect(projectRunView(run).graphSummary).toEqual(expected);
  expect(monitorRun().graphSummary).toEqual(projectRunView(run).graphSummary);
  // Nothing open: no critical path; a missing progress entry is refused, never guessed.
  expect(summarizeTaskGraph(graph, graph.tasks.map(task => ({ taskId: task.id, phase: 'accepted' as const }))).criticalPath).toEqual([]);
  expect(() => summarizeTaskGraph(graph, run.progress.slice(1))).toThrow('TASK_PROGRESS_INCOMPLETE');
});
it.each(['en', 'tr'] as const)('run inspect and the monitor Run detail print the same summary lines in %s', async locale => {
  const view = projectRunView(run); const lines = renderGraphSummaryLines(view.graphSummary!, locale);
  const out: string[] = [];
  const context = { env: { NO_COLOR: '1', TERM: 'dumb' }, stdout: { write(value: string) { out.push(value); } }, stderr: { write() {} },
    async inspectRun() { return { schemaVersion: 1, layout: {}, run: view }; } };
  expect(await main(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', locale], context as never)).toBe(0);
  const surface = await loadMonitorSurface();
  const block = surface.buildMonitorView({ ...emptySnapshot, installs: [{ ...emptySnapshot.installs[0]!, runs: [monitorRun()] }] }, locale, false).tabs.runs[0]!;
  if (block.kind !== 'table') throw Error('expected table');
  const detail = block.rows[0]!.detail().map(line => line.map(cell => cell.text).join(''));
  for (const line of lines) { expect(out.join('')).toContain(line); expect(detail).toContain(line); }
  expect(lines[1]).toContain('t04 → t07 → t08 → t09 → t11 → t15');
});
