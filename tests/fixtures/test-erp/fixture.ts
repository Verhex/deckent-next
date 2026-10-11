import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { configuredApproval, executeConfiguredOperation, compensateConfiguredOperation, inspectConfiguredOperation } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { approvalRecordSchema, type EffectCommand, type EffectRecord } from '#domain/index.js';
import config from './config.json' with { type: 'json' };
import { startTestErp } from './server.js';
import { startInteractivePeer } from './terminal-peer.js';
import { fixtureAvailability, FixtureUnavailableError } from './availability.js';
import { runtimeBinaryAvailability, startFixtureRuntime } from './runtime.js';
import { correlateEvidence } from './evidence.js';
import { fixtureDockerRegistry } from '../../contracts/support/execution-registry.js';

export { config };
export async function testErpFixture(settings: { surface?: 'sdk' | 'runtime'; platform?: NodeJS.Platform } = {}) {
  const surface = settings.surface ?? 'sdk';
  const availability = fixtureAvailability(settings.platform);
  if (availability.status !== 'available') throw new FixtureUnavailableError(availability);
  if (surface === 'runtime') {
    const binary = await runtimeBinaryAvailability();
    if (binary.status !== 'available') throw new FixtureUnavailableError(binary);
  }
  const root = await mkdtemp(join(tmpdir(), 'deckent-test-erp-'));
  const cleanup: (() => Promise<void>)[] = [() => rm(root, { recursive: true, force: true })];
  try {
    const server = await startTestErp(); cleanup.push(server.close);
    const terminal = surface === 'sdk' ? await startInteractivePeer() : null;
    if (terminal) cleanup.push(terminal.close);
    const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
    const options = { env: { HOME: join(root, 'home') } };
    const descriptor = (operation: typeof config.operations.read, effectClass: 'read' | 'write', approval: 'policy' | 'required', compensation: typeof operation | null) => ({
      schemaVersion: 1, operation, targetKind: config.targetKind, effectClass, approval, precondition: effectClass === 'read' ? 'none' : 'record-version',
      compensation, inputMaxBytes: config.http.inputMaxBytes });
    const registry = { ...fixtureDockerRegistry(['business']), evaluators: [{ id: 'operation-evidence', version: 1, implementation: { id: 'operation-evidence', version: 1 } }],
      workClasses: { schemaVersion: 2, revision: 'test-process-policy', classes: [{ id: 'business', defaultEffort: 'high', acceptanceProfile: { schemaVersion: 1, version: 1,
        criterionTypes: ['completion'], evidenceTypes: ['operation-settlement'], rubric: [{ criterionType: 'completion', evidenceTypes: ['operation-settlement'], weight: 1 }],
        ceilingRules: [{ when: 'missing-evidence', maxScore: 0 }, { when: 'unsettled-effect', maxScore: 0 }], decisionThresholds: { rejectBelow: 0.4, acceptAt: 0.9 } } }], bindings: [{ kind: 'business', classId: 'business' }] } };
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') },
      admission: { poolId: 'process-pool', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry },
      ...(surface === 'runtime' ? { service: config.runtimeService, runRuntime: config.runRuntime, cancellation: config.cancellation,
        cancellationRuntime: config.cancellationRuntime, toolchains: config.toolchains } : {}), operations: {
      catalog: [descriptor(config.operations.read, 'read', 'policy', null), descriptor(config.operations.approve, 'write', 'required', config.operations.undo),
        descriptor(config.operations.undo, 'write', 'required', null)],
      targets: [{ adapter: 'http-conditional', options: { kind: config.targetKind, baseUrl: server.baseUrl, timeoutMs: config.http.timeoutMs,
        responseMaxBytes: config.http.responseMaxBytes, idempotencyLookup: true } }] } }));
    registerProviderConfig();
    const opened = await openConfiguredAttemptStore(project, options);
    await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'process-pool', capacity: { executionSlots: 1, inFlightSlots: 1 } }); opened.store.close();
    // A v2 policy requires a trusted bindings document even when its grants name principals directly.
    await writeFile(productResourcePath(opened.layout, 'bindings'), JSON.stringify({ schemaVersion: 2, revision: config.policy.revision,
      modes: [], bindings: [] }), { mode: 0o600 });
    const policy = async (fourEyes = false) => {
      await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 2, revision: config.policy.revision,
        roles: [], restrictions: [], grants: [
          { id: 'operations', effect: 'allow', actions: ['execute', 'compensate', 'inspect'], scopes: [config.scopeId],
            principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'operation', ids: 'all' } },
          ...(['run', 'pool', 'attempt'] as const).map(kind => ({ id: `process-${kind}`, effect: 'allow', actions: 'all', scopes: [config.scopeId],
            principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind, ids: 'all' } })),
          { id: 'approvals', effect: 'allow', actions: 'all', scopes: [config.scopeId],
            principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'approval', ids: 'all' } }],
        separationOfDuties: fourEyes ? [{ id: config.policy.fourEyesRuleId, rule: 'requester-cannot-approve', scopes: [config.scopeId] }] : [] }), { mode: 0o600 });
    };
    await policy();
    const runtime = surface === 'runtime' ? await startFixtureRuntime(project, root, options.env) : null;
    if (runtime) cleanup.push(runtime.close);
    const command = (commandId: string, changes: Partial<EffectCommand> = {}): EffectCommand => ({ schemaVersion: 1, commandId, scopeId: config.scopeId,
      operation: config.operations.approve, target: { kind: config.targetKind, id: config.recordId }, idempotencyKey: `${config.keyPrefix}-${commandId}`,
      input: { status: config.approvedStatus }, expectedVersion: server.etag(server.current().version), ...changes });
    const tracked = new Set<string>();
    const execute = (input: EffectCommand) => { tracked.add(input.commandId); return runtime
      ? runtime.command<Awaited<ReturnType<typeof executeConfiguredOperation>>>(['operation', 'execute'], input) : executeConfiguredOperation(project, input, options); };
    const compensate = (input: EffectCommand) => { tracked.add(input.commandId); return runtime
      ? runtime.command<Awaited<ReturnType<typeof compensateConfiguredOperation>>>(['operation', 'compensate'], input) : compensateConfiguredOperation(project, input, options); };
    const inspect = (commandId: string) => runtime
      ? runtime.command<Awaited<ReturnType<typeof inspectConfiguredOperation>>>(['operation', 'inspect', '--scope', config.scopeId, '--command-id', commandId])
      : inspectConfiguredOperation(project, { scopeId: config.scopeId, commandId }, options);
    const approvals = new Set<string>();
    const inspectApproval = (approvalId: string) => {
      const input = { schemaVersion: 1, scopeId: config.scopeId, approvalId };
      return runtime ? runtime.command<Awaited<ReturnType<typeof configuredApproval>>>(['approval', 'inspect'], input)
        : configuredApproval(project, 'inspect', input, options);
    };
    const decide = (approvalId: string, commandId: string, decision: 'allow' | 'deny' = 'allow') => {
      const input = { schemaVersion: 1, scopeId: config.scopeId, approvalId, commandId, expectedRevision: 0, decision, reason: 'Test operation card reviewed' };
      approvals.add(approvalId);
      return runtime ? runtime.command<Awaited<ReturnType<typeof configuredApproval>>>(['approval', 'decide'], input, true)
        : configuredApproval(project, 'decide', input, options, terminal!.peer);
    };
    const approve = async (input: EffectCommand, action: 'execute' | 'compensate' = 'execute') => {
      const pending = await (action === 'execute' ? execute(input) : compensate(input));
      if (pending.status !== 'approval-pending') throw new Error(`expected operation card, got ${pending.status}`);
      const decision = await decide(pending.approval.approvalId, `allow-${input.commandId}`);
      return { pending, decision };
    };
    const evaluations: unknown[] = [];
    const checkpoints: { label: string; record: EffectRecord | null }[] = [];
    const checkpoint = async (label: string, commandId: string) => { const { record } = await inspect(commandId); checkpoints.push({ label, record }); return record; };
    const close = async (name: string) => {
      try {
        const effects = await Promise.all([...tracked].map(async id => ({ id, ...await inspect(id) })));
        const approvalRecords = await Promise.all([...approvals].map(async id => ({ id, record: approvalRecordSchema.parse(await inspectApproval(id)) })));
        const correlations = correlateEvidence(effects, server.writes, server.idempotency, approvalRecords.map(value => value.record));
        const destination = process.env['DECKENT_TEST_ERP_PROOF'];
        if (destination) {
          const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
          const evidence = { schemaVersion: 1, name, surface, binary: runtime?.identity ?? null, record: server.current(), requests: server.requests,
            writes: server.writes, idempotency: [...server.idempotency], effects, approvals: approvalRecords, checkpoints, correlations,
            evaluation: evaluations.length ? { status: 'recorded', records: evaluations } : { status: 'not-requested' },
            digests: { effects: digest(effects), serverWrites: digest(server.writes), approvals: digest(approvalRecords) } };
          await mkdir(join(destination, 'evidence'), { recursive: true });
          await writeFile(join(destination, 'evidence', `${surface}-${name}.json`), JSON.stringify(evidence, null, 2) + '\n');
          await appendFile(join(destination, 'scenario-evidence.jsonl'), JSON.stringify(evidence) + '\n');
        }
      } finally { for (const finish of cleanup.reverse()) await finish(); clearConfigCache(); }
    };
    return { runtime, evaluations, server, project, options, policy, command, execute, compensate, inspect, inspectApproval, decide, approve, checkpoint, close,
      runtimeIdentity: runtime?.identity ?? null, restart: async () => { if (!runtime) throw new Error('runtime surface required'); await runtime.restart(); } };
  } catch (error) { for (const finish of cleanup.reverse()) await finish(); clearConfigCache(); throw error; }
}
