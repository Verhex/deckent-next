import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as adapters from '#adapters/index.js';
import * as runs from '#composition/core/runs/index.js';
import { createConfiguredNativeCliWorkerRuntime } from '#composition/core/execution/index.js';
import { inspectSubscriptionReadiness } from '#composition/core/subscription-readiness/index.js';
import { FIRST_RUN_TOOL_NAMES, modelInvocationProfileDigest } from '#engine/index.js';
import { firstRunPolicyTemplate } from '#domain/index.js';
import { clearConfigCache } from '#platform/index.js';
import { connection, cleanupConnections } from '../../fixtures/native-headless/connection.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import type { NativeCliWorkerBinding, NativeCliWorkerPorts, NativeCliWorkerTransport, NativeCliWorkerDriver } from '#adapters/index.js';

const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await cleanupConnections(); for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });

it('K27: production environment checks the default native requirements inside state custody and refuses a missing executable before any model', async () => {
  const { nativeAgentRealmAvailable } = await import('../../fixtures/native-headless/agent.js');
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const { mkdir } = await import('node:fs/promises'), { productResourcePath } = await import('#platform/index.js');
  const { loadConfiguredScopeContext } = await import('#composition/core/scoped-request/index.js');
  const f = await brainProviderFixture(), c = await connection();
  try {
    vi.spyOn(runs, 'recheckNativeWorkerUse').mockResolvedValue({ profile: c.profile } as never);
    const model = vi.spyOn(adapters, 'runHeadlessIsolated'), context = await loadConfiguredScopeContext(f.project, 's', f.options, 'read');
    const workspace = join(productResourcePath(context.layout, 'workspaces'), 'native-attempt', 'workspace'); await mkdir(workspace, { recursive: true });
    const runtime = createConfiguredNativeCliWorkerRuntime(f.project, f.options)!, request = { protocolVersion: 1 as const, workspace, argv: [],
      identity: { scopeId: 's', runId: 'environment-run', taskId: 'coding', attemptId: 'environment-attempt', generation: 1, layoutRevision: context.layout.revision } };
    const requirements = { schemaVersion: 1, requirements: [{ id: 'node', kind: 'executable', target: 'node' },
      { id: 'node-heap', kind: 'node-heap', target: 'node', expect: '1610612736' }] };
    await runtime.checkEnvironment!(request, {} as NativeCliWorkerBinding, requirements, {}, new AbortController().signal);
    await expect(runtime.checkEnvironment!(request, {} as NativeCliWorkerBinding, { schemaVersion: 1,
      requirements: [{ id: 'absent-node', kind: 'executable', target: '/missing-k27/node' }] }, {}, new AbortController().signal))
      .rejects.toMatchObject({ code: 'EXECUTION_ENVIRONMENT_NOT_READY' });
    expect(model).not.toHaveBeenCalled(); expect(f.posts).toBe(0);
  } finally { await f.close(); }
});

it('K21: production construction reads worker prerequisites without refreshing them and keeps missing F08 unknown', async () => {
  const preflight = vi.spyOn(adapters, 'preflightNativeAgent'), driver = vi.spyOn(adapters, 'createNativeCliWorkerDriver');
  const runtime = createConfiguredNativeCliWorkerRuntime('/not-an-install', { env: { HOME: '/synthetic/home', DECKENT_GLOBAL_HOME: '/synthetic/global' } })!;
  expect(await inspectSubscriptionReadiness({ surface: 'worker', scopeId: 's', reference: { providerId: 'p', providerVersion: 1, modelId: 'm', modelVersion: 1 },
    profileDigest: 'a'.repeat(64), flagSetDigest: 'b'.repeat(64) }, runtime.readiness)).toEqual({ state: 'unknown', reason: 'NATIVE_AGENT_CLI_UNAVAILABLE' });
  expect(await runtime.f08({ scopeId: 's', reference: { providerId: 'p', providerVersion: 1, modelId: 'm', modelVersion: 1 }, binding: {} as NativeCliWorkerBinding })).toBeNull();
  expect(preflight).not.toHaveBeenCalled(); expect(driver).not.toHaveBeenCalled();
});

