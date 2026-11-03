import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeCodingTemplate, compileNativeCodingWorkInput } from '#adapters/core/native-coding/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { nativeAgentFlagSetDigest } from '#adapters/core/native-cli-headless/index.js';
import { nativeProjectionDispatch } from '#adapters/core/native-connection/index.js';
import { createNativeCliWorkerProfile, resolveNativeCliWorkerProfile, inspectNativeCliWorker, prepareNativeCliWorker,
  validateNativeCliWorkerSupervisorProfile, nativeCliWorkerFence, type NativeCliWorkerFenceReader, type NativeCliWorkerBinding, type NativeCliWorkerPorts, type NativeCliWorkerDriver } from '#adapters/core/native-cli-worker/index.js';
import type { NativeAgentExecution, ToolSessionPort } from '#capabilities/index.js';
import type { SandboxRequest } from '#engine/index.js';

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
  const result = await p.supervisor.cancel(request); expect(await running).toEqual(result);
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
