import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { brainProviderFixture } from '../support/brain-provider.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { nativeWorkerAdmission, createConfiguredNativeCliWorkerPorts, type NativeCliWorkerRuntime } from '#composition/core/execution/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { applyConfiguredRunLifecycle, recheckNativeWorkerUse } from '#composition/core/runs/index.js';
import * as adapterExports from '#adapters/index.js';
import { createNativeCodingTemplate, compileNativeCodingWorkInput, nativeCliAgent, nativeAgentFlagSetDigest,
  resolveNativeCliWorkerProfile, inspectNativeCliWorker, readLocalOsIdentity, localPrincipalChannel, type NativeCliWorkerBinding, type NativeCliWorkerPorts } from '#adapters/index.js';
import { openSqliteLedgerReadOnly, findCapacityResource } from '#adapters/core/sqlite-ledger/index.js';
import { headlessCapacityBinding } from '#adapters/core/sqlite-model-invocation/index.js';
import { FIRST_RUN_TOOL_NAMES, modelInvocationProfileDigest, connectedModelProfile } from '#engine/index.js';
import { FIRST_RUN_UPGRADE_RULE_IDS, firstRunPolicyTemplate, modelInvocationProfileSchema } from '#domain/index.js';
import { clearConfigCache, ErrorRegistry, productResourcePath } from '#platform/index.js';

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
    const ceiling = { mode: 'standart', askEdits: true } as const;
    const execution = await admission.modelUse.pin({ ...fixtureExecution(graph), tasks: [{ taskId: 't', profile: compiled }] }, context.principal, ceiling);
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
    expect(runtime.openTools).toHaveBeenLastCalledWith(request, frozen, signal, { inputs: [] }, ceiling);
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
  const { main } = await import('#surfaces/index.js');
  const nativeConnection = await import('#adapters/core/native-connection/index.js');
  const { recordedNativeCliWorkerSupervisor, nativeWorkerCustodyFile, readRecordedNativeWorkerResult } = await import('#adapters/core/native-cli-worker/index.js');
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
        { id: 'run', effect: 'allow', principals, scopes: ['s'], actions: ['inspect', 'cancel', 'reserve'], resource: { kind: 'run', ids: 'all' } },
        { id: 'resume', effect: 'allow', principals, scopes: ['s'], actions: ['resume'], resource: { kind: 'run-decision', ids: 'all' } },
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
      // N0: the worker reports its start and one count-only observation with the provider's first overage fact; release must follow the seal.
      const observation = { schemaVersion: 1, cliVersion: '9.0.0', builtinPlugins: { names: [], omitted: 3 }, paidExtraUsage: { kind: 'overage', status: 'allowed', window: 'five_hour', resetsAtMs: null } } as const;
      const reported = [{ schemaVersion: 1, sequence: 1, atMs: 1, kind: 'session.started', provider: 'claude', model: 'exact-model', cliVersion: '9.0.0' },
        { schemaVersion: 1, sequence: 2, atMs: 2, kind: 'cli.observation', observation }] as const, sealedAtRelease: boolean[] = []; let report = true;
      const release = vi.fn(async () => { sealedAtRelease.push(!!await store.loadWorkerEventLog('s', 'attempt')); }), session = { schemaVersion: 1 as const, turnId: 'worker', generation: 1, approvalTtlMs: 1000, tools: [] };
      const ports = { readiness: async () => ({ state: 'ready' as const, execution: seal }), f08: async () => seal, recheck: async () => undefined,
        capacity: { acquire: async () => ({ state: 'acquired' as const, release }) },
        checkEnvironment: vi.fn<NonNullable<NativeCliWorkerPorts['checkEnvironment']>>(async (request, _binding, requirements) => {
          expect(await readFile(join(request.workspace, 'note.txt'), 'utf8')).toBe('fixed base\n'); expect(requirements).toEqual(environment);
        }),
        openTools: vi.fn(async (request, _binding, _signal, context) => {
          expect(await readFile(join(request.workspace, 'note.txt'), 'utf8')).toBe('fixed base\n'); expect(context).toEqual({});
          return { session, propose: vi.fn(), revoke: vi.fn(), cancel: async () => ({ kind: 'cancelled' as const, turnId: session.turnId, generation: session.generation,
            termination: 'unverified' as const, effects: 'settled' as const, pendingCallIds: [] }) };
        }), driver: vi.fn(async input => { expect(input).not.toHaveProperty('workspace'); return { tools: input.tools, run: (...args: Parameters<typeof run>) => { if (report) input.onEvents?.(reported); return run(...args); }, close: async () => undefined }; }),
        bridgeLimits: { idleMs: 1000, maxConnections: 2, replayMaxEntries: 2, replayMaxBytes: entry.bridge.frameMaxBytes * 2 } };
      const result = await executeConfiguredTask(project, identity, { ...options, nativeCliWorker: { ports, projectionRetired: false } });
      expect(result.execution).toMatchObject({ status: 'terminal', outputRecorded: true, terminal: { exitCode: 0 } });
      const dispatch = await store.loadBoundDispatch(identity); expect(dispatch?.profile.adapterId).toBe('native-cli-worker'); expect(dispatch?.containerId).toBeUndefined();
      expect(await store.loadWorkerEventLog('s', 'attempt')).toMatchObject({ eventCount: 3 }); expect(result.execution).not.toHaveProperty('eventLog'); expect(sealedAtRelease).toEqual([true]);
      const { inspectConfiguredWorkerTranscript } = await import('../../../src/index.js'), sealed = await inspectConfiguredWorkerTranscript(project, identity, options);
      expect(sealed.events.filter(event => event.kind === 'cli.observation')).toEqual([{ ...reported[1], sequence: 3, atMs: 2 }]);
      const restored = recordedNativeCliWorkerSupervisor(dispatch!.profile);
      expect(await restored.recoverOutput(dispatch!.request)).toMatchObject({ completeness: 'partial', stdout: expect.stringContaining('fixed note read') });
      await executeConfiguredTask(project, identity, { ...options, nativeCliWorker: { ports, projectionRetired: true } });
      expect(run).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce(); expect(ports.checkEnvironment).toHaveBeenCalledOnce(); expect(credential).not.toHaveBeenCalled();
      await store.cancelRun({ commandId: 'cancel-finished', actor, scopeId: 's', runId: 'run', expectedRevision: (await store.loadRun('s', 'run'))!.revision });
      await store.settleCancelledAttempt(identity);
      for (const cause of ['run-cancel', 'service-stop', 'service-stop-unknown']) {
        const probing = { ...identity, runId: cause, attemptId: cause }, stop = new AbortController();
        await store.createRun({ commandId: `create-${cause}`, actor, identity: { scopeId: 's', runId: cause, layoutRevision: identity.layoutRevision }, graph,
          execution: { ...fixtureExecution(graph), tasks: [{ taskId: 't', profile: compiled }] }, now: 0,
          policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } });
        await store.reserveRunTasks({ commandId: `reserve-${cause}`, actor, scopeId: 's', runId: cause, expectedRevision: 0, now: 0, identities: [probing] });
        let started!: () => void, finish!: () => void, probeSignal!: AbortSignal, probeWorkspace!: string;
        const entered = new Promise<void>(resolve => { started = resolve; });
        ports.checkEnvironment.mockImplementationOnce(async (request, _binding, _requirements, _resources, signal) => {
          probeSignal = signal; probeWorkspace = request.workspace; started();
          await new Promise<void>(resolve => { finish = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
          if (cause === 'service-stop-unknown') throw ErrorRegistry.createError('NATIVE_WORKER_CUSTODY_UNKNOWN');
        });
        const pending = executeConfiguredTask(project, probing, { ...options, nativeCliWorker: { ports, projectionRetired: true } }, stop.signal);
        const outcome = pending.then(result => ({ result }), (error: unknown) => ({ error }));
        await entered;
        try {
          if (cause === 'run-cancel') await store.cancelRun({ commandId: `cancel-${cause}`, actor, scopeId: 's', runId: cause, expectedRevision: (await store.loadRun('s', cause))!.revision });
          else stop.abort();
          await vi.waitFor(() => expect(probeSignal.aborted).toBe(true), { timeout: 3000 });
        } finally { finish(); }
        expect(await outcome).toMatchObject({ error: { code: cause === 'service-stop-unknown' ? 'NATIVE_WORKER_CUSTODY_UNKNOWN' : 'DISPATCH_FENCED' } });
        if (cause === 'service-stop-unknown') expect(await readFile(join(probeWorkspace, 'note.txt'), 'utf8')).toBe('fixed base\n');
        else await expect(readFile(join(probeWorkspace, 'note.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(join(productResourcePath(opened.layout, 'crashes'), 'dispatch-preparation'))).toHaveLength(cause === 'service-stop-unknown' ? 1 : 0);
        expect(await store.loadBoundDispatch(probing)).toBeNull();
        expect(run).toHaveBeenCalledOnce(); expect(ports.openTools).toHaveBeenCalledOnce();
        if (cause !== 'run-cancel') await store.cancelRun({ commandId: `cancel-${cause}`, actor, scopeId: 's', runId: cause, expectedRevision: (await store.loadRun('s', cause))!.revision });
      }
      // N0: two separate close faults, each through task.ts on its own Attempt: (unheld) an observation offered before the provider's start, healthy sink;
      // (sink) a held observation whose live sink close rejects. Both: terminal exit 0, the failure value (`cause: null`), no sealed log, one spawn, capacity
      // released once and the supervisor closed once. Without the offered flag the first would seal and the second would reject the task.
      const prepare = adapterExports.prepareNativeCliWorker;
      for (const fault of ['unheld', 'sink'] as const) {
        const faulted = { ...identity, runId: fault, attemptId: fault }, settled = vi.fn(async () => undefined), closes = vi.fn();
        await store.createRun({ commandId: `create-${fault}`, actor, identity: { scopeId: 's', runId: fault, layoutRevision: identity.layoutRevision }, graph,
          execution: { ...fixtureExecution(graph), tasks: [{ taskId: 't', profile: compiled }] }, now: 0,
          policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } });
        await store.reserveRunTasks({ commandId: `reserve-${fault}`, actor, scopeId: 's', runId: fault, expectedRevision: 0, now: 0, identities: [faulted] });
        const once = vi.fn(async () => ({ termination: 'confirmed' as const, status: 'completed' as const, text: JSON.stringify({ schemaVersion: 1, summary: 'fixed note read', changedFiles: [], checks: [], openIssues: [] }) }));
        vi.spyOn(adapterExports, 'prepareNativeCliWorker').mockImplementationOnce(async (...args: Parameters<typeof prepare>) => {
          const ready = await prepare(...args); if (ready.state !== 'ready') return ready;
          const close = ready.supervisor.close.bind(ready.supervisor); ready.supervisor.close = async () => { closes(); return close(); }; return ready; });
        if (fault === 'sink') vi.spyOn(adapterExports, 'openWorkerEventSink').mockResolvedValueOnce({ accept() {}, close: async () => { throw new Error('sink-close-failed'); } } as never);
        const lost = await executeConfiguredTask(project, faulted, { ...options, nativeCliWorker: { projectionRetired: true, ports: { ...ports, capacity: { acquire: async () => ({ state: 'acquired' as const, release: settled }) },
          driver: vi.fn(async input => ({ tools: input.tools, run: () => { for (const row of fault === 'unheld' ? [reported[1], reported[0]] : reported) input.onEvents?.([row]); return once(); },
            close: async () => undefined })) } } });
        expect(lost.execution).toMatchObject({ status: 'terminal', terminal: { exitCode: 0 }, eventLog: { status: 'failed', code: 'WORKER_EVENTS_SEAL_FAILED', cause: null } });
        // N0 R4 (owner D4): the unverifiable record leaves the close owner's failure row, never a sealed log.
        const failureRow = await store.loadWorkerEventLog('s', fault);
        expect(failureRow).toMatchObject({ identity: faulted, outcome: 'unverified' }); expect(failureRow).not.toHaveProperty('events');
        expect(settled).toHaveBeenCalledOnce(); expect(once).toHaveBeenCalledOnce(); expect(closes).toHaveBeenCalledOnce();
        await store.cancelRun({ commandId: `cancel-${fault}`, actor, scopeId: 's', runId: fault, expectedRevision: (await store.loadRun('s', fault))!.revision });
        await store.settleCancelledAttempt(faulted);
      }
      // N0 R4-R6 (owner D5): an invocation after which the same Attempt can still be dispatched (here: login capacity busy, the Run parks) seals neither
      // a verdict-only nor a failure row; the parked Run is resumed by command (no wait) and the same Attempt's real start and close then seal ITS log.
      const artifactReader = adapterExports.FileArtifactStore.reader(async () => productResourcePath(opened.layout, 'artifacts'), 65536);
      const reserveRun = async (runId: string, poolId = 'pool') => {
        await store.createRun({ commandId: `create-${runId}`, actor, identity: { scopeId: 's', runId, layoutRevision: identity.layoutRevision }, graph,
          execution: { ...fixtureExecution(graph), tasks: [{ taskId: 't', profile: compiled }] }, now: 0,
          policy: { schemaVersion: 2, poolId, capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } });
        const reserved = { ...identity, runId, attemptId: runId };
        await store.reserveRunTasks({ commandId: `reserve-${runId}`, actor, scopeId: 's', runId, expectedRevision: 0, now: 0, identities: [reserved] }); return reserved;
      };
      const finish = async (done: typeof identity) => {
        await store.cancelRun({ commandId: `cancel-${done.runId}`, actor, scopeId: 's', runId: done.runId, expectedRevision: (await store.loadRun('s', done.runId))!.revision });
        await store.settleCancelledAttempt(done);
      };
      const own = (run: () => Promise<{ termination: 'confirmed'; status: 'completed' | 'cancelled'; text: string }>, rows: readonly (typeof reported)[number][] = []) => ({ ...ports,
        capacity: { acquire: async () => ({ state: 'acquired' as const, release: async () => undefined }) },
        driver: vi.fn(async (input: Parameters<NativeCliWorkerPorts['driver']>[0]) => ({ tools: input.tools, run: () => { for (const row of rows) input.onEvents?.([row]); return run(); }, close: async () => undefined })) });
      const waited = await reserveRun('waited'), done = JSON.stringify({ schemaVersion: 1, summary: 'fixed note read', changedFiles: [], checks: [], openIssues: [] });
      const busy = await executeConfiguredTask(project, waited, { ...options, nativeCliWorker: { projectionRetired: true,
        ports: { ...ports, capacity: { acquire: async () => ({ state: 'busy' }) as never } } } });
      expect(busy.execution).toMatchObject({ status: 'unresolved', waiting: { reason: 'NATIVE_WORKER_CAPACITY_WAIT' } });
      expect(await store.loadWorkerEventLog('s', 'waited')).toBeNull();
      const parkedWaited = (await store.loadRun('s', 'waited'))!; expect(parkedWaited.state.kind).toBe('parked');
      await applyConfiguredRunLifecycle(project, { schemaVersion: 1, scopeId: 's', runId: 'waited', commandId: 'resume-waited', action: 'resume', expectedRevision: parkedWaited.revision }, options);
      const resumed = await executeConfiguredTask(project, waited, { ...options, nativeCliWorker: { projectionRetired: true,
        ports: own(async () => ({ termination: 'confirmed' as const, status: 'completed' as const, text: done }), [reported[0]]) } });
      expect(resumed.execution).toMatchObject({ status: 'terminal', terminal: { exitCode: 0 } });
      const waitedRow = (await store.loadWorkerEventLog('s', 'waited'))!; expect(waitedRow).toMatchObject({ identity: waited, eventCount: 2 });
      // What custody reads (custody.ts `unsealed`): the Attempt's own sealed stream, read back.
      expect((await store.loadSealedWorkerEvents(waitedRow.identity, artifactReader))?.map(event => event.kind)).toEqual(['session.started', 'model.verification']);
      await finish(waited);
      // N0 R7 (owner D4+D5, a declared cost): capacity wait -> resume of the same Attempt -> terminal end whose offered observation cannot be verified (it
      // precedes the provider's start). HEAD's wait had sealed a readable verdict-only row first, so custody's log check passed; now the wait writes
      // nothing and the close owner's failure row is the first: custody reads no sealed log (custody.ts `unsealed`) and holds `events-unsealed`.
      // Accepted scope of this hold: any Attempt for which HEAD had the early readable row and whose real run leaves NO readable seal: this failed offered
      // seal; an offer-less terminal end whose `supervisor.close()` fails before the seal (pinned with the clean-up case below); and the inner race where at
      // HEAD the loser's verdict-only row had taken the first slot and the winner's seal then fails (rests on reading: task.ts:280, worker-events.ts:17).
      const rewaited = await reserveRun('rewaited');
      expect((await executeConfiguredTask(project, rewaited, { ...options, nativeCliWorker: { projectionRetired: true,
        ports: { ...ports, capacity: { acquire: async () => ({ state: 'busy' }) as never } } } })).execution).toMatchObject({ status: 'unresolved', waiting: { reason: 'NATIVE_WORKER_CAPACITY_WAIT' } });
      expect(await store.loadWorkerEventLog('s', 'rewaited')).toBeNull();
      await applyConfiguredRunLifecycle(project, { schemaVersion: 1, scopeId: 's', runId: 'rewaited', commandId: 'resume-rewaited', action: 'resume',
        expectedRevision: (await store.loadRun('s', 'rewaited'))!.revision }, options);
      const unverifiedEnd = await executeConfiguredTask(project, rewaited, { ...options, nativeCliWorker: { projectionRetired: true,
        ports: own(async () => ({ termination: 'confirmed' as const, status: 'completed' as const, text: done }), [reported[1], reported[0]]) } });
      expect(unverifiedEnd.execution).toMatchObject({ status: 'terminal', terminal: { exitCode: 0 }, eventLog: { status: 'failed', code: 'WORKER_EVENTS_SEAL_FAILED' } });
      const rewaitedRow = (await store.loadWorkerEventLog('s', 'rewaited'))!;
      expect(rewaitedRow).toMatchObject({ identity: rewaited, outcome: 'unverified' }); expect(await store.loadSealedWorkerEvents(rewaitedRow.identity, artifactReader)).toBeNull();
      await finish(rewaited);
      // N0 R6 (owner D5): a cancel during the driver's preflight (before any process) is terminal for the Attempt (its claim never launches again), so it
      // seals what HEAD sealed: the host verdict alone. Custody reads it as sealed (custody.ts `unsealed` is false): releasable as at HEAD.
      // The fake returns exactly what the real driver returns for a preflight cancel (driver.ts:52) and reports no event.
      const unstarted = await reserveRun('unstarted');
      const settledQuiet = await executeConfiguredTask(project, unstarted, { ...options, nativeCliWorker: { projectionRetired: true,
        ports: own(async () => ({ termination: 'confirmed' as const, status: 'cancelled' as const, text: '' })) } });
      expect(settledQuiet.execution).toMatchObject({ status: 'terminal', terminal: { exitCode: 1 } });
      const unstartedRow = (await store.loadWorkerEventLog('s', 'unstarted'))!; expect(unstartedRow).toMatchObject({ identity: unstarted, eventCount: 1, events: expect.any(Object) });
      expect((await store.loadSealedWorkerEvents(unstartedRow.identity, artifactReader))?.map(event => event.kind)).toEqual(['model.verification']);
      await finish(unstarted);
      // N0 R5: a rejecting earlier clean-up (the supervisor's close) still closes the opened sink; the caller keeps that same rejection and no row is written.
      // N0 R8 (the hold's scope above): this Attempt first waited for capacity and was resumed, so at HEAD its wait had left a readable row; now its
      // terminal, offer-less end whose close fails before the seal leaves no readable seal at all.
      const cleanup = await reserveRun('cleanup'), sinkClose = vi.fn(async () => ({ events: [], projectionComplete: true }));
      expect((await executeConfiguredTask(project, cleanup, { ...options, nativeCliWorker: { projectionRetired: true,
        ports: { ...ports, capacity: { acquire: async () => ({ state: 'busy' }) as never } } } })).execution).toMatchObject({ waiting: { reason: 'NATIVE_WORKER_CAPACITY_WAIT' } });
      await applyConfiguredRunLifecycle(project, { schemaVersion: 1, scopeId: 's', runId: 'cleanup', commandId: 'resume-cleanup', action: 'resume',
        expectedRevision: (await store.loadRun('s', 'cleanup'))!.revision }, options);
      vi.spyOn(adapterExports, 'prepareNativeCliWorker').mockImplementationOnce(async (...args: Parameters<typeof prepare>) => {
        const ready = await prepare(...args); if (ready.state !== 'ready') return ready;
        ready.supervisor.close = async () => { throw ErrorRegistry.createError('NATIVE_WORKER_CUSTODY_UNKNOWN'); }; return ready; });
      vi.spyOn(adapterExports, 'openWorkerEventSink').mockResolvedValueOnce({ accept() {}, close: sinkClose } as never);
      await expect(executeConfiguredTask(project, cleanup, { ...options, nativeCliWorker: { projectionRetired: true,
        ports: own(async () => ({ termination: 'confirmed' as const, status: 'completed' as const, text: done }), [reported[0]]) } })).rejects.toMatchObject({ code: 'NATIVE_WORKER_CUSTODY_UNKNOWN' });
      expect(sinkClose).toHaveBeenCalledOnce(); expect(await store.loadWorkerEventLog('s', 'cleanup')).toBeNull();
      expect((await store.loadBoundDispatch(cleanup))?.terminal).toMatchObject({ exitCode: 0 });
      await finish(cleanup);
      const heldIdentity = { ...identity, runId: 'held', attemptId: 'held-attempt' };
      await store.createRun({ commandId: 'create-held', actor, identity: { scopeId: 's', runId: 'held', layoutRevision: identity.layoutRevision }, graph,
        execution: { ...fixtureExecution(graph), tasks: [{ taskId: 't', profile: compiled }] }, now: 0,
        policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } });
      await store.reserveRunTasks({ commandId: 'reserve-held', actor, scopeId: 's', runId: 'held', expectedRevision: 0, now: 0, identities: [heldIdentity] });
      run.mockResolvedValue({ termination: 'confirmed', status: 'failed', text: '', refusal: 'NATIVE_AGENT_PLUGIN_UNEXPECTED' }); report = false;
      const held = await executeConfiguredTask(project, heldIdentity, { ...options, nativeCliWorker: { ports, projectionRetired: true } });
      expect(held.execution).toMatchObject({ status: 'unresolved', outputRecorded: false, waiting: { reason: 'NATIVE_AGENT_PLUGIN_UNEXPECTED', legacy: false } });
      // R2 M4: a worker that reported nothing still seals the host verdict alone (the no-emitted-events, verdict-only log).
      expect(await store.loadWorkerEventLog('s', 'held-attempt')).toMatchObject({ eventCount: 1 });
      expect((await store.loadRun('s', 'held'))?.state.kind).toBe('parked');
      const request = ['task', 'execute', '--scope', 's', '--run', heldIdentity.runId, '--task', heldIdentity.taskId,
        '--attempt', heldIdentity.attemptId, '--generation', String(heldIdentity.generation), '--layout-revision', heldIdentity.layoutRevision, '--lang', 'en'];
      let text = '';
      const context = { root: project, env: options.env, stdout: { write(value: string) { text += value; } },
        executeTask: (root: string, input: typeof heldIdentity) => executeConfiguredTask(root, input, { ...options, nativeCliWorker: { ports, projectionRetired: true } }) };
      expect(await main([...request, '--json'], context)).toBe(0);
      expect.soft(JSON.parse(text).execution).toEqual(held.execution);
      text = '';
      expect(await main(request, context)).toBe(0);
      expect.soft(text).toContain('The record contains the error code NATIVE_AGENT_PLUGIN_UNEXPECTED. The specific cause could not be determined.');
      const heldDispatch = (await store.loadBoundDispatch(heldIdentity))!;
      expect(heldDispatch.terminal).toBeNull();
      const heldRun = await store.loadRun('s', 'held');
      const custody = nativeWorkerCustodyFile(heldDispatch.request);
      const saved = await custody.read();
      if (saved.kind !== 'ready') throw new Error('fixture-missing-custody');
      const savedRecord = saved.value as { result: { handle: string } };
      await custody.write({ ...savedRecord, result: { handle: savedRecord.result.handle, result: { kind: 'exited', exitCode: 1 },
        stdout: '', stderr: '', outputCompleteness: 'complete', interrupted: false } });
      expect(await readRecordedNativeWorkerResult(heldDispatch.profile, heldDispatch.request)).toMatchObject({ result: { kind: 'exited', exitCode: 1 } });
      text = '';
      expect(await main(request, context)).toBe(0);
      expect.soft(text).toContain('This attempt has no final dispatch record, so its outcome is unknown.');
      expect.soft(text).not.toContain('No process exit has been recorded');
      expect(await store.loadBoundDispatch(heldIdentity)).toEqual(heldDispatch);
      expect(await store.loadRun('s', 'held')).toEqual(heldRun);
      // N0 R7 (owner D5): the invocation that acquired the durable claim seals as HEAD did, whatever follows it: a cancel that prevents the launch grant,
      // or a grant that fails after the claim was written. Neither identity is dispatched again (replay) and neither supervisor ran. (Their own pool: their claims keep its slots.)
      const storeType = Object.getPrototypeOf(store) as typeof store, grantLaunch = storeType.grantLaunch, grant = vi.spyOn(storeType, 'grantLaunch');
      await store.createExecutionPool({ schemaVersion: 1, poolId: 'claims', capacity: { executionSlots: 2, inFlightSlots: 2 } });
      const prevented = await reserveRun('prevented', 'claims'), never = async (): Promise<never> => { throw new Error('the supervisor must not run'); };
      grant.mockImplementationOnce(async function (this: typeof store, input) { await this.requestDispatchCancellation(input.claim.request, input.principal); return grantLaunch.call(this, input); });
      expect((await executeConfiguredTask(project, prevented, { ...options, nativeCliWorker: { projectionRetired: true, ports: own(never) } })).execution).toMatchObject({ status: 'prevented' });
      grant.mockRejectedValueOnce(ErrorRegistry.createError('ATTEMPT_STORE_BUSY'));
      const ungranted = await reserveRun('ungranted', 'claims');
      await expect(executeConfiguredTask(project, ungranted, { ...options, nativeCliWorker: { projectionRetired: true, ports: own(never) } })).rejects.toMatchObject({ code: 'ATTEMPT_STORE_BUSY' });
      grant.mockRestore();
      for (const claimed of [prevented, ungranted]) {
        const claimedRow = (await store.loadWorkerEventLog('s', claimed.attemptId))!; expect(claimedRow).toMatchObject({ identity: claimed, eventCount: 1, events: expect.any(Object) });
        expect((await store.loadSealedWorkerEvents(claimedRow.identity, artifactReader))?.map(event => event.kind)).toEqual(['model.verification']);
        expect(await store.loadBoundDispatch(claimed)).not.toBeNull();
      }
      expect(run).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledOnce(); expect(credential).not.toHaveBeenCalled();
    } finally { store.close(); }
  } finally { credential.mockRestore(); await rm(root, { recursive: true, force: true }); clearConfigCache(); }
});