it('K21: production driver binds the fresh K5 profile to K16 public transport, retaining all worker bounds', async () => {
  const fixture = await connection(), profile = fixture.profile;
  const binding = { schemaVersion: 1, protocolFamily: profile.protocol.family, profileDigest: modelInvocationProfileDigest(profile), definition: profile.adapter.definition,
    connectionId: '12345678-1234-4234-8234-123456789abc', resourceKey: 'slot', modelUsePin: { scopeId: profile.scopeId } } as NativeCliWorkerBinding;
  const current = vi.spyOn(runs, 'recheckNativeWorkerUse').mockResolvedValue({ profile } as never);
  const driver = { tools: {} as NativeCliWorkerDriver['tools'], run: vi.fn(), close: vi.fn() };
  let transport!: NativeCliWorkerTransport;
  const create = vi.spyOn(adapters, 'createNativeCliWorkerDriver').mockImplementation((_input, ports) => { transport = ports; return driver; });
  const input = { binding, tools: { session: { turnId: 'untrusted:other-scope' } }, model: 'fixture-model', system: 'system', user: 'task', deadlineMs: 5432,
    outputBytes: 4321, maxTurns: 7, execution: {} } as Parameters<NativeCliWorkerPorts['driver']>[0];
  const runtime = createConfiguredNativeCliWorkerRuntime(fixture.root)!, signal = new AbortController().signal;
  expect(await runtime.driver(input, signal)).toBe(driver);
  expect(current).toHaveBeenCalledWith(fixture.root, profile.scopeId, binding, {});
  expect(create).toHaveBeenCalledWith(input, expect.any(Object), signal);
  expect(transport.profile).toBe(profile); expect(transport.claudeDriver).toBe(adapters.createClaudeAgentDriver); expect(transport.claudeRun).toBe(adapters.prepareClaudeAgentRun);
  const preflight = vi.spyOn(adapters, 'preflightNativeAgent').mockResolvedValue({} as never);
  await transport.preflight(signal); expect(preflight).toHaveBeenCalledWith(profile, Date.now, expect.any(Function), signal);
  const isolated = vi.spyOn(adapters, 'runHeadlessIsolated').mockResolvedValue({} as never), entry = adapters.nativeCliAgent(binding.protocolFamily)!;
  const spawn = {} as Parameters<NativeCliWorkerTransport['runIsolated']>[1], bounds = {} as Parameters<NativeCliWorkerTransport['runIsolated']>[2], line = vi.fn();
  await transport.runIsolated(entry, spawn, bounds, signal, line); expect(isolated).toHaveBeenCalledWith(entry, expect.any(Function), spawn, bounds, signal, line);
  await expect(runtime.driver({ ...input, binding: { ...binding, modelUsePin: undefined } } as never, signal)).rejects.toMatchObject({ code: 'DISPATCH_FENCED' });
  expect(create).toHaveBeenCalledOnce();
});

