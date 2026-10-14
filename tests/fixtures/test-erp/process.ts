import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRun, evaluateTask, inspectRun } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { FileArtifactStore, openSqliteAttemptStore } from '#adapters/index.js';
import { prepareProductDirectory } from '#platform/index.js';
import { type AttemptIdentity, type EffectCommand } from '#domain/index.js';
import { custodyPrincipal, custodyProfiles, dispatchAdmission } from '../../contracts/support/custody.js';
import { config, type testErpFixture } from './fixture.js';

type Fixture = Awaited<ReturnType<typeof testErpFixture>>;
export const processWorkerPrincipal = Object.freeze({ ...custodyPrincipal, scopeIds: Object.freeze([config.scopeId]) });
/** Test-only worker custody producer. Real admission/evaluation/operation paths are used; no native worker is claimed. */
export async function startProcess(f: Fixture, commands: readonly EffectCommand[]) {
  const runId = 'purchase-order-process';
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: commands.map((_, index) => ({ id: `step-${index}`, kind: 'business',
    dependencies: index ? [`step-${index - 1}`] : [], acceptanceCriteria: [`criterion-${index}`] })),
    criterionDefinitions: commands.map((command, index) => ({ id: `criterion-${index}`, version: 1, description: 'Verify durable operation settlement',
      evaluator: { id: 'operation-evidence', version: 1 }, parameters: { commandId: command.commandId } })) };
  const create = { schemaVersion: 1 as const, commandId: 'create-process', scopeId: config.scopeId, runId, graph };
  if (f.runtime) {
    const path = join(f.project, 'process-graph.json'); await writeFile(path, JSON.stringify(graph));
    await f.runtime.command(['run', 'create', '--scope', config.scopeId, '--id', runId, '--command-id', create.commandId, '--graph', path]);
  } else await createRun(f.project, create, f.options);
  const opened = await openConfiguredAttemptStore(f.project, f.options); opened.store.close();
  const open = () => openSqliteAttemptStore(opened.path, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' },
    { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
  const inspect = async () => f.runtime ? (await f.runtime.command<Awaited<ReturnType<typeof inspectRun>>>(
    ['run', 'inspect', '--scope', config.scopeId, '--id', runId])).run! : (await inspectRun(f.project, { schemaVersion: 1, scopeId: config.scopeId, runId }, f.options)).run!;
  /** The test process's wall time handed to each launch grant (diagnostics only; the store records its own `grantedAt`). */
  const granted = new Map<number, number>();
  const start = async (index: number) => {
    const store = await open();
    try {
      const run = (await store.loadRun(config.scopeId, runId))!;
      const identity: AttemptIdentity = { scopeId: config.scopeId, runId, layoutRevision: opened.layout.revision,
        taskId: `step-${index}`, attemptId: `attempt-${index}`, generation: 1 };
      await store.reserveRunTasks({ commandId: `reserve-${index}`, actor: { id: 'test-worker', issuer: 'test', subject: 'fixture' },
        scopeId: config.scopeId, runId, expectedRevision: run.revision, now: Date.now(), identities: [identity] });
      const claim = { owner: 'test-worker', request: { protocolVersion: 1 as const, identity, workspace: f.project, argv: ['operation-fixture'] } };
      await store.claimDispatch(dispatchAdmission(claim));
      const grantedAt = Date.now(); granted.set(index, grantedAt);
      await store.grantLaunch({ claim, principal: processWorkerPrincipal, now: grantedAt });
      const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(opened.layout, 'artifacts'), maxBytes: 65536 });
      const output = await artifacts.put(config.scopeId, Buffer.from(JSON.stringify({ schemaVersion: 1, identity,
        completeness: 'complete', stdout: 'fixture worker completed; operation ledger is the acceptance evidence', stderr: '' })));
      await store.retainDispatchOutput(claim, output); await store.finishDispatch(claim, { handle: `fixture-${index}`, exitCode: 0, interrupted: false });
      return identity;
    } finally { store.close(); }
  };
  const evaluate = async (identity: AttemptIdentity, commandId: string) => {
    const store = await open(); let expectedRevision: number;
    try { expectedRevision = (await store.loadRun(config.scopeId, runId))!.revision; } finally { store.close(); }
    const command = { schemaVersion: 1 as const, commandId, identity, expectedRevision };
    let result: Awaited<ReturnType<typeof evaluateTask>>;
    try { result = f.runtime ? await f.runtime.command<Awaited<ReturnType<typeof evaluateTask>>>(['task', 'evaluate', '--scope', identity.scopeId, '--run', identity.runId,
      '--task', identity.taskId, '--attempt', identity.attemptId, '--layout-revision', identity.layoutRevision, '--generation', String(identity.generation),
      '--command-id', commandId, '--expected-revision', String(expectedRevision)])
      : await evaluateTask(f.project, command, f.options); }
    catch (error) {
      try {
        const reader = await open();
        try {
          f.evaluations.push({ command, failure: error && typeof error === 'object' && 'code' in error ? error.code : String(error),
            snapshot: await reader.loadRun(config.scopeId, runId), dispatch: await reader.loadBoundDispatch(identity),
            effects: await Promise.all(commands.map(async value => ({ commandId: value.commandId,
              record: await reader.loadEffect(config.scopeId, value.commandId),
              compensation: await reader.loadEffectCompensation(config.scopeId, value.commandId) }))), workerCustody: 'test-only' });
        } finally { reader.close(); }
      } catch (diagnostic) {
        f.evaluations.push({ command, failure: String(error), diagnosticFailure: String(diagnostic), workerCustody: 'test-only' });
      }
      // Diagnostic collection must preserve the original product refusal and the test's assertion.
      throw error;
    }
    const reader = await open();
    try {
      const receipt = (await reader.loadRunReceipt(config.scopeId, commandId))!;
      const evaluation = JSON.parse(receipt.command).evaluation;
      f.evaluations.push({ command, evaluation, run: result.evaluation.run, workerCustody: 'test-only' });
      return { command, result, receipt, evaluation };
    } finally { reader.close(); }
  };
  const assertSettlement = async (index: number, evaluation: Awaited<ReturnType<typeof evaluate>>) => {
    const command = commands[index]!, record = (await f.inspect(command.commandId)).record!;
    // ERP-KANIT-YARISI: the verdict and the Task phase are read before the reference, so an evaluation that did not accept is reported by
    // its verdict/reason (with the settlement's observedAt and the launch grant time, the operation binding's `notBefore`), never as a
    // TypeError; an accepted Task without its settlement reference is named as such.
    const criterion = evaluation.evaluation.criteria[0], phase = evaluation.result.evaluation.run.tasks[index]?.phase;
    const reference = criterion?.evidenceReferences?.[0];
    if (!reference || criterion.verdict !== 'pass' || phase !== 'accepted') {
      throw new Error(`${phase === 'accepted' ? 'accepted Task without its settlement reference' : 'evaluation did not accept the settlement'}: ${JSON.stringify({
        index, phase: phase ?? null, verdict: criterion?.verdict ?? null, reason: criterion?.reason ?? null, references: criterion?.evidenceReferences ?? null,
        effectEvidence: criterion?.effectEvidence ?? null, record: { state: record.state, sequence: record.sequence, observedAt: record.evidence?.observedAt ?? null },
        launchGrantedAt: granted.get(index) ?? null })}`);
    }
    if (reference.id !== command.commandId || reference.digest !== createHash('sha256').update(JSON.stringify(record)).digest('hex')) throw new Error('acceptance/settlement binding mismatch');
    if (evaluation.evaluation.identity.taskId !== `step-${index}` || evaluation.result.evaluation.run.tasks[index]!.phase !== 'accepted') throw new Error('acceptance/Task binding mismatch');
    return { commandId: command.commandId, digest: reference.digest, inputDigest: record.intent.inputDigest, approval: record.intent.approval ?? null };
  };
  return { start, evaluate, inspect, assertSettlement, open, commands };
}
