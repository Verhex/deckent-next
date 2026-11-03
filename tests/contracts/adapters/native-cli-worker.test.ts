import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeCodingTemplate, compileNativeCodingWorkInput, assertNativeWorkerBinding, bindNativeWorkerEffort } from '#adapters/core/native-coding/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { nativeAgentFlagSetDigest } from '#adapters/core/native-cli-headless/index.js';
import { nativeProjectionDispatch } from '#adapters/core/native-connection/index.js';
import { createNativeCliWorkerProfile, resolveNativeCliWorkerProfile, inspectNativeCliWorker, prepareNativeCliWorker,
  validateNativeCliWorkerSupervisorProfile, nativeCliWorkerFence, recordedNativeCliWorkerSupervisor, nativeWorkerCustodyFile, createNativeWorkerEvents,
  createNativeCliWorkerDriver, type NativeCliWorkerTransport,
  type NativeCliWorkerFenceReader, type NativeCliWorkerBinding, type NativeCliWorkerPorts, type NativeCliWorkerDriver } from '#adapters/core/native-cli-worker/index.js';
import type { NativeAgentExecution, ToolSessionPort } from '#capabilities/index.js';
import { sandboxObservationSchema, type SandboxRequest } from '#engine/index.js';
import type { WorkerEvent } from '#domain/index.js';
import { modelInvocationProfileSchema } from '#domain/index.js';
import { modelInvocationProfileDigest } from '#engine/index.js';
import { initLine, assistantLine, resultLine } from '../../fixtures/native-headless/stream.js';

const entry = nativeCliAgent('claude-code-stream-json')!;
const binding: NativeCliWorkerBinding = { schemaVersion: 1, connectionId: 'aabbccdd-1234-4123-8123-123456789abc', protocolFamily: entry.headless.protocolFamily ?? entry.command.capabilities.eventStream,
  profileDigest: 'b'.repeat(64), resourceKey: 'opaque-subscription-fixture', definition: { schemaVersion: 1, executable: '/fixture/cli',
    configDir: '/fixture/global/headlessLogins/cli', stateDir: '/fixture/global/connections/cli', ownerUid: 1000, minCliVersion: '2.1.0', delegatedUse: null } };
const execution: NativeAgentExecution = { schemaVersion: 1, capability: 'NativeAgentExecution', executable: binding.definition.executable,
  cliVersion: '2.1.317', ownerUid: 1000, profileDigest: binding.profileDigest, flagSetDigest: nativeAgentFlagSetDigest(entry) };
const docker = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2,
  tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const invocation = { provider: entry.id, cliVersion: execution.cliVersion, discovery: { schemaVersion: 1, mode: 'disabled' }, permissionMode: 'unattended' };
const workInput = { schemaVersion: 1, task: 'Update the scoped note.', scope: { paths: ['note.txt'] }, acceptance: 'The note matches the requested text.',
  model: { channelId: 'fixture-channel', modelId: 'fixture-exact-model', auxiliaryModelIds: [] } };
const profile = () => compileNativeCodingWorkInput(createNativeCodingTemplate(docker, invocation, binding), workInput);
const request: SandboxRequest = { protocolVersion: 1, identity: { scopeId: 'scope', runId: 'run', taskId: 'task', attemptId: 'attempt', generation: 1, layoutRevision: 'layout' },
  workspace: '/fixture/attempt/workspace', argv: resolveNativeCliWorkerProfile(profile()).argv };
const session = { schemaVersion: 1 as const, turnId: 'fixture-turn', generation: 1, approvalTtlMs: 5000,
  tools: [{ name: 'read_file', version: 1, toolClass: 'read' as const, description: 'Read the Attempt workspace', inputSchema: { type: 'object' as const, properties: {} } }] };