it('K21: K1 tools use the exact Attempt tree with an MCP workload session and durable effects, never the project tree', async () => {
  const f = await brainProviderFixture(), c = await connection(), attempt = await mkdtemp(join(tmpdir(), 'k21-tools-')); temporary.push(attempt);
  let port: Awaited<ReturnType<NativeCliWorkerPorts['openTools']>> | undefined;
  try {
    // R4a: the real first-run template (v19), never injected MCP grants: the worker's tool session runs as the MCP actor on its v19 rules.
    const owner = adapters.readLocalOsIdentity(), firstRun = firstRunPolicyTemplate({ scopeId: 's', principal: { issuer: owner.issuer, subject: owner.subject }, ...FIRST_RUN_TOOL_NAMES });
    await writeFile(join(f.data, 'policy.json'), JSON.stringify(firstRun.policy), { mode: 0o600 }); await writeFile(join(f.data, 'bindings.json'), JSON.stringify(firstRun.bindings), { mode: 0o600 });
    await writeFile(join(attempt, 'note.txt'), 'attempt-only'); clearConfigCache();
    vi.spyOn(runs, 'recheckNativeWorkerUse').mockResolvedValue({ profile: c.profile } as never);
    const runtime = createConfiguredNativeCliWorkerRuntime(f.project, f.options)!;
    const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
    const request = { protocolVersion: 1 as const, identity, workspace: attempt, argv: [] };
    port = await adapters.withMcpPrincipal(() => runtime.openTools(request, {} as NativeCliWorkerBinding, new AbortController().signal, {}));
    const propose = (id: string, name: string, args: object) => adapters.withMcpPrincipal(() => port!.propose({ id, name, argumentsJson: JSON.stringify(args) },
      { kind: 'claude-tool-use', toolUseId: id, deckentCallId: id }, new AbortController().signal));
    expect((await propose('read', 'read_file', { path: 'note.txt' })).outcome).toMatchObject({ status: 'ok', text: expect.stringContaining('attempt-only') });
    expect((await propose('write', 'write_file', { path: 'result.txt', content: 'durable-attempt-result' })).outcome.status).toBe('ok');
    expect(await readFile(join(attempt, 'result.txt'), 'utf8')).toBe('durable-attempt-result');
    await expect(readFile(join(f.project, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await adapters.withMcpPrincipal(() => port!.cancel())).toMatchObject({ effects: 'settled', pendingCallIds: [], termination: 'unverified' });
    expect((await propose('late-write', 'write_file', { path: 'result.txt', content: 'late-overwrite' })).outcome.status).toBe('error');
    expect(await readFile(join(attempt, 'result.txt'), 'utf8')).toBe('durable-attempt-result'); port = undefined;
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(f.path, { readOnly: true });
    try { expect(db.prepare('SELECT count(*) AS n FROM model_invocations').get()).toEqual({ n: 0 }); } finally { db.close(); }
    expect(f.posts).toBe(0);
  } finally { if (port) await adapters.withMcpPrincipal(() => port!.cancel()); await f.close(); }
});

it('K21: configured drivers run both isolated fake CLIs and retain cancellation without a workspace or credential projection', async () => {
  const { nativeAgentRealmAvailable, writeFakeAgentCli } = await import('../../fixtures/native-headless/agent.js');
  const { testIsolation } = await import('../../fixtures/native-headless/connection.js');
  const { modelInvocationProfileSchema } = await import('#domain/index.js');
  const registry = await import('../../../assets/native-coding/commands.json', { with: { type: 'json' } });
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  for (const family of [registry.default.adapters.claude.capabilities.eventStream, registry.default.adapters.codex.headless.protocolFamily]) {
    const c = await connection(), { mkdir } = await import('node:fs/promises'), bin = join(c.root, 'worker-bin'); await mkdir(bin);
    const executable = await writeFakeAgentCli(bin, family!, { answer: 'retained-worker-answer' });
    const profile = modelInvocationProfileSchema.parse({ ...c.profile, protocol: { family, version: 'v1' },
      adapter: { ...c.profile.adapter, definition: { ...c.profile.adapter.definition, executable } } });
    vi.spyOn(runs, 'recheckNativeWorkerUse').mockResolvedValue({ profile } as never);
    const binding = { schemaVersion: 1, protocolFamily: family, profileDigest: modelInvocationProfileDigest(profile), definition: profile.adapter.definition,
      connectionId: '12345678-1234-4234-8234-123456789abc', resourceKey: 'slot', modelUsePin: { scopeId: profile.scopeId } } as NativeCliWorkerBinding;
    const entry = adapters.nativeCliAgent(family!)!, execution = (await adapters.preflightNativeAgent(profile, Date.now, testIsolation)).execution;
    const session = { schemaVersion: 1 as const, turnId: 'isolated-worker', generation: 1, approvalTtlMs: 1000, tools: [] };
    const tools = { session, propose: vi.fn(), cancel: vi.fn(), revoke: vi.fn() };
    const runtime = createConfiguredNativeCliWorkerRuntime(c.root, { env: process.env })!;
    const signal = new AbortController().signal, input = { binding, tools, model: 'fixture-model', system: 'Use governed tools.', user: 'Complete the scoped task.', deadlineMs: 5000,
      outputBytes: 65536, execution };
    const driver = await runtime.driver(input, signal);
    const bridge = await adapters.createNativeToolBridge({ port: driver.tools, bridge: entry.bridge, limits: runtime.bridgeLimits,
      correlationKind: entry.agent.transport.kind === 'claude-mcp' ? 'claude-tool-use' : 'codex-mcp', signal });
    try { expect(await driver.run(bridge, signal)).toMatchObject({ termination: 'confirmed', status: 'completed', text: 'retained-worker-answer' }); }
    finally { await bridge.close(); await driver.close(); }
    await writeFakeAgentCli(bin, family!, { hang: true });
    const cancel = new AbortController(), stopped = await runtime.driver({ ...input, execution: (await adapters.preflightNativeAgent(profile, Date.now, testIsolation)).execution }, cancel.signal);
    const pendingBridge = await adapters.createNativeToolBridge({ port: stopped.tools, bridge: entry.bridge, limits: runtime.bridgeLimits,
      correlationKind: entry.agent.transport.kind === 'claude-mcp' ? 'claude-tool-use' : 'codex-mcp', signal: cancel.signal });
    const timer = setTimeout(() => cancel.abort(), 300);
    try { expect(await stopped.run(pendingBridge, cancel.signal)).toMatchObject({ termination: 'confirmed', status: 'cancelled' }); }
    finally { clearTimeout(timer); await pendingBridge.close(); await stopped.close(); }
    expect(tools.propose).not.toHaveBeenCalled();
  }
});

it('K22: K1 reads scoped inputs, predecessor handoff and dependency views; rejects linked, foreign and out-of-root inputs', async () => {
  const { mkdir, symlink, link, unlink } = await import('node:fs/promises');
  const { loadConfiguredScopeContext } = await import('#composition/core/scoped-request/index.js');
  const { fixtureDockerRegistry } = await import('../support/execution-registry.js');
  const f = await brainProviderFixture(), c = await connection(), attempt = await mkdtemp(join(tmpdir(), 'k22-inputs-')); temporary.push(attempt);
  let port: Awaited<ReturnType<NativeCliWorkerPorts['openTools']>> | undefined;
  try {
    const configPath = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
    config.execution = { docker: { ...fixtureDockerRegistry(['custom']).profiles[0]!.parameters, executable: '/unavailable/docker' }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } };
    delete config.execution.docker.argv; await writeFile(configPath, JSON.stringify(config));
    // R4a: the real first-run template (v19), no injected MCP grant.
    const owner = adapters.readLocalOsIdentity(), firstRun = firstRunPolicyTemplate({ scopeId: 's', principal: { issuer: owner.issuer, subject: owner.subject }, ...FIRST_RUN_TOOL_NAMES });
    await writeFile(join(f.data, 'policy.json'), JSON.stringify(firstRun.policy), { mode: 0o600 }); await writeFile(join(f.data, 'bindings.json'), JSON.stringify(firstRun.bindings), { mode: 0o600 }); clearConfigCache();
    const context = await loadConfiguredScopeContext(f.project, 's', f.options, 'read');
    const { productResourcePath } = await import('#platform/index.js');
    await mkdir(productResourcePath(context.layout, 'artifacts'), { recursive: true, mode: 0o700 });
    const artifacts = new adapters.FileArtifactStore({ root: productResourcePath(context.layout, 'artifacts'), maxBytes: context.config.artifacts.maxBytes });
    const receipt = await artifacts.put('s', Buffer.from('task-one-delivered')), prepared = await artifacts.prepareReadOnlyFile('s', receipt);
    const dependencies = join(f.project, 'dependencies'); await mkdir(dependencies); await writeFile(join(dependencies, 'note.txt'), 'dependency-only');
    vi.spyOn(runs, 'recheckNativeWorkerUse').mockResolvedValue({ profile: c.profile } as never);
    const runtime = createConfiguredNativeCliWorkerRuntime(f.project, f.options)!, request = { protocolVersion: 1 as const,
      identity: { scopeId: 's', runId: 'two-task-run', taskId: 'second', attemptId: 'second-attempt', generation: 1, layoutRevision: context.layout.revision }, workspace: attempt, argv: [] };
    const resources = { inputs: [{ name: 'prior', sourceAttemptId: 'first-attempt', receipt, path: prepared.path }], handoffInputs: [{ target: '/deckent/inputs/_handoff/first.json', receipt, path: prepared.path }],
      readOnlyMounts: [{ source: dependencies, target: '/worker-deps' }] };
    port = await adapters.withMcpPrincipal(() => runtime.openTools(request, {} as NativeCliWorkerBinding, new AbortController().signal, resources));
    let sequence = 0;
    const read = (path: string) => { const id = `input-${++sequence}`; return adapters.withMcpPrincipal(() => port!.propose({ id, name: 'read_file', argumentsJson: JSON.stringify({ path }) },
      { kind: 'claude-tool-use', toolUseId: id, deckentCallId: id }, new AbortController().signal)); };
    for (const path of ['/deckent/inputs/prior', '/deckent/inputs/_handoff/first.json']) expect((await read(path)).outcome).toMatchObject({ status: 'ok', text: expect.stringContaining('task-one-delivered') });
    expect((await read('/worker-deps/note.txt')).outcome).toMatchObject({ status: 'ok', text: expect.stringContaining('dependency-only') });
    expect((await read('/worker-deps/../policy.json')).outcome.status).toBe('error');
    await adapters.withMcpPrincipal(() => port!.cancel()); port = undefined;
    const open = (resources: Parameters<NativeCliWorkerPorts['openTools']>[3]) => adapters.withMcpPrincipal(() => runtime.openTools(request, {} as NativeCliWorkerBinding, new AbortController().signal, resources));
    await expect(open({ inputs: [{ ...resources.inputs[0]!, receipt: { ...receipt, scopeId: 'other' } }] })).rejects.toMatchObject({ code: 'NATIVE_WORKER_INPUT_REFUSED' });
    await expect(open({ inputs: [{ ...resources.inputs[0]!, path: join(attempt, 'outside') }] })).rejects.toMatchObject({ code: 'NATIVE_WORKER_INPUT_REFUSED' });
    const linked = join(dependencies, 'linked'); await symlink(prepared.path, linked);
    await expect(open({ readOnlyMounts: resources.readOnlyMounts })).rejects.toMatchObject({ code: 'NATIVE_WORKER_INPUT_REFUSED' }); await unlink(linked);
    await expect(open({ readOnlyMounts: [{ source: attempt, target: '/worker-deps' }] })).rejects.toMatchObject({ code: 'NATIVE_WORKER_INPUT_REFUSED' });
    const alias = join(productResourcePath(context.layout, 'artifacts'), 'alias'); await symlink(prepared.path, alias);
    await expect(open({ inputs: [{ ...resources.inputs[0]!, path: alias }] })).rejects.toMatchObject({ code: 'NATIVE_WORKER_INPUT_REFUSED' }); await unlink(alias);
    await link(prepared.path, alias); await expect(open({ inputs: resources.inputs })).rejects.toMatchObject({ code: 'NATIVE_WORKER_INPUT_REFUSED' }); await unlink(alias);
    expect(f.posts).toBe(0);
  } finally { if (port) await adapters.withMcpPrincipal(() => port!.cancel()); await f.close(); }
});

async function verificationHarness(family: string, scenario: import('../../fixtures/native-headless/agent.js').FakeAgentScenario = {}) {
  const { mkdir } = await import('node:fs/promises');
  const { writeFakeAgentCli } = await import('../../fixtures/native-headless/agent.js');
  const { modelInvocationProfileSchema } = await import('#domain/index.js');
  const c = await connection(), global = join(c.root, 'global'), configDir = join(global, 'headless', 'logins', 'fixture'), stateDir = join(global, 'headless', 'connections', 'fixture'), bin = join(c.root, 'agent-bin');
  await mkdir(configDir, { recursive: true, mode: 0o700 }); await mkdir(bin);
  const executable = await writeFakeAgentCli(bin, family, scenario), inputCanary = join(global, 'private-input.json');
  await writeFile(inputCanary, 'INPUT-CLI-CANARY');
  const source = await readFile(executable, 'utf8');
  await writeFile(executable, source.replace("async function main() {", `async function main() { if (fs.existsSync(${JSON.stringify(inputCanary)}) || fs.existsSync('/deckent/inputs/prior')) throw Error('input-visible-in-login-realm');`), { mode: 0o700 });
  const f = await brainProviderFixture({ headless: { executable, configDir, stateDir, protocolFamily: family }, subscription: true });
  const options = { env: { ...f.options.env, DECKENT_GLOBAL_HOME: global } }, profile = modelInvocationProfileSchema.parse(f.config.provider_invocation_profiles.profiles[0]);
  vi.spyOn(runs, 'recheckNativeWorkerUse').mockResolvedValue({ profile } as never);
  const entry = adapters.nativeCliAgent(family)!, execution = (await adapters.preflightNativeAgent(profile, Date.now, (await import('../../fixtures/native-headless/connection.js')).testIsolation)).execution;
  const binding = { schemaVersion: 1, protocolFamily: family, profileDigest: modelInvocationProfileDigest(profile), definition: profile.adapter.definition,
    connectionId: '12345678-1234-4234-8234-123456789abc', resourceKey: 'slot', modelUsePin: { scopeId: profile.scopeId } } as NativeCliWorkerBinding;
  const runtime = createConfiguredNativeCliWorkerRuntime(f.project, options)!, query = { scopeId: profile.scopeId, reference: profile.reference, binding };
  const session = { schemaVersion: 1 as const, turnId: 'verification-turn', generation: 1, approvalTtlMs: 1000, tools: [{ name: 'read_file', version: 1, toolClass: 'read' as const, description: 'read', inputSchema: { type: 'object' as const, properties: {} } }] };
  const closure = { turnId: session.turnId, generation: session.generation, effects: 'settled' as const, termination: 'unverified' as const, pendingCallIds: [] };
  const tools = { session, propose: vi.fn(), cancel: async () => ({ ...closure, kind: 'cancelled' as const }), revoke: async () => ({ ...closure, kind: 'revoked' as const }) };
  const ports: NativeCliWorkerPorts = { readiness: async () => ({ state: 'ready', execution }), f08: () => runtime.f08(query), verification: runtime.verification,
    driver: runtime.driver, openTools: async () => tools, bridgeLimits: runtime.bridgeLimits, recheck: async () => {}, capacity: { acquire: async () => ({ state: 'acquired', release: async () => {} }) } };
  const task = adapters.compileNativeCodingWorkInput(adapters.createNativeCodingTemplate({ imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 10000, outputBytes: 65536 },
  { provider: entry.id, cliVersion: execution.cliVersion, discovery: { schemaVersion: 1, mode: 'disabled' }, permissionMode: 'unattended' }, binding),
  { schemaVersion: 1, task: 'Complete the business task.', scope: { paths: ['result.txt'] }, acceptance: 'A durable result.', model: { channelId: profile.reference.providerId, modelId: 'vendor/model', auxiliaryModelIds: [] } });
  const request = { protocolVersion: 1 as const, identity: { scopeId: profile.scopeId, runId: 'verification-run', taskId: 'first', attemptId: 'verify-first', generation: 1, layoutRevision: 'layout' },
    workspace: join(c.root, 'attempt', 'workspace'), argv: adapters.resolveNativeCliWorkerProfile(task).argv };
  const prepare = (requestOverride = request) => adapters.prepareNativeCliWorker({ profile: task, request: requestOverride, ports, fence: async () => true, custody: adapters.nativeWorkerCustodyFile(requestOverride) });
  return { f, runtime, query, binding, execution, prepare, request, tools };
}

it('K22: isolated fake CLIs produce host F08 after retained terminal custody; concurrent verification waits and the next Attempt is sealed', async () => {
  const { nativeAgentRealmAvailable } = await import('../../fixtures/native-headless/agent.js');
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const registry = (await import('../../../assets/native-coding/commands.json', { with: { type: 'json' } })).default;
  for (const family of [registry.adapters.claude.capabilities.eventStream, registry.adapters.codex.headless.protocolFamily]) {
    const h = await verificationHarness(family!, { answer: JSON.stringify({ schemaVersion: 1, summary: 'first-real-worker-answer', changedFiles: [], checks: [], openIssues: [] }) });
    try {
      expect(await h.runtime.f08(h.query)).toBeNull();
      const first = await h.prepare(); if (first.state !== 'ready') throw Error(JSON.stringify(first));
      expect(await h.prepare({ ...h.request, identity: { ...h.request.identity, attemptId: 'concurrent' } })).toEqual({ state: 'waiting', reason: 'NATIVE_WORKER_VERIFICATION_WAIT' });
      const actual = await first.supervisor.execute(h.request); expect(actual, JSON.stringify(actual)).toMatchObject({ result: { kind: 'exited', exitCode: 0 }, stdout: expect.stringContaining('first-real-worker-answer') });
      expect(await h.runtime.f08(h.query)).toBeNull(); await first.supervisor.release(h.request);
      expect(await h.runtime.f08(h.query)).toEqual(h.execution);
      const next = { ...h.request, identity: { ...h.request.identity, attemptId: 'normal-second' } }, second = await h.prepare(next);
      if (second.state !== 'ready') throw Error(JSON.stringify(second));
      expect(await second.supervisor.execute(next)).toMatchObject({ result: { kind: 'exited', exitCode: 0 } }); await second.supervisor.release(next);
      expect(h.tools.propose).not.toHaveBeenCalled(); expect(h.f.posts).toBe(0);
    } finally { await h.f.close(); }
  }
});

it('K22: plugin, native item and proposal-before-item guards retain negative F08 and never reach a governed tool or retry', async () => {
  const { nativeAgentRealmAvailable } = await import('../../fixtures/native-headless/agent.js');
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const registry = (await import('../../../assets/native-coding/commands.json', { with: { type: 'json' } })).default;
  for (const [family, scenario, reason] of [
    [registry.adapters.claude.capabilities.eventStream, { pluginMismatch: true }, 'NATIVE_WORKER_PLUGIN_UNEXPECTED'],
    [registry.adapters.codex.headless.protocolFamily, { nativeItem: true }, 'NATIVE_WORKER_TOOL_SURFACE_UNEXPECTED'],
    [registry.adapters.codex.headless.protocolFamily, { proposalBeforeItem: true, calls: [{ name: 'read_file', arguments: { path: 'unchanged-risky-input' } }] }, 'NATIVE_WORKER_TOOL_SURFACE_UNEXPECTED'],
  ] as const) {
    const h = await verificationHarness(family!, scenario);
    try {
      const first = await h.prepare(); if (first.state !== 'ready') throw Error(JSON.stringify(first));
      const actual = await first.supervisor.execute(h.request); expect(actual, JSON.stringify(actual)).toMatchObject({ result: { kind: 'exited', exitCode: 1 }, stderr: reason });
      await first.supervisor.release(h.request);
      await expect(h.runtime.f08(h.query)).rejects.toMatchObject({ code: reason });
      for (let observation = 0; observation < 2; observation++) expect(await h.prepare()).toEqual({ state: 'waiting', reason });
      expect(h.tools.propose).not.toHaveBeenCalled(); expect(h.f.posts).toBe(0);
    } finally { await h.f.close(); }
  }
});

it('K22: an approved exact shell request cannot write input, handoff or dependency views; the environment probe sees the same inputs', async () => {
  const { nativeAgentRealmAvailable } = await import('../../fixtures/native-headless/agent.js');
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  const { mkdir } = await import('node:fs/promises'), { productResourcePath } = await import('#platform/index.js');
  const { loadConfiguredScopeContext } = await import('#composition/core/scoped-request/index.js');
  const { configuredApproval } = await import('#composition/core/approvals/index.js');
  const { createTerminalRuntimeClient, terminalRuntimePeer } = await import('../support/terminal-runtime-client.js');
  const { approvalRecordSchema } = await import('#domain/index.js');
  const f = await brainProviderFixture(), c = await connection(), workspace = await mkdtemp(join(tmpdir(), 'k22-readonly-')); temporary.push(workspace);
  let port: Awaited<ReturnType<NativeCliWorkerPorts['openTools']>> | undefined;
  try {
    const configPath = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
    config.execution = { docker: { executable: '/unavailable/docker', imageId: 'sha256:' + 'a'.repeat(64) }, git: { gitExecutable: '/usr/bin/git' } };
    await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
    // R4a: the real first-run template (v19), no injected MCP grant: the shell card comes from its edit/shell rule.
    const owner = adapters.readLocalOsIdentity(), firstRun = firstRunPolicyTemplate({ scopeId: 's', principal: { issuer: owner.issuer, subject: owner.subject }, ...FIRST_RUN_TOOL_NAMES });
    await writeFile(join(f.data, 'policy.json'), JSON.stringify(firstRun.policy), { mode: 0o600 }); await writeFile(join(f.data, 'bindings.json'), JSON.stringify(firstRun.bindings), { mode: 0o600 }); clearConfigCache();
    const context = await loadConfiguredScopeContext(f.project, 's', f.options, 'read'), artifactsRoot = productResourcePath(context.layout, 'artifacts');
    await mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
    const artifacts = new adapters.FileArtifactStore({ root: artifactsRoot, maxBytes: context.config.artifacts.maxBytes }), receipt = await artifacts.put('s', Buffer.from('immutable-input'));
    const prepared = await artifacts.prepareReadOnlyFile('s', receipt), dependencies = join(f.project, 'dependency'); await mkdir(dependencies); await writeFile(join(dependencies, 'note.txt'), 'immutable-dependency');
    vi.spyOn(runs, 'recheckNativeWorkerUse').mockResolvedValue({ profile: c.profile } as never);
    const runtime = createConfiguredNativeCliWorkerRuntime(f.project, f.options)!, request = { protocolVersion: 1 as const, workspace, argv: [],
      identity: { scopeId: 's', runId: 'readonly-run', taskId: 'second', attemptId: 'readonly-attempt', generation: 1, layoutRevision: context.layout.revision } };
    const resources = { inputs: [{ name: 'locked', sourceAttemptId: 'first-attempt', receipt, path: prepared.path }],
      handoffInputs: [{ target: '/deckent/inputs/_handoff/first.json', receipt, path: prepared.path }], readOnlyMounts: [{ source: dependencies, target: '/worker-deps' }] };
    await runtime.checkEnvironment!(request, {} as NativeCliWorkerBinding, { schemaVersion: 1, requirements: [{ id: 'input-readable', kind: 'path-readable', target: '/deckent/inputs/locked' }] }, resources, new AbortController().signal);
    port = await adapters.withMcpPrincipal(() => runtime.openTools(request, {} as NativeCliWorkerBinding, new AbortController().signal, resources));
    const targets = ['/deckent/inputs/locked', '/deckent/inputs/_handoff/first.json', '/worker-deps/note.txt'];
    const aiContext = await adapters.withMcpPrincipal(() => loadConfiguredScopeContext(f.project, 's', f.options, 'read'));
    const { decideAgentToolCall } = await import('#engine/index.js');
    expect(decideAgentToolCall(aiContext.document, { principal: aiContext.principal, scopeId: 's', tool: adapters.RUN_SHELL_TOOL_SPEC, operation: adapters.HOST_SHELL_RUN_OPERATION.operation, cell: 'read' })).toMatchObject({ decision: 'require-approval' });
    const program = `const fs=require('node:fs'); for (const path of ${JSON.stringify(targets)}) { try { fs.writeFileSync(path,'unauthorized-change'); throw Error('input-writable'); } catch(e) { if(e.code!=='EROFS') throw e; } } console.log('all-three-readonly')`;
    const command = `node -e '${program.replaceAll("'", "'\\''")}'`;
    await adapters.openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true);
    // R9 (owner 2026-11-05): a read-only shell command of a Run worker runs card-free in standart (the v19 rule is modeEligible) and is audited as shell-read.
    await writeFile(join(workspace, 'note.txt'), 'twelve bytes');
    expect((await adapters.withMcpPrincipal(() => port!.propose({ id: 'read-only-shell', name: 'run_shell', argumentsJson: JSON.stringify({ command: 'ls; test -f note.txt && wc -c note.txt' }) },
      { kind: 'claude-tool-use', toolUseId: 'read-only-shell', deckentCallId: 'read-only-shell' }, new AbortController().signal))).outcome).toMatchObject({ status: 'ok', text: expect.stringContaining('12 note.txt') });
    { const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(f.path, { readOnly: true });
      try { expect(db.prepare(`SELECT count(*) AS n FROM audit_events WHERE record LIKE '%"kind":"permission-mode"%' AND record LIKE '%"cell":"shell-read"%'`).get()).toEqual({ n: 1 }); } finally { db.close(); } }
    // Keep the interpreter attack intact: the AI authority floor refuses it before any card.
    expect((await adapters.withMcpPrincipal(() => port!.propose({ id: 'interpreter-write', name: 'run_shell', argumentsJson: JSON.stringify({ command }) },
      { kind: 'claude-tool-use', toolUseId: 'interpreter-write', deckentCallId: 'interpreter-write' }, new AbortController().signal))).outcome)
      .toMatchObject({ status: 'error', text: expect.stringContaining('denied-by-policy') });
    for (const [index, path] of targets.entries()) {
      const id = `readonly-shell-${index}`, exactWrite = `printf '%s' '${'unauthorized-change'.repeat(20)}' > '${path}'`;
      let observed: unknown;
      const pending = adapters.withMcpPrincipal(() => port!.propose({ id, name: 'run_shell', argumentsJson: JSON.stringify({ command: exactWrite }) },
        { kind: 'claude-tool-use', toolUseId: id, deckentCallId: id }, new AbortController().signal)).then(result => { observed = result; return result; });
      let card: ReturnType<typeof approvalRecordSchema.parse> | undefined;
      const deadline = Date.now() + 5000;
      while (!card && Date.now() < deadline) {
        const rows = await configuredApproval(f.project, 'list', { schemaVersion: 1, scopeId: 's', afterId: null, limit: 16 }, f.options) as unknown[];
        card = rows.map(row => approvalRecordSchema.parse(row)).find(row => row.status === 'pending');
        if (!card) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(card, 'the exact write must reach its card: ' + JSON.stringify(observed)).toBeDefined();
      expect(JSON.stringify(card)).toContain(exactWrite);
      const peer = await terminalRuntimePeer(createTerminalRuntimeClient(f.project, f.options));
      const decision = { schemaVersion: 1, commandId: `approve-readonly-${index}`, scopeId: 's', approvalId: card!.request.approvalId,
        expectedRevision: card!.revision, decision: 'allow', reason: 'synthetic-person approves the exact write attempt' };
      // Ordinary list/PTY evidence cannot open a hard-floor card. A trusted turn producer must bind the exact card to this peer.
      await expect(configuredApproval(f.project, 'decide', decision, f.options, peer)).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
      const ring = (await import('#engine/index.js')).createTurnDecisionCapabilities();
      const capability = ring.mint({ scopeId: 's', approvalId: card!.request.approvalId, principal: context.principal, peerPid: peer.pid, expiresAt: card!.request.expiresAt }, Date.now());
      await configuredApproval(f.project, 'decide', { ...decision, decisionCapability: capability }, f.options, peer, undefined, {}, ring);
      expect((await pending).outcome).toMatchObject({ status: 'error', text: expect.stringContaining('Read-only file system') });
    }
    expect(await readFile(prepared.path, 'utf8')).toBe('immutable-input'); expect(await readFile(join(dependencies, 'note.txt'), 'utf8')).toBe('immutable-dependency');
    await adapters.withMcpPrincipal(() => port!.cancel()); port = undefined; expect(f.posts).toBe(0);
  } finally { if (port) await adapters.withMcpPrincipal(() => port!.cancel()); await f.close(); }
});
