import { expect, it } from 'vitest';
import { applyTaskEvaluation, bindTaskAcceptance, type TaskEvaluation } from '#domain/index.js';
import { dispatchRecordSchema, RunInspectionApplication, selectRunAcceptanceEvaluations } from '#engine/index.js';
import { evaluating, evidence, identity } from '../domain/acceptance-fixture.js';

function command(evaluation: TaskEvaluation, revision: number) {
  const dispatch = dispatchRecordSchema.parse({ schemaVersion: 2, owner: 'worker-owner', launch: 'granted',
    profile: { schemaVersion: 1, adapterId: 'test', adapterVersion: 1, parameters: {} },
    request: { protocolVersion: 1, identity: evaluation.identity, workspace: '/fixture', argv: ['fixture-command'] },
    grant: { generation: evaluation.identity.generation, grantedAt: 1, principal: { id: 'actor', issuer: 'test', subject: 'author' } },
    terminal: { handle: 'handle', exitCode: 0, interrupted: false },
    output: { schemaVersion: 1, scopeId: evaluation.identity.scopeId, digest: 'a'.repeat(64), byteLength: 10 } });
  return { commandId: evaluation.evaluationId, command: JSON.stringify({ action: 'apply-task-evaluation', commandId: evaluation.evaluationId,
    actor: { id: 'actor', issuer: 'test', subject: 'author' }, expectedRevision: revision, evaluation, dispatch, now: 100, timeoutMs: 1000 }) };
}
function fixture() {
  const { run } = evaluating(), evaluation = bindTaskAcceptance(run, evidence());
  const accepted = applyTaskEvaluation(run, run.revision, evaluation, { now: 100, timeoutMs: 1000 }).snapshot;
  return { run, evaluation, accepted, encoded: command(evaluation, run.revision) };
}
it('missing canonical receipt stays unknown; a later producer cannot hydrate an older inspected revision', () => {
  const f = fixture();
  expect(selectRunAcceptanceEvaluations(f.accepted, [])).toEqual([]);
  expect(selectRunAcceptanceEvaluations(f.run, [f.encoded])).toEqual([]);
  expect(selectRunAcceptanceEvaluations(f.accepted, [f.encoded])).toEqual([f.evaluation]);
  expect(Object.isFrozen(selectRunAcceptanceEvaluations(f.accepted, [f.encoded]))).toBe(true);
});
it('selects the latest exact canonical evaluation independent of receipt insertion order', () => {
  const f = fixture(), unknown = bindTaskAcceptance(f.run, { ...evidence('unknown'), evidenceDigests: ['a'.repeat(64)] });
  const waiting = applyTaskEvaluation(f.run, f.run.revision, unknown, { now: 100, timeoutMs: 1000 }).snapshot;
  const returned = bindTaskAcceptance(waiting, { ...evidence(), evaluationId: 'returned-evidence',
    evidenceDigests: ['b'.repeat(64)], returnEvidence: { kind: 'output', digest: 'b'.repeat(64) } });
  const accepted = applyTaskEvaluation(waiting, waiting.revision, returned, { now: 200, timeoutMs: 1000 }).snapshot;
  const receipts = [command(unknown, f.run.revision), command(returned, waiting.revision)];
  expect(selectRunAcceptanceEvaluations(accepted, receipts)).toEqual([returned]);
  expect(selectRunAcceptanceEvaluations(accepted, receipts.reverse())).toEqual([returned]);
  expect(selectRunAcceptanceEvaluations(waiting, receipts)).toEqual([unknown]);
});
it.each(['scopeId', 'runId', 'taskId', 'attemptId', 'layoutRevision', 'generation'] as const)('does not consume a receipt for another %s', key => {
  const f = fixture(), foreign = { ...f.evaluation, identity: { ...identity, [key]: key === 'generation' ? 2 : 'foreign' } };
  expect(selectRunAcceptanceEvaluations(f.accepted, [command(foreign, f.run.revision), f.encoded])).toEqual([f.evaluation]);
});
it('excludes obsolete graph/Attempt revisions and rejects mismatched frozen acceptance or dispatch identity', () => {
  const f = fixture();
  for (const evaluation of [{ ...f.evaluation, attemptRevision: 2 }, { ...f.evaluation, graphRevision: 2 }]) {
    expect(selectRunAcceptanceEvaluations(f.accepted, [command(evaluation, f.run.revision)])).toEqual([]);
  }
  const mismatched = { ...f.evaluation, acceptance: { ...f.evaluation.acceptance!, policyRevision: 'foreign-policy' } };
  expect(() => selectRunAcceptanceEvaluations(f.accepted, [command(mismatched, f.run.revision)])).toThrow('RUN_STORE_CORRUPT');
  const row = JSON.parse(f.encoded.command); row.dispatch.request.identity.generation++;
  expect(() => selectRunAcceptanceEvaluations(f.accepted, [{ ...f.encoded, command: JSON.stringify(row) }])).toThrow('RUN_STORE_CORRUPT');
});
it('corrupt and conflicting canonical producers are typed refusals, including older duplicate revisions', () => {
  const f = fixture();
  for (const encoded of ['{', '{}', JSON.stringify({ ...JSON.parse(f.encoded.command), commandId: 'wrong' })]) {
    expect(() => selectRunAcceptanceEvaluations(f.accepted, [{ ...f.encoded, command: encoded }])).toThrow('RUN_STORE_CORRUPT');
  }
  expect(() => selectRunAcceptanceEvaluations(f.accepted, [{ ...f.encoded, commandId: 'wrong-row-key' }])).toThrow('RUN_STORE_CORRUPT');
  const later = command({ ...f.evaluation, evaluationId: 'later' }, f.run.revision + 1), inspected = { ...f.accepted, revision: f.accepted.revision + 1 };
  for (const rows of [[f.encoded, f.encoded], [f.encoded, later, f.encoded], [later, f.encoded, f.encoded]]) {
    expect(() => selectRunAcceptanceEvaluations(inspected, rows)).toThrow('RUN_STORE_CORRUPT');
  }
});
it('inspection authorizes before reading evaluations and never reads them for a foreign Run snapshot', async () => {
  const f = fixture(), query = { schemaVersion: 1, scopeId: identity.scopeId, runId: identity.runId };
  const principal = { id: 'actor', issuer: 'test', subject: 'author', assurance: 'os-user' as const, scopeIds: [identity.scopeId] };
  let reads = 0;
  const store = { async loadRun() { return f.accepted; }, async loadRunEvaluations() { reads++; return [f.evaluation]; } };
  const app = new RunInspectionApplication(store, { async verify() { return principal; } }, { async authorize() { throw new Error('DENIED'); } });
  await expect(app.inspect(query)).rejects.toThrow('DENIED'); expect(reads).toBe(0);
  const foreign = new RunInspectionApplication({ ...store, async loadRun() { return { ...f.accepted, identity: { ...f.accepted.identity, runId: 'foreign' } }; } },
    { async verify() { return principal; } }, { async authorize() {} });
  await expect(foreign.inspect(query)).rejects.toThrow('RUN_STORE_CORRUPT'); expect(reads).toBe(0);
});
