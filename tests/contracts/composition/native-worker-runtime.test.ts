import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { brainProviderFixture } from '../support/brain-provider.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { nativeWorkerAdmission, createConfiguredNativeCliWorkerPorts, type NativeCliWorkerRuntime } from '#composition/core/execution/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { recheckNativeWorkerUse } from '#composition/core/runs/index.js';
import { createNativeCodingTemplate, compileNativeCodingWorkInput, nativeCliAgent, nativeAgentFlagSetDigest,
  resolveNativeCliWorkerProfile, inspectNativeCliWorker, readLocalOsIdentity, localPrincipalChannel, type NativeCliWorkerBinding } from '#adapters/index.js';
import { openSqliteLedgerReadOnly, findCapacityResource } from '#adapters/core/sqlite-ledger/index.js';
import { headlessCapacityBinding } from '#adapters/core/sqlite-model-invocation/index.js';
import { FIRST_RUN_TOOL_NAMES, modelInvocationProfileDigest, connectedModelProfile } from '#engine/index.js';
import { FIRST_RUN_UPGRADE_RULE_IDS, firstRunPolicyTemplate, modelInvocationProfileSchema } from '#domain/index.js';
import { clearConfigCache } from '#platform/index.js';

it('K17: worker ports use fresh K5 workload authority and the existing K6 reservation without an invocation claim', async () => {
  const owner = readLocalOsIdentity(), f = await brainProviderFixture({ headless: { executable: process.execPath,
    configDir: '/synthetic/login', stateDir: '/synthetic/state', delegatedUse: { consentedBy: { issuer: owner.issuer, subject: owner.subject }, atMs: 1, classes: ['ai'] } } });
  try {
    // R4a: the real first-run template (v19), never an injected MCP grant: the worker pin runs as the MCP actor on its v19 model rule.
    const policyPath = join(f.data, 'policy.json'), firstRun = firstRunPolicyTemplate({ scopeId: 's', principal: { issuer: owner.issuer, subject: owner.subject }, ...FIRST_RUN_TOOL_NAMES });
    const policy = JSON.parse(JSON.stringify(firstRun.policy)) as { grants: { id: string }[] };
    await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 }); await writeFile(join(f.data, 'bindings.json'), JSON.stringify(firstRun.bindings), { mode: 0o600 }); clearConfigCache();
    const context = await loadConfiguredScopeContext(f.project, 's', f.options, 'write'), profile = modelInvocationProfileSchema.parse(f.config.provider_invocation_profiles.profiles[0]);
    const db = openSqliteLedgerReadOnly(f.path, context.config.storage.sqlite);
    let resource;
    try { resource = findCapacityResource(db, headlessCapacityBinding(profile.adapter.definition))!; } finally { db.close(); }
    const entry = nativeCliAgent(profile.protocol.family)!;
    const binding: NativeCliWorkerBinding = { schemaVersion: 1, connectionId: '12345678-1234-4234-8234-123456789abc', protocolFamily: profile.protocol.family,
      profileDigest: modelInvocationProfileDigest(profile), definition: profile.adapter.definition as NativeCliWorkerBinding['definition'], resourceKey: resource.resourceKey };
    const template = createNativeCodingTemplate({ imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1,
      logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 },
    { provider: entry.id, cliVersion: '9.0.0', discovery: { schemaVersion: 1, mode: 'disabled' }, permissionMode: 'unattended' }, binding);
    const work = { schemaVersion: 1, task: 'Record the business result.', scope: { paths: ['result.txt'] }, acceptance: 'The result has a durable receipt.',
      model: { channelId: profile.reference.providerId, modelId: 'vendor/model', auxiliaryModelIds: [] } }, compiled = compileNativeCodingWorkInput(template, work);
    const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'custom', dependencies: [], acceptanceCriteria: ['criterion'] }],
      criterionDefinitions: [{ id: 'criterion', version: 1, description: 'Evidence', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
    // R9: an assigned model runs on the same login's connected profile for it; another login or an undeclared model has none.
    const model = { channelId: profile.reference.providerId, modelId: 'vendor/model' };
    expect(await connectedModelProfile(context.config, 's', binding, model)).toEqual({ profileDigest: binding.profileDigest, definition: binding.definition });
    // Same login, another profile's own state dir: still that login's profile; another login dir or an undeclared model: none.
    expect(await connectedModelProfile(context.config, 's', { ...binding, definition: { ...binding.definition, stateDir: '/synthetic/other-state' } }, model)).toMatchObject({ profileDigest: binding.profileDigest });
    expect(await connectedModelProfile(context.config, 's', binding, { ...model, modelId: 'vendor/other' })).toBeNull();
    expect(await connectedModelProfile(context.config, 's', { ...binding, definition: { ...binding.definition, configDir: '/other/login' } }, model)).toBeNull();
    const admission = nativeWorkerAdmission(f.project, 's', f.options);
    const execution = await admission.modelUse.pin({ ...fixtureExecution(graph), tasks: [{ taskId: 't', profile: compiled }] }, context.principal);
    // X4: the run owner check is the strict principal compare; the same issuer and subject with another id or assurance is not the owner.
    for (const other of [{ ...context.principal, id: 'other' }, { ...context.principal, assurance: 'token-verified' as const }])
      await expect(admission.modelUse.pin({ ...fixtureExecution(graph), tasks: [{ taskId: 't', profile: compiled }] }, other)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_CHANGED' });
    const frozen = resolveNativeCliWorkerProfile(execution.tasks[0]!.profile).binding;
    expect(frozen.modelUsePin?.principal).toMatchObject({ issuer: `${owner.issuer}/mcp`, assurance: 'workload-verified' });
    expect(await admission.resources(execution)).toEqual([{ taskId: 't', resourceKey: resource.resourceKey }]);
    const identity = { scopeId: 's', runId: 'run', taskId: 't', attemptId: 'attempt', generation: 1, layoutRevision: context.layout.revision };
    const run = { state: { kind: 'running' }, cancelRequested: false, bindings: [{ identity }], progress: [{ taskId: 't', phase: 'active' }], execution };
    const resourceState = { bindings: [{ taskId: 't', resourceKey: resource.resourceKey }], resources: [{ ...resource, occupancy: { execution: 1, inFlight: 1 } }] };
    const store = { loadRun: vi.fn(async () => run), load: vi.fn(async () => ({ identity, cancelRequested: false })), loadBoundDispatch: vi.fn(async () => null),
      loadRunReceipt: vi.fn(async () => null), loadRunResourceCapacity: vi.fn(async () => resourceState) };
    const seal = { schemaVersion: 1 as const, capability: 'NativeAgentExecution' as const, executable: process.execPath, cliVersion: '9.0.0', ownerUid: process.getuid!(),
      profileDigest: binding.profileDigest, flagSetDigest: nativeAgentFlagSetDigest(entry) };
    const tools = { session: { schemaVersion: 1 as const, turnId: 'turn', generation: 1, approvalTtlMs: 1000, tools: [] },
      propose: vi.fn(), cancel: vi.fn(), revoke: vi.fn() };
    const runtime: NativeCliWorkerRuntime = { readiness: { read: vi.fn(async () => ({ cli: true, login: true, environment: true, plugins: true, toolSurface: true, bridge: true, execution: seal })) },
      prepare: vi.fn(async () => null), f08: vi.fn(async () => seal), openTools: vi.fn(async request => { expect(localPrincipalChannel()).toBe('mcp'); expect(request.workspace).toBe('/synthetic/attempt/workspace'); return tools; }),
      driver: vi.fn(), bridgeLimits: { idleMs: 1000, maxConnections: 2, replayMaxEntries: 2, replayMaxBytes: entry.bridge.frameMaxBytes * 2 } };
    const ports = createConfiguredNativeCliWorkerPorts(f.project, 's', store as never, f.options, runtime), signal = new AbortController().signal;
    const request = { protocolVersion: 1 as const, identity, workspace: '/synthetic/attempt/workspace', argv: resolveNativeCliWorkerProfile(execution.tasks[0]!.profile).argv };
    expect(await ports.readiness(frozen)).toEqual({ state: 'ready', execution: seal }); expect(await ports.f08(frozen)).toEqual(seal);
    // KG6 F1/F2: the production readiness point reads the observation once and its F08 reuses that seal and the point's K5 resolution.
    const reads = vi.mocked(runtime.readiness.read).mock.calls.length;
    expect(await inspectNativeCliWorker(frozen, ports)).toEqual({ state: 'ready', execution: seal }); expect(runtime.readiness.read).toHaveBeenCalledTimes(reads + 1);
    expect(runtime.f08).toHaveBeenLastCalledWith(expect.objectContaining({ execution: seal, use: expect.objectContaining({ pin: frozen.modelUsePin }) }));
    expect(await ports.prepare!(frozen)).toBeNull(); expect(runtime.prepare).toHaveBeenCalledWith(profile);
    await ports.recheck(request, frozen, signal);
    const slot = await ports.capacity.acquire(request, frozen, signal); expect(slot.state).toBe('acquired');
    await ports.openTools(request, frozen, signal, { inputs: [] }); expect(runtime.openTools).toHaveBeenCalledOnce();
    if (slot.state === 'acquired') await slot.release();
    resourceState.resources[0]!.occupancy.execution = resource.capacity.executionSlots + 1;
    expect(await ports.capacity.acquire(request, frozen, signal)).toEqual({ state: 'waiting' });
    // Preserve the pinned principal/profile/company snapshot; changing it never silently repins it.
    await expect(ports.recheck(request, { ...frozen, modelUsePin: { ...frozen.modelUsePin, companyId: 'other' } }, signal)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_CHANGED' });
    await expect(ports.prepare!({ ...frozen, modelUsePin: { ...frozen.modelUsePin, companyId: 'other' } })).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_CHANGED' });
    // Withdrawing the MCP actor's v19 model rule (what `policy upgrade --rollback` removes) stops every later spawn and tool session.
    policy.grants = policy.grants.filter(row => row.id !== FIRST_RUN_UPGRADE_RULE_IDS.mcpModelInvocation);
    await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 }); clearConfigCache();
    await expect(ports.openTools(request, frozen, signal, {})).rejects.toBeTruthy(); expect(runtime.openTools).toHaveBeenCalledOnce(); expect(runtime.driver).not.toHaveBeenCalled();
    await expect(ports.prepare!(frozen)).rejects.toBeTruthy(); expect(runtime.prepare).toHaveBeenCalledOnce();
    // KG6 OQ1: the guard that passed before the change and the execute recheck after it each read a fresh snapshot, as does every readiness point.
    for (const point of [() => ports.recheck(request, frozen, signal), () => recheckNativeWorkerUse(f.project, 's', frozen, f.options), () => ports.readiness(frozen), () => ports.readinessPoint!(frozen), () => ports.f08(frozen)])
      await expect(point()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const check = new DatabaseSync(f.path, { readOnly: true });
    try { expect(check.prepare('SELECT count(*) AS n FROM model_invocations').get()).toEqual({ n: 0 }); } finally { check.close(); }
    expect(f.posts).toBe(0);
  } finally { await f.close(); }
});

