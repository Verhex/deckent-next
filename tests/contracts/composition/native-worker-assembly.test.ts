import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as adapters from '#adapters/index.js';
import * as runs from '#composition/core/runs/index.js';
import { createConfiguredNativeCliWorkerRuntime } from '#composition/core/execution/index.js';
import { inspectSubscriptionReadiness } from '#composition/core/subscription-readiness/index.js';
import { modelInvocationProfileDigest } from '#engine/index.js';
import { clearConfigCache } from '#platform/index.js';
import { connection, cleanupConnections } from '../../fixtures/native-headless/connection.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import type { NativeCliWorkerBinding, NativeCliWorkerPorts, NativeCliWorkerTransport, NativeCliWorkerDriver } from '#adapters/index.js';

const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await cleanupConnections(); for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });

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
    const owner = adapters.readLocalOsIdentity(), policyPath = join(f.data, 'policy.json'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
    const principals = [{ issuer: `${owner.issuer}/mcp`, subject: owner.subject }];
    policy.grants.push(...[
      { id: 'tools', actions: ['invoke'], resource: { kind: 'agent-tool', ids: 'all' } },
      { id: 'files', actions: ['execute'], resource: { kind: 'operation', ids: ['workspace.file.write'] } },
    ].map(row => ({ ...row, effect: 'allow', principals, scopes: ['s'] })));
    await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 }); await writeFile(join(attempt, 'note.txt'), 'attempt-only'); clearConfigCache();
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