const closure = { turnId: session.turnId, generation: session.generation, pendingCallIds: [], termination: 'confirmed' as const, effects: 'settled' as const };
const report = { schemaVersion: 1, summary: 'scoped answer', changedFiles: [], checks: [], openIssues: [] };
function fixture() {
  const release = vi.fn(async () => {}), run = vi.fn<NativeCliWorkerDriver['run']>(async () => ({ termination: 'confirmed', status: 'completed', text: JSON.stringify(report) }));
  const tools: ToolSessionPort = { session, propose: vi.fn(async call => ({ schemaVersion: 1, turnId: session.turnId, generation: session.generation,
    deckentCallId: call.id, outcome: { status: 'ok', text: 'workspace result' } })),
  cancel: vi.fn(async () => ({ kind: 'cancelled', ...closure })), revoke: vi.fn(async () => ({ kind: 'revoked', ...closure })) };
  const ports: NativeCliWorkerPorts = { readiness: vi.fn(async () => ({ state: 'ready', execution })), f08: vi.fn(async () => execution),
    recheck: vi.fn(async () => {}), capacity: { acquire: vi.fn(async () => ({ state: 'acquired', release })) }, openTools: vi.fn(async () => tools),
    driver: vi.fn(async input => ({ tools: input.tools, run, close: vi.fn(async () => {}) })),
    bridgeLimits: { idleMs: 300, maxConnections: 2, replayMaxEntries: 4, replayMaxBytes: entry.bridge.frameMaxBytes * 4 } };
  const fence = vi.fn(async () => true);
  return { ports, release, run, tools, fence };
}
async function prepared(f = fixture()) {
  const result = await prepareNativeCliWorker({ profile: profile(), request, ports: f.ports, fence: f.fence });
  expect(result.state).toBe('ready'); if (result.state !== 'ready') throw new Error('fixture-not-ready');
  return { ...f, supervisor: result.supervisor };
}