it('K17: reserved native task reaches retained dispatch output without Docker probes or host credential projection', async () => {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir, hostname, userInfo } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const { openConfiguredAttemptStore } = await import('../support/configured-open.js');
  const { executeConfiguredTask } = await import('#composition/core/execution/index.js');
  const nativeConnection = await import('#adapters/core/native-connection/index.js');
  const { recordedNativeCliWorkerSupervisor } = await import('#adapters/core/native-cli-worker/index.js');
  const root = await mkdtemp(join(tmpdir(), 'native-task-dispatch-')), project = join(root, 'project'), data = join(root, 'data');
  const credential = vi.spyOn(nativeConnection, 'readLocalNativeCredential');
  try {
    await mkdir(join(project, '.deckent'), { recursive: true });
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(project, 'note.txt'), 'fixed base\n'); git('add', 'note.txt'); git('commit', '-m', 'fixture');
    const limits = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2,
      tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, execution: {
      docker: { ...limits, executable: '/unavailable/docker' }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
    const options = { env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'global') } };
    const opened = await openConfiguredAttemptStore(project, options), store = opened.store;
    try {
      const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
      await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'native-fixture', restrictions: [], grants: [
        { id: 'attempt', effect: 'allow', principals, scopes: ['s'], actions: ['execute', 'read-output', 'reconcile'], resource: { kind: 'attempt', ids: 'all' } },
        { id: 'run', effect: 'allow', principals, scopes: ['s'], actions: ['inspect', 'cancel'], resource: { kind: 'run', ids: 'all' } },
      ] }), { mode: 0o600 }); clearConfigCache();
      const entry = nativeCliAgent('claude-code-stream-json')!, identity = { scopeId: 's', runId: 'run', taskId: 't', attemptId: 'attempt', generation: 1, layoutRevision: opened.layout.revision };
      const bound: NativeCliWorkerBinding = { schemaVersion: 1, connectionId: '12345678-1234-4234-8234-123456789abc', resourceKey: 'synthetic-resource',
        protocolFamily: 'claude-code-stream-json', profileDigest: 'b'.repeat(64), definition: { schemaVersion: 1, executable: '/synthetic/cli', configDir: '/synthetic/login', stateDir: '/synthetic/state', ownerUid: userInfo().uid,
          minCliVersion: '9.0.0', delegatedUse: null } };
      const environment = { schemaVersion: 1, requirements: [{ id: 'native-tool', kind: 'executable', target: 'node' }] };
      const compiled = compileNativeCodingWorkInput(createNativeCodingTemplate({ ...limits, environment }, {
        provider: entry.id, cliVersion: '9.0.0', discovery: { schemaVersion: 1, mode: 'disabled' }, permissionMode: 'unattended' }, bound),
      { schemaVersion: 1, task: 'Read the fixed note.', scope: { paths: ['note.txt'] }, acceptance: 'A retained answer exists.', model: { channelId: 'fixture', modelId: 'exact-model', auxiliaryModelIds: [] } });
      const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['criterion'] }],
        criterionDefinitions: [{ id: 'criterion', version: 1, description: 'Evidence', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
      const actor = { id: 'fixture', issuer: hostname(), subject: String(userInfo().uid) };
      await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 } });
      await store.createRun({ commandId: 'create', actor, identity: { scopeId: 's', runId: 'run', layoutRevision: identity.layoutRevision }, graph,
        execution: { ...fixtureExecution(graph), tasks: [{ taskId: 't', profile: compiled }] }, now: 0,
        policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } });
      await store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 's', runId: 'run', expectedRevision: 0, now: 0, identities: [identity] });
      const seal = { schemaVersion: 1 as const, capability: 'NativeAgentExecution' as const, executable: bound.definition.executable, cliVersion: '9.0.0', ownerUid: userInfo().uid,
        profileDigest: bound.profileDigest, flagSetDigest: nativeAgentFlagSetDigest(entry) };
      const run = vi.fn(async () => ({ termination: 'confirmed' as const, status: 'completed' as const, text: JSON.stringify({ schemaVersion: 1, summary: 'fixed note read', changedFiles: [], checks: [], openIssues: [] }) }));
      const release = vi.fn(async () => undefined), session = { schemaVersion: 1 as const, turnId: 'worker', generation: 1, approvalTtlMs: 1000, tools: [] };
      const ports = { readiness: async () => ({ state: 'ready' as const, execution: seal }), f08: async () => seal, recheck: async () => undefined,
        capacity: { acquire: async () => ({ state: 'acquired' as const, release }) },
        checkEnvironment: vi.fn(async (request, _binding, requirements) => {
          expect(await readFile(join(request.workspace, 'note.txt'), 'utf8')).toBe('fixed base\n'); expect(requirements).toEqual(environment);
        }),
        openTools: vi.fn(async (request, _binding, _signal, context) => {
          expect(await readFile(join(request.workspace, 'note.txt'), 'utf8')).toBe('fixed base\n'); expect(context).toEqual({});
          return { session, propose: vi.fn(), revoke: vi.fn(), cancel: async () => ({ kind: 'cancelled' as const, turnId: session.turnId, generation: session.generation,
            termination: 'unverified' as const, effects: 'settled' as const, pendingCallIds: [] }) };
        }), driver: vi.fn(async input => { expect(input).not.toHaveProperty('workspace'); return { tools: input.tools, run, close: async () => undefined }; }),
        bridgeLimits: { idleMs: 1000, maxConnections: 2, replayMaxEntries: 2, replayMaxBytes: entry.bridge.frameMaxBytes * 2 } };
      const result = await executeConfiguredTask(project, identity, { ...options, nativeCliWorker: { ports, projectionRetired: false } });
      expect(result.execution).toMatchObject({ status: 'terminal', outputRecorded: true, terminal: { exitCode: 0 } });
      const dispatch = await store.loadBoundDispatch(identity); expect(dispatch?.profile.adapterId).toBe('native-cli-worker'); expect(dispatch?.containerId).toBeUndefined();
      expect(await store.loadWorkerEventLog('s', 'attempt')).toMatchObject({ eventCount: 1 });
      const restored = recordedNativeCliWorkerSupervisor(dispatch!.profile);
      expect(await restored.recoverOutput(dispatch!.request)).toMatchObject({ completeness: 'partial', stdout: expect.stringContaining('fixed note read') });
      await executeConfiguredTask(project, identity, { ...options, nativeCliWorker: { ports, projectionRetired: true } });
      expect(run).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce(); expect(ports.checkEnvironment).toHaveBeenCalledOnce(); expect(credential).not.toHaveBeenCalled();
      await store.cancelRun({ commandId: 'cancel-finished', actor, scopeId: 's', runId: 'run', expectedRevision: (await store.loadRun('s', 'run'))!.revision });
      await store.settleCancelledAttempt(identity);
      const heldIdentity = { ...identity, runId: 'held', attemptId: 'held-attempt' };
      await store.createRun({ commandId: 'create-held', actor, identity: { scopeId: 's', runId: 'held', layoutRevision: identity.layoutRevision }, graph,
        execution: { ...fixtureExecution(graph), tasks: [{ taskId: 't', profile: compiled }] }, now: 0,
        policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } });
      await store.reserveRunTasks({ commandId: 'reserve-held', actor, scopeId: 's', runId: 'held', expectedRevision: 0, now: 0, identities: [heldIdentity] });
      run.mockResolvedValue({ termination: 'confirmed', status: 'failed', text: '', refusal: 'NATIVE_AGENT_PLUGIN_UNEXPECTED' });
      const held = await executeConfiguredTask(project, heldIdentity, { ...options, nativeCliWorker: { ports, projectionRetired: true } });
      expect(held.execution).toMatchObject({ status: 'unresolved', outputRecorded: false, waiting: { reason: 'NATIVE_AGENT_PLUGIN_UNEXPECTED', legacy: false } });
      expect((await store.loadRun('s', 'held'))?.state.kind).toBe('parked');
      expect(release).toHaveBeenCalledOnce(); expect(credential).not.toHaveBeenCalled();
    } finally { store.close(); }
  } finally { credential.mockRestore(); await rm(root, { recursive: true, force: true }); clearConfigCache(); }
});
