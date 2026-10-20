import { expect, it } from 'vitest';
import { createRun, type AuthorityAdmission } from '#domain/index.js';
import { projectMonitorRun, projectRunView } from '#engine/index.js';
import { t } from '#platform/index.js';
import { main } from '#surfaces/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { emptySnapshot } from '../../fixtures/monitor/snapshots.js';
import { fixtureExecution } from '../support/execution-registry.js';

const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 'invoice', kind: 'business-process', dependencies: [], acceptanceCriteria: ['settled'] }],
  criterionDefinitions: [{ id: 'settled', version: 1, description: 'Durable business evidence', evaluator: { id: 'operation', version: 1 }, parameters: {} }] };
const legacy = createRun({ scopeId: 's', runId: 'r', layoutRevision: 'layout' }, graph, 0, fixtureExecution(graph));
const authority: AuthorityAdmission = { decision: { eventId: `decision:${'a'.repeat(64)}`, sequence: 17 },
  approval: { approvalId: 'approval-17', actionDigest: 'b'.repeat(64), requestDigest: 'c'.repeat(64), commandId: 'human-decision-17' } };

it.each(['en', 'tr'] as const)('inspect JSON, text and monitor detail expose the same decision and approval reference (%s)', async locale => {
  const run = { ...legacy, authority }, view = projectRunView(run), output: string[] = [];
  const context = { env: { NO_COLOR: '1', TERM: 'dumb' }, stdout: { write(value: string) { output.push(value); } }, stderr: { write() {} },
    async inspectRun() { return { schemaVersion: 1, layout: {}, run: view }; } };
  const command = ['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', locale];
  expect(await main([...command, '--json'], context as never)).toBe(0);
  expect(JSON.parse(output.pop()!).run.authority).toEqual(authority);
  // C-RUN (CLI review §run): the authority record is an internal record, shown with --verbose; the default view does not carry it.
  expect(await main(command, context as never)).toBe(0);
  expect(output.join('')).not.toContain(authority.decision.eventId);
  expect(await main([...command, '--verbose'], context as never)).toBe(0);
  const line = t('cli.run.inspect.authority', { record: authority.decision.eventId, sequence: 17, approval: 'approval-17' }, locale);
  expect(output.join('')).toContain(line);
  const monitor = projectMonitorRun({ run: { snapshot: run, poolId: null, admitted: true, createdAtMs: 0, attempts: [] }, approvals: [], pool: null, workers: new Map(), observedAt: 10 });
  expect(monitor.authority).toEqual(authority);
  const surface = await loadMonitorSurface(), block = surface.buildMonitorView({ ...emptySnapshot,
    installs: [{ ...emptySnapshot.installs[0]!, runs: [monitor] }] }, locale, false).tabs.runs[0]!;
  if (block.kind !== 'table') throw Error('expected Run table');
  expect(block.rows[0]!.detail().map(row => row.map(cell => cell.text).join(''))).toContain(line);
});
it('historical Runs expose no invented decision or approval reference', () => {
  expect(projectRunView(legacy).authority).toBeUndefined();
  expect(projectMonitorRun({ run: { snapshot: legacy, poolId: null, admitted: true, createdAtMs: 0, attempts: [] },
    approvals: [], pool: null, workers: new Map(), observedAt: 10 }).authority).toBeUndefined();
});