it('K12: v2 template freezes a separate tokenless backend; legacy v1 remains unchanged and no silent migration occurs', () => {
  const legacy = compileNativeCodingWorkInput(createNativeCodingTemplate(docker, invocation), workInput);
  expect(legacy.adapter).toEqual({ id: 'docker', version: 2 });
  const template = createNativeCodingTemplate(docker, invocation, binding), worker = profile();
  expect(template.adapter).toEqual({ id: 'native-coding-template', version: 2 });
  expect(worker.adapter).toEqual({ id: 'native-cli-worker', version: 1 });
  expect(profile()).toEqual(worker); expect(resolveNativeCliWorkerProfile(worker).base.parameters).toEqual(legacy.parameters);
  expect(resolveNativeCliWorkerProfile(worker).base.id).toBe(template.id);
  expect(worker.id).toBe(template.id); expect(worker.version).toBe(template.version);
  expect(() => compileNativeCodingWorkInput({ ...template, adapter: { ...template.adapter, version: 1 } }, workInput)).toThrow('NATIVE_CODING_TEMPLATE_INVALID');
  expect(() => createNativeCliWorkerProfile(legacy, { ...binding, protocolFamily: 'unavailable' })).toThrow('NATIVE_CLI_WORKER_PROFILE_INVALID');
  expect(() => createNativeCliWorkerProfile({ ...legacy, adapter: { ...legacy.adapter, version: 1 } }, binding)).toThrow();
});
it('K12: new backend refuses native discovery and unprovable helper models instead of dropping capabilities', () => {
  const repository = createNativeCodingTemplate(docker, { ...invocation, discovery: { schemaVersion: 1, mode: 'repository' } }, binding);
  expect(() => compileNativeCodingWorkInput(repository, workInput)).toThrow('NATIVE_CLI_WORKER_PROFILE_INVALID');
  expect(() => compileNativeCodingWorkInput(createNativeCodingTemplate(docker, invocation, binding), {
    ...workInput, model: { ...workInput.model, auxiliaryModelIds: ['helper-model'] } })).toThrow('NATIVE_CLI_WORKER_PROFILE_INVALID');
});
it('K12: unsealed, stale F08, mismatched executable and unavailable readiness never acquire capacity or construct a driver', async () => {
  const f = fixture();
  f.ports.f08 = async () => null;
  expect(await prepareNativeCliWorker({ profile: profile(), request, ports: f.ports, fence: f.fence })).toEqual({ state: 'waiting', reason: 'NATIVE_WORKER_F08_REQUIRED' });
  f.ports.f08 = async () => ({ ...execution, cliVersion: '2.1.316' });
  expect(await inspectNativeCliWorker(binding, f.ports)).toEqual({ state: 'waiting', reason: 'NATIVE_WORKER_F08_REQUIRED' });
  f.ports.readiness = async () => ({ state: 'ready', execution: { ...execution, executable: '/foreign/cli' } });
  expect(await inspectNativeCliWorker(binding, f.ports)).toEqual({ state: 'waiting', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' });
  f.ports.readiness = async () => ({ state: 'unknown', reason: 'NATIVE_AGENT_LOGIN_REQUIRED' });
  expect(await inspectNativeCliWorker(binding, f.ports)).toEqual({ state: 'waiting', reason: 'NATIVE_AGENT_LOGIN_REQUIRED' });
  f.ports.readiness = async () => ({ state: 'ready', execution: { ...execution, cliVersion: '2.1.318' } }); f.ports.f08 = async () => ({ ...execution, cliVersion: '2.1.318' });
  expect(await prepareNativeCliWorker({ profile: profile(), request, ports: f.ports, fence: f.fence })).toEqual({ state: 'waiting', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' });
  expect(f.ports.capacity.acquire).not.toHaveBeenCalled(); expect(f.ports.driver).not.toHaveBeenCalled();
});
it('K12: capacity is owned by the shared opaque resource; a busy login waits without starting tools or CLI', async () => {
  const f = fixture(); f.ports.capacity.acquire = vi.fn(async () => ({ state: 'waiting' }));
  expect(await prepareNativeCliWorker({ profile: profile(), request, ports: f.ports, fence: f.fence })).toEqual({ state: 'waiting', reason: 'NATIVE_WORKER_CAPACITY_WAIT' });
  expect(f.ports.capacity.acquire).toHaveBeenCalledWith(request, binding, expect.any(AbortSignal));
  expect(f.ports.openTools).not.toHaveBeenCalled(); expect(f.ports.driver).not.toHaveBeenCalled();
});
it('K12: output stays under DispatchApplication custody; transport receives no workspace or task argv and dispatch is once only', async () => {
  const f = await prepared(), result = await f.supervisor.execute(request);
  expect(result).toMatchObject({ result: { kind: 'exited', exitCode: 0 }, outputCompleteness: 'complete' });
  expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report });
  expect(await f.supervisor.execute(request)).toEqual(result); expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.ports.openTools).toHaveBeenCalledWith(request, binding, expect.any(AbortSignal), {});
  const input = vi.mocked(f.ports.driver).mock.calls[0]![0];
  expect(input.model).toBe('fixture-exact-model'); expect(input.user).toContain(workInput.task);
  expect(JSON.stringify(input)).not.toContain(request.workspace); expect(input).not.toHaveProperty('argv');
  expect(f.release).not.toHaveBeenCalled();
  await f.supervisor.release(request); await f.supervisor.release(request); expect(f.release).toHaveBeenCalledTimes(1);
  expect(() => validateNativeCliWorkerSupervisorProfile({})).toThrow();
  validateNativeCliWorkerSupervisorProfile(await f.supervisor.captureProfile());
  await expect(f.supervisor.observe({ ...request, workspace: '/other' })).rejects.toThrow('SUPERVISOR_IDENTITY_CONFLICT');
});
it('K12: an acquired slot is released without spawning when dispatch preparation ends before launch', async () => {
  const f = await prepared(); await f.supervisor.close();
  expect(f.release).toHaveBeenCalledTimes(1); expect(f.run).not.toHaveBeenCalled();
  await expect(f.supervisor.execute(request)).rejects.toThrow('SUPERVISOR_NOT_TERMINAL');
});
it('K12: declared files reuse the existing confined output collector after process and tools settle', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'native-worker-output-')), f = fixture();
  try {
    await writeFile(join(workspace, 'answer.txt'), 'declared-output');
    const outputFiles = { maxBytes: 128, maxFiles: 1, files: [{ name: 'answer', path: 'answer.txt', maxBytes: 128 }] };
    const outputProfile = compileNativeCodingWorkInput(createNativeCodingTemplate({ ...docker, outputFiles }, invocation, binding), workInput);
    const scoped = { ...request, workspace }, p = await prepareNativeCliWorker({ profile: outputProfile, request: scoped, ports: f.ports, fence: f.fence });
    expect(p.state).toBe('ready'); if (p.state !== 'ready') throw new Error('fixture-not-ready');
    await p.supervisor.execute(scoped); const files = await p.supervisor.collectOutputFiles(scoped);
    if (process.platform === 'linux') { expect(files[0]?.status).toBe('collected'); if (files[0]?.status === 'collected') expect(Buffer.from(files[0].bytes).toString()).toBe('declared-output'); }
    else expect(files[0]?.status).toBe('unavailable');
    await p.supervisor.release(scoped);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
it('K12: a lost fence or revoked lease between preparation and spawn never invokes the CLI', async () => {
  const reader: NativeCliWorkerFenceReader = { loadRun: async () => ({ state: { kind: 'running' }, cancelRequested: false }),
    load: async () => ({ identity: request.identity, cancelRequested: false }), loadBoundDispatch: async () => null, loadRunReceipt: async () => null };
  expect(await nativeCliWorkerFence(reader, request.identity)).toBe(true);
  reader.load = async () => ({ identity: { ...request.identity, generation: 2 }, cancelRequested: false });
  expect(await nativeCliWorkerFence(reader, request.identity)).toBe(false);
  const f = await prepared(); f.fence.mockResolvedValue(false);
  expect(await f.supervisor.execute(request)).toMatchObject({ result: { kind: 'unknown' } }); expect(f.run).not.toHaveBeenCalled();
  await f.supervisor.close(); expect(f.release).toHaveBeenCalledTimes(1);
  const revoked = await prepared(); revoked.ports.recheck = async () => { throw new Error('revoked'); };
  expect(await revoked.supervisor.execute(request)).toMatchObject({ result: { kind: 'unknown' } }); expect(revoked.run).not.toHaveBeenCalled(); await revoked.supervisor.close();
  const changed = await prepared(), newer = { ...execution, cliVersion: '2.1.318' };
  changed.ports.readiness = async () => ({ state: 'ready', execution: newer }); changed.ports.f08 = async () => newer;
  expect(await changed.supervisor.execute(request)).toMatchObject({ result: { kind: 'unknown', reasonCode: 'NATIVE_AGENT_CAPABILITY_UNSEALED' } });
  expect(changed.run).not.toHaveBeenCalled(); await changed.supervisor.close();
});
it('K12: each tool admission rechecks the fence and lease; a later denial is never converted to another command', async () => {
  const f = fixture(), call = { id: 'original-call', name: 'read_file', argumentsJson: '{"path":"note.txt"}' };
  f.ports.driver = vi.fn(async input => ({ tools: input.tools, close: async () => {}, async run() {
    await input.tools.propose(call, { kind: 'claude-tool-use', toolUseId: 'original-tool', deckentCallId: call.id }, new AbortController().signal);
    f.fence.mockResolvedValue(false);
    await expect(input.tools.propose({ ...call, id: 'second-call' }, { kind: 'claude-tool-use', toolUseId: 'second-tool', deckentCallId: 'second-call' }, new AbortController().signal))
      .rejects.toThrow('SUPERVISOR_CANCELLED');
    return { termination: 'confirmed', status: 'completed', text: 'one scoped call' };
  } }));
  const p = await prepared(f); await p.supervisor.execute(request);
  expect(f.tools.propose).toHaveBeenCalledTimes(1); expect(f.tools.propose).toHaveBeenCalledWith(call, expect.anything(), expect.any(AbortSignal));
  expect(f.ports.recheck).toHaveBeenCalledTimes(4); await p.supervisor.release(request);
});
it('K12: cancellation aborts the same driver, closes the facade/session and keeps the first stop cause', async () => {
  const f = fixture(); let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.run.mockImplementation(async (_bridge, signal) => { entered(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return { termination: 'confirmed', status: 'completed', text: 'late answer' }; });
  const p = await prepared(f), running = p.supervisor.execute(request); await started;
  const observed = await p.supervisor.cancel(request), result = await running;
  expect(sandboxObservationSchema.parse(observed)).toEqual({ handle: result.handle, result: result.result });
  expect(result).toMatchObject({ result: { kind: 'exited', exitCode: 1 }, interrupted: true, interruptCause: 'cancel' });
  expect(f.tools.cancel).toHaveBeenCalledOnce(); await p.supervisor.release(request);
});
it('K12: uncertain process or effects cannot produce terminal success or release capacity', async () => {
  const f = fixture(); f.tools.cancel = async () => ({ ...closure, kind: 'cancelled', effects: 'unknown' });
  const p = await prepared(f); expect(await p.supervisor.execute(request)).toMatchObject({ result: { kind: 'unknown', reasonCode: 'NATIVE_WORKER_EFFECTS_UNKNOWN' } });
  await expect(p.supervisor.release(request)).rejects.toThrow('SUPERVISOR_NOT_TERMINAL'); expect(f.release).not.toHaveBeenCalled();
  const fresh = await prepared(); expect(await fresh.supervisor.observe(request)).toMatchObject({ result: { kind: 'unknown', reasonCode: 'NATIVE_WORKER_CUSTODY_UNKNOWN' } }); await fresh.supervisor.close();
});
it('K12: echoed bridge authority is redacted from retained output and a changed request cannot acquire capacity', async () => {
  const f = fixture(); let token = '';
  f.ports.driver = async input => ({ tools: input.tools, close: async () => {}, async run(bridge) {
    token = bridge.turnToken; return { termination: 'confirmed', status: 'completed', text: JSON.stringify({ ...report, summary: `echo ${token}` }) };
  } });
  const p = await prepared(f), output = await p.supervisor.execute(request);
  expect(output.stdout).not.toContain(token); expect(output.stdout).toContain(`‹secret:${entry.bridge.tokenEnvName}›`); await p.supervisor.release(request);
  const changed = fixture();
  await expect(prepareNativeCliWorker({ profile: profile(), request: { ...request, argv: ['other'] }, ports: changed.ports, fence: changed.fence })).rejects.toThrow('SUPERVISOR_IDENTITY_CONFLICT');
  expect(changed.ports.capacity.acquire).not.toHaveBeenCalled();
});
it('K12: projection retirement is explicit and registry scoped; Cursor and non-subscription dispatch are preserved', () => {
  const native = resolveNativeCliWorkerProfile(profile()).nativeSubscription!;
  expect(nativeProjectionDispatch(native, false)).toBe('legacy'); expect(nativeProjectionDispatch(native, true)).toBe('retired');
  expect(nativeProjectionDispatch({ schemaVersion: 1, provider: 'cursor' }, true)).toBe('legacy');
  expect(nativeProjectionDispatch(undefined, true)).toBe('legacy');
});
it('K17: binding and effort read base while preserving the wrapper; a mismatched base model is refused', () => {
  const original = profile(); assertNativeWorkerBinding(original);
  const bound = bindNativeWorkerEffort(original, { schemaVersion: 1, level: 'high', source: 'explicit', status: 'selected' });
  expect(bound.adapter).toEqual(original.adapter); expect(bound.id).toBe(original.id);
  expect(resolveNativeCliWorkerProfile(bound).nativeSubscription?.reasoningEffort?.level).toBe('high');
  expect(resolveNativeCliWorkerProfile(bound).binding).toEqual(binding);
  assertNativeWorkerBinding(bound);
  const base = resolveNativeCliWorkerProfile(original).base;
  const changed = { ...base, parameters: { ...base.parameters, argv: [...resolveNativeCliWorkerProfile(original).argv.slice(0, -3), 'wrong-model', '--', 'prompt'] } };
  expect(() => assertNativeWorkerBinding({ ...original, parameters: { ...original.parameters, base: changed } })).toThrow();
});
it('K17: K1 effects-settled closure and separate confirmed CLI termination can finish; a driver guard refusal cannot', async () => {
  const f = fixture(); f.tools.cancel = async () => ({ ...closure, kind: 'cancelled', termination: 'unverified' });
  const p = await prepared(f); expect(await p.supervisor.execute(request)).toMatchObject({ result: { kind: 'exited', exitCode: 0 } });
  expect(sandboxObservationSchema.parse(await p.supervisor.observe(request)).result.kind).toBe('exited'); await p.supervisor.release(request);
  const refused = fixture(); refused.run.mockResolvedValue({ termination: 'confirmed', status: 'failed', text: '', refusal: 'NATIVE_AGENT_PLUGIN_UNEXPECTED' });
  const q = await prepared(refused);
  expect(await q.supervisor.execute(request)).toMatchObject({ result: { kind: 'unknown', reasonCode: 'NATIVE_AGENT_PLUGIN_UNEXPECTED' } });
  await expect(q.supervisor.release(request)).rejects.toThrow('SUPERVISOR_NOT_TERMINAL'); expect(refused.release).not.toHaveBeenCalled();
});
it('K17: confirmed redacted output survives owner release; restored control never spawns and rejects changed custody', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-worker-custody-')), f = fixture();
  const scoped = { ...request, workspace: join(directory, 'workspace') };
  try {
    const p = await prepareNativeCliWorker({ profile: profile(), request: scoped, ports: f.ports, fence: f.fence, custody: nativeWorkerCustodyFile(scoped) });
    if (p.state !== 'ready') throw new Error('fixture-not-ready');
    const output = await p.supervisor.execute(scoped), recorded = await p.supervisor.captureProfile(); await p.supervisor.release(scoped);
    const restored = recordedNativeCliWorkerSupervisor(recorded);
    expect(sandboxObservationSchema.parse(await restored.observe(scoped))).toEqual({ handle: output.handle, result: output.result });
    expect(await restored.recoverOutput(scoped)).toEqual({ stdout: output.stdout, stderr: output.stderr, completeness: 'partial' });
    expect(await restored.release(scoped)).toBe('absent'); expect(f.run).toHaveBeenCalledTimes(1);
    await expect(restored.execute(scoped)).rejects.toThrow('SUPERVISOR_REQUEST_INVALID');
    await expect(restored.observe({ ...scoped, identity: { ...scoped.identity, generation: 2 } })).rejects.toThrow('SUPERVISOR_IDENTITY_CONFLICT');
    const absent = { ...scoped, workspace: join(directory, 'absent', 'workspace') };
    expect(await restored.cancel(absent)).toMatchObject({ result: { kind: 'unknown', reasonCode: 'NATIVE_WORKER_CUSTODY_UNKNOWN' } });
    await expect(restored.release(absent)).rejects.toThrow('SUPERVISOR_RELEASE_UNCONFIRMED'); expect(f.run).toHaveBeenCalledTimes(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('K17: restored cancellation reaches the active owner; uncertain effects retain capacity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-worker-cancel-')), f = fixture(), scoped = { ...request, workspace: join(directory, 'workspace') };
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  f.run.mockImplementation(async (_bridge, signal) => { entered(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return { termination: 'confirmed', status: 'cancelled', text: '' }; });
  f.tools.cancel = async () => ({ ...closure, kind: 'cancelled', effects: 'unknown', termination: 'unverified' });
  try {
    const p = await prepareNativeCliWorker({ profile: profile(), request: scoped, ports: f.ports, fence: f.fence, custody: nativeWorkerCustodyFile(scoped) });
    if (p.state !== 'ready') throw new Error('fixture-not-ready');
    const running = p.supervisor.execute(scoped); await started;
    const restored = recordedNativeCliWorkerSupervisor(await p.supervisor.captureProfile());
    expect(await restored.cancel(scoped)).toMatchObject({ result: { kind: 'unknown', reasonCode: 'NATIVE_WORKER_EFFECTS_UNKNOWN' } });
    await running; await expect(restored.release(scoped)).rejects.toThrow('SUPERVISOR_NOT_TERMINAL'); expect(f.release).not.toHaveBeenCalled();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('K17: normalized evidence is bounded and sealed by the existing host verdict; no reported data stays unverified', () => {
  const accepted: WorkerEvent[] = [], native = resolveNativeCliWorkerProfile(profile()).nativeSubscription!, collector = createNativeWorkerEvents(native, batch => accepted.push(...batch));
  expect(collector.modelVerification()).toMatchObject({ status: 'unverified', observed: [] });
  collector.accept([{ schemaVersion: 1, sequence: 1, atMs: 1, kind: 'session.started', provider: native.provider, model: native.model!.modelId, cliVersion: execution.cliVersion },
    { schemaVersion: 1, sequence: 2, atMs: 2, kind: 'session.ended', outcome: 'success', turns: 1, durationMs: 1, apiDurationMs: null, costUsd: null, costBasis: null,
      tokens: null, permissionDenials: 0, models: [native.model!.modelId] }]);
  expect(accepted).toHaveLength(2); expect(collector.modelVerification()).toMatchObject({ status: 'verified', observed: [native.model!.modelId] });
  collector.accept([{ schemaVersion: 1, sequence: 3, atMs: 3, kind: 'model.verification', status: 'verified', admitted: 'forged', observed: [], unexpected: [] }]);
  expect(accepted).toHaveLength(2); expect(collector.statistics().eventsUnreported).toBe(1);
});

async function transportFixture(family: string) {
  const stateDir = await mkdtemp(join(tmpdir(), 'native-worker-driver-')), f = fixture(), cli = nativeCliAgent(family)!;
  const bound = { ...binding, protocolFamily: family, definition: { ...binding.definition, stateDir } };
  const profile = modelInvocationProfileSchema.parse({ schemaVersion: 2, id: 'fixture', version: 1, scopeId: 'scope', billingAxis: 'subscription',
    reference: { providerId: 'fixture', providerVersion: 1, modelId: 'fixture-model', modelVersion: 1 }, bindingDigest: 'a'.repeat(64),
    protocol: { family, version: 'v1' }, adapter: { id: 'native-cli-headless', version: 1, definition: bound.definition },
    allocation: { id: 'fixture', maxCalls: 1, maxInFlight: 1 }, limits: { requestMaxBytes: 65536, responseMaxBytes: 65536, timeoutMs: 20000 } });
  const seal = { ...execution, profileDigest: modelInvocationProfileDigest(profile), flagSetDigest: nativeAgentFlagSetDigest(cli) };
  const input = { binding: { ...bound, profileDigest: seal.profileDigest }, tools: f.tools, model: 'fixture-exact-model', system: 'worker core', user: 'scoped task', deadlineMs: 20000, outputBytes: 65536,
    execution: seal, ...(cli.command.capabilities.maxTurns ? { maxTurns: 3 } : {}) };
  const isolated = vi.fn<NativeCliWorkerTransport['runIsolated']>(async (_entry, spawn, _bounds, _signal, line) => {
    const values = cli.agent.transport.kind === 'claude-mcp' ? [initLine({ cwd: spawn.runDir, model: input.model, claude_code_version: seal.cliVersion }),
      assistantLine('answer', input.model), resultLine('answer', {}, input.model)] : [
      { type: 'thread.started', thread_id: 'thread' }, { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'answer' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } },
    ];
    for (const value of values) expect(line(JSON.stringify(value))).not.toBe('stop');
    return { schemaVersion: 1, requestId: '12345678-1234-4234-8234-123456789abc', started: true, reason: 'exit', exitCode: 0, signal: null,
      stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1, egress: { connected: 0, refused: 0, hosts: {}, other: 0 }, limit: null };
  });
  const transport: NativeCliWorkerTransport = { profile,
    preflight: vi.fn(async () => ({ execution: seal, preflight: { executable: seal.executable, version: seal.cliVersion, flagSetDigest: seal.flagSetDigest,
      runDir: stateDir, env: {}, isolation: { launcher: '/synthetic/bwrap', version: 'synthetic' } } })),
    claudeDriver: vi.fn(options => ({ ...options.port, signal: new AbortController().signal, line() {}, finish: () => ({ kind: 'completed', text: 'answer' }) })),
    claudeRun: vi.fn(async (_entry, _session, input) => {
      const promptFile = join(input.runDir, 'system'), configFile = join(input.runDir, 'mcp.json');
      await writeFile(promptFile, input.system, { flag: 'wx', mode: 0o600 }); await writeFile(configFile, input.turnToken, { flag: 'wx', mode: 0o600 });
      return { args: [cli.command.modelFlag, input.model], promptFile, configFile, dispose: async () => undefined };
    }), runIsolated: isolated };
  const bridge = { turnToken: 'synthetic-turn-token', tokenEnvName: cli.bridge.tokenEnvName,
    url: `http://${cli.bridge.sentinelHost}${cli.bridge.path}` } as Parameters<NativeCliWorkerDriver['run']>[0];
  return { stateDir, input, transport, bridge, isolated };
}
it('K17: Claude worker transport preserves task limits and private files through the shared isolated seam', async () => {
  const f = await transportFixture('claude-code-stream-json');
  try {
    const events: WorkerEvent[] = [], driver = createNativeCliWorkerDriver({ ...f.input, onEvents: batch => events.push(...batch) }, f.transport, new AbortController().signal);
    expect(await readdir(f.stateDir)).toEqual([]); expect(f.isolated).not.toHaveBeenCalled();
    expect(await driver.run(f.bridge, new AbortController().signal)).toMatchObject({ termination: 'confirmed', status: 'completed', text: 'answer' });
    const [, spawn, bounds] = f.isolated.mock.calls[0]!;
    expect(spawn.args).toEqual(expect.arrayContaining(['--max-turns', '3', f.input.model]));
    expect(spawn.args).not.toContain(f.bridge.turnToken); expect(spawn).not.toHaveProperty('workspace'); expect(spawn).not.toHaveProperty('inputs');
    expect(spawn.mcpConfigFile).toContain('worker-run-'); expect(bounds.timeoutMs).toBe(f.input.deadlineMs);
    expect(Buffer.from(bounds.stdinBase64!, 'base64').toString()).toBe(f.input.user); expect(events.some(row => row.kind === 'session.ended')).toBe(true);
    await driver.close(); expect(await readdir(f.stateDir)).toEqual([]);
    await expect(driver.run(f.bridge, new AbortController().signal)).rejects.toThrow('NATIVE_CLI_WORKER_UNAVAILABLE');
  } finally { await rm(f.stateDir, { recursive: true, force: true }); }
});
it('K17: Codex worker uses the real K3 stream guard, token env and no invented turn limit', async () => {
  const f = await transportFixture('codex-jsonl');
  try {
    const driver = createNativeCliWorkerDriver(f.input, f.transport, new AbortController().signal);
    expect(await driver.run(f.bridge, new AbortController().signal)).toMatchObject({ termination: 'confirmed', status: 'completed', text: 'answer' });
    const [, spawn] = f.isolated.mock.calls[0]!;
    expect(spawn.env[f.bridge.tokenEnvName]).toBe(f.bridge.turnToken); expect(spawn.args.join(' ')).not.toContain(f.bridge.turnToken);
    expect(f.transport.claudeDriver).not.toHaveBeenCalled(); expect(f.transport.claudeRun).not.toHaveBeenCalled();
    await driver.close(); expect(await readdir(f.stateDir)).toEqual([]);
    expect(() => createNativeCliWorkerDriver({ ...f.input, maxTurns: 3 }, f.transport, new AbortController().signal)).toThrow('NATIVE_CLI_WORKER_UNAVAILABLE');
  } finally { await rm(f.stateDir, { recursive: true, force: true }); }
});
