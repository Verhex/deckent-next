import { EventEmitter } from 'node:events';
import { mkdtemp, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { FileArtifactStore } from '#adapters/core/file-artifacts/index.js';
import { createNativeCodingTemplate, compileNativeCodingWorkInput } from '#adapters/core/native-coding/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { createClaudeAgentDriver, nativeAgentFlagSetDigest } from '#adapters/core/native-cli-headless/index.js';
import { nativeWorkerEventRetentionBytes } from '#adapters/core/native-connection/index.js';
import { createNativeCliWorkerDriver, createNativeWorkerEvents, prepareNativeCliWorker, resolveNativeCliWorkerProfile,
  type NativeCliWorkerBinding, type NativeCliWorkerPorts, type NativeCliWorkerTransport } from '#adapters/core/native-cli-worker/index.js';
import { runNodeProcess } from '#adapters/core/process-runner/index.js';
import { openWorkerEventSink, sealAttemptWorkerEvents, WORKER_EVENT_SEAL_RESERVE_BYTES } from '#adapters/core/worker-observation/index.js';
import type { NativeAgentExecution, ToolSessionPort } from '#capabilities/index.js';
import { attemptIdentitySchema, modelInvocationProfileSchema, workerEventSchema, type WorkerEvent } from '#domain/index.js';
import { modelInvocationProfileDigest, type SandboxRequest } from '#engine/index.js';
import { snapshotKnownSecrets } from '#platform/index.js';
import { initLine, rateLimitLine, resultLine } from '../../fixtures/native-headless/stream.js';
import { fillOrdinaryBytes, ndjson, observation, unmapped } from './n0-preflight-fixture.js';

class FixtureChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

let driveChild: (child: FixtureChild) => void;
vi.mock(import('node:child_process'), async importOriginal => ({
  ...await importOriginal(),
  spawn: () => {
    const child = new FixtureChild();
    queueMicrotask(() => { child.emit('spawn'); driveChild(child); });
    return child;
  },
}));

it.each(['full', 'end-close', 'cancel', 'cancel-before', 'guarded-tail', 'paid-tail', 'sink-loss', 'handover-loss', 'sink-timeout'] as const)('settles the first local observation at %s', async scenario => {
  const root = await mkdtemp('/tmp/card-n0pre/local-');
  const maxBytes = nativeWorkerEventRetentionBytes();
  const losesSink = scenario === 'sink-loss' || scenario === 'sink-timeout';
  const waitingWrite = Promise.withResolvers<{ bytesWritten: number }>();
  const sink = await openWorkerEventSink(root, losesSink ? async () => ({
    async write() { if (scenario === 'sink-timeout') return waitingWrite.promise; throw new Error('Fixture sink write failed'); },
    async close() {},
  }) : undefined);
  const guarded = scenario === 'guarded-tail' || scenario === 'paid-tail';
  const cancelled = scenario === 'cancel' || scenario === 'cancel-before';
  let guardedRunDir: string | undefined, launches = 0;
  const family = 'claude-code-stream-json', cli = nativeCliAgent(family)!;
  const definition = { schemaVersion: 1 as const, executable: join(root, 'fixture-cli'),
    configDir: join(root, 'fixture-config'), stateDir: root, ownerUid: process.getuid!(), minCliVersion: '2.1.0', delegatedUse: null };
  const invocation = modelInvocationProfileSchema.parse({ schemaVersion: 2, id: 'fixture', version: 1, scopeId: 'n0-scope', billingAxis: 'subscription',
    reference: { providerId: 'fixture', providerVersion: 1, modelId: 'fixture-model', modelVersion: 1 }, bindingDigest: 'a'.repeat(64),
    protocol: { family, version: 'v1' }, adapter: { id: 'native-cli-headless', version: 1, definition },
    allocation: { id: 'fixture', maxCalls: 1, maxInFlight: 1 }, limits: { requestMaxBytes: 65536, responseMaxBytes: 65536, timeoutMs: 20000 } });
  const binding: NativeCliWorkerBinding = { schemaVersion: 1, connectionId: 'aabbccdd-1234-4123-8123-123456789abc', protocolFamily: family,
    profileDigest: modelInvocationProfileDigest(invocation), resourceKey: 'fixture-capacity', definition };
  const execution: NativeAgentExecution = { schemaVersion: 1, capability: 'NativeAgentExecution', executable: definition.executable,
    cliVersion: '2.1.317', ownerUid: definition.ownerUid, profileDigest: binding.profileDigest, flagSetDigest: nativeAgentFlagSetDigest(cli) };
  const profile = compileNativeCodingWorkInput(createNativeCodingTemplate({
    imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2,
    tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536,
  }, { provider: cli.id, cliVersion: execution.cliVersion, discovery: { schemaVersion: 1, mode: 'disabled' }, permissionMode: 'unattended' }, binding),
  { schemaVersion: 1, task: 'Update the scoped note.', scope: { paths: ['note.txt'] }, acceptance: 'Keep the scoped note exact.',
    model: { channelId: 'fixture-channel', modelId: 'fixture-model', auxiliaryModelIds: [] } });
  const resolved = resolveNativeCliWorkerProfile(profile);
  const identity = attemptIdentitySchema.parse({ scopeId: 'n0-scope', runId: 'n0-run', taskId: 'n0-task', attemptId: scenario, generation: 1, layoutRevision: 'n0-layout' });
  const request: SandboxRequest = { protocolVersion: 1, identity, workspace: root, argv: resolved.argv };
  const session = { schemaVersion: 1 as const, turnId: 'fixture-turn', generation: 1, approvalTtlMs: 5000, tools: [] };
  const closure = { turnId: session.turnId, generation: session.generation, pendingCallIds: [], termination: 'confirmed' as const, effects: 'settled' as const };
  const tools: ToolSessionPort = { session, propose: async () => { throw new Error('No fixture tool calls'); },
    cancel: async () => ({ kind: 'cancelled', ...closure }), revoke: async () => ({ kind: 'revoked', ...closure }) };
  const transport: NativeCliWorkerTransport = {
    profile: invocation,
    preflight: async () => ({ execution, preflight: { executable: execution.executable,
      program: { chosen: execution.executable, executable: execution.executable, identity: 'fixture', fileStamp: 'fixture', size: 0, mtimeMs: 0 },
      version: execution.cliVersion, flagSetDigest: execution.flagSetDigest, runDir: root, env: {},
      isolation: { launcher: join(root, 'fixture-launcher'), version: 'fixture' } } }),
    claudeDriver: options => {
      if (guarded) { guardedRunDir = options.runDir; return createClaudeAgentDriver(options); }
      return { ...options.port, signal: new AbortController().signal, line() {}, finish: () => ({ kind: 'completed', text: 'fixture answer' }) };
    },
    async runIsolated(_entry, spawn, bounds, signal, line) {
      launches++;
      const evidence = await runNodeProcess({ ...bounds, schemaVersion: 2, requestId: '12345678-1234-4234-8234-123456789abc',
        executable: spawn.executable, args: spawn.args, cwd: root, env: {} }, signal, line);
      return { ...evidence, egress: { connected: 0, refused: 0, hosts: {}, other: 0 }, limit: null };
    },
  };
  const steps: string[] = [], accepted: WorkerEvent[] = [];
  const collector = createNativeWorkerEvents(resolved.nativeSubscription!, events => { accepted.push(...events); sink.accept(events); });
  const secret = 'n0-private-fixture-value', stop = new AbortController();
  const started = Promise.withResolvers<void>();
  let sequence = 0, usageBytes = 0;
  const ports: NativeCliWorkerPorts = {
    readiness: async () => ({ state: 'ready', execution }), f08: async () => execution, recheck: async () => {},
    capacity: { acquire: async () => ({ state: 'acquired', release: async () => { steps.push('capacity released'); } }) }, openTools: async () => tools,
    ...(guarded ? { verification: { acquire: async () => ({ finish: async () => {}, abandon: async () => {} }) } } : {}),
    bridgeLimits: { idleMs: 300, maxConnections: 2, replayMaxEntries: 4, replayMaxBytes: cli.bridge.frameMaxBytes * 4 },
    async driver(input, signal) {
      const driver = createNativeCliWorkerDriver({ ...input, onEvents(batch) {
        for (const event of batch) {
          // Re-number only the fixture stream to leave space for injected schema rows.
          input.onEvents!([{ ...event, sequence: ++sequence }]);
          if (event.kind === 'session.started') {
            input.onEvents!([{ schemaVersion: 1, sequence: ++sequence, atMs: 1, kind: 'message',
              role: 'assistant', textBytes: secret.length, thinking: false, excerpt: secret }]);
            if (scenario === 'full') {
              const fill = fillOrdinaryBytes(maxBytes - collector.statistics().eventBytes, sequence + 1);
              sequence += fill.length;
              input.onEvents!(fill);
              expect(collector.statistics().eventBytes).toBe(maxBytes);
            } else if (scenario === 'end-close') {
              input.onEvents!([{ ...event, sequence: ++sequence, provider: 'cursor' }, unmapped(1)]);
            }
            if (!guarded && scenario !== 'cancel-before') {
              const usage = observation(++sequence);
              usageBytes = Buffer.byteLength(ndjson(usage));
              input.onEvents!([usage]);
            }
            started.resolve();
          }
          if (event.kind === 'session.ended') {
            steps.push('driver forwarded the unterminated end');
            if (scenario === 'end-close') input.onEvents!([unmapped(++sequence)]);
          }
        }
      } }, transport, signal);
      return { ...driver, async close() { steps.push('driver closed'); await driver.close(); } };
    },
  };
  driveChild = child => {
    child.stdout.write(JSON.stringify(initLine({ model: 'fixture-model', claude_code_version: execution.cliVersion,
      ...(guarded ? { cwd: guardedRunDir, mcp_servers: [{ name: cli.bridge.serverName, status: 'connected' }] } : {}),
    })) + '\n');
    const end = scenario === 'paid-tail'
      ? rateLimitLine('allowed', { isUsingOverage: true })
      : resultLine('fixture answer', {}, 'fixture-model');
    child.stdout.end(JSON.stringify(end));
    steps.push('unterminated end bytes written');
    const close = (exitCode: number | null, signal: string | null) => {
      steps.push('child close');
      child.stderr.end();
      child.emit('close', exitCode, signal);
    };
    if (cancelled) void started.promise.then(() => {
      steps.push('cancel');
      stop.abort();
      close(null, 'SIGINT');
    });
    else close(0, null);
  };
  try {
    const prepared = await prepareNativeCliWorker({ profile, request, ports, fence: async () => true,
      knownSecrets: snapshotKnownSecrets([{ name: null, value: secret }]), holdEventSeal: true,
      ...(guarded ? { custody: { read: async () => ({ kind: 'missing' }), write: async () => {}, remove: async () => {} } } : {}),
      onEvents: batch => {
        if (scenario === 'handover-loss' && batch.some(event => event.kind === 'cli.observation')) throw new Error('Fixture handover failed');
        collector.accept(batch);
      } });
    if (prepared.state !== 'ready') throw new Error(prepared.reason);
    const result = await prepared.supervisor.execute(request, stop.signal);
    steps.push('supervisor returned');
    const unsuccessful = cancelled || scenario === 'paid-tail';
    expect(result).toMatchObject({ result: { kind: 'exited', exitCode: unsuccessful ? 1 : 0 }, interrupted: cancelled });
    await expect(prepared.supervisor.release(request)).rejects.toMatchObject({ code: 'SUPERVISOR_NOT_TERMINAL' });
    const deadline = scenario === 'sink-timeout' ? performance.now() + 10 : undefined;
    const closed = await sink.close(deadline === undefined ? undefined : 10);
    expect(closed.projectionComplete).toBe(!losesSink);
    expect(closed.events).toEqual(accepted);
    steps.push('sink drained');
    expect(accepted[1]).toMatchObject({ kind: 'message', excerpt: '[REDACTED]' });
    const held = collector.protectedObservation?.();
    const sawEnd = !unsuccessful && scenario !== 'full';
    expect(closed.events.some(event => event.kind === 'session.ended')).toBe(sawEnd);
    expect(steps).toEqual(['unterminated end bytes written', ...(cancelled ? ['cancel'] : []),
      'child close', ...(unsuccessful ? [] : ['driver forwarded the unterminated end']),
      'driver closed', 'supervisor returned', 'sink drained']);
    const stats = collector.statistics();
    if (scenario === 'full' || scenario === 'end-close' || scenario === 'cancel') {
      expect(stats.eventsUnreported).toBe(scenario === 'full' ? 1 : scenario === 'end-close' ? 3 : 0);
    }
    if (scenario === 'guarded-tail') expect(held).toMatchObject({ observation: { builtinPlugins: { names: [], omitted: 3 }, paidExtraUsage: null } });
    if (scenario === 'paid-tail') expect(held).toMatchObject({ observation: { paidExtraUsage: { kind: 'overage', window: 'five_hour' } } });
    const shouldFail = scenario === 'handover-loss' || scenario === 'sink-timeout';
    if (scenario === 'cancel-before') expect(prepared.supervisor.offeredObservation()).toBe(false);
    else expect(prepared.supervisor.offeredObservation()).toBe(true);
    for (const trimmed of shouldFail || scenario === 'cancel-before' ? [false] : [false, true]) {
      const smallBudget = unsuccessful ? 620 : 900;
      const artifactBudget = trimmed ? smallBudget : maxBytes + WORKER_EVENT_SEAL_RESERVE_BYTES;
      const artifacts = new FileArtifactStore({ root, maxBytes: artifactBudget });
      type Log = Parameters<Parameters<typeof sealAttemptWorkerEvents>[2]['saveWorkerEventLog']>[0];
      const save = vi.fn(async (value: Log) => value);
      const sealed = await sealAttemptWorkerEvents(identity, artifacts, { saveWorkerEventLog: save }, {
        ...closed, observation: held, verification: collector.modelVerification(), unreported: stats.eventsUnreported, maxBytes: artifactBudget,
        unconfirmedObservation: prepared.supervisor.offeredObservation() && !held, ...(deadline === undefined ? {} : { deadline }),
      });
      if (shouldFail) {
        expect(sealed).toMatchObject({ status: 'failed', code: 'WORKER_EVENTS_SEAL_FAILED' });
        expect(save).not.toHaveBeenCalled();
        await expect(prepared.supervisor.release(request)).rejects.toMatchObject({ code: 'SUPERVISOR_NOT_TERMINAL' });
        continue;
      }
      expect(sealed).toMatchObject({ status: 'sealed' });
      const receipt = save.mock.calls[0]![0];
      const text = Buffer.from(await artifacts.read(identity.scopeId, receipt.events)).toString();
      const observations = text.trimEnd().split('\n').map(line => workerEventSchema.parse(JSON.parse(line))).filter(row => row.kind === 'cli.observation');
      expect(observations).toEqual(scenario === 'cancel-before' ? [] : [expect.objectContaining({ observation: held!.observation })]);
      expect(receipt.projection).toBe(losesSink ? 'partial' : 'complete');
      expect(text).not.toContain(secret);
      expect(text.includes('"reason":"byte-cap"')).toBe(trimmed);
    }
    expect(await prepared.supervisor.execute(request)).toEqual(result);
    expect(launches).toBe(1);
    if (!shouldFail) {
      prepared.supervisor.confirmEventSeal();
      await prepared.supervisor.release(request);
      expect(steps.at(-1)).toBe('capacity released');
    }
    await prepared.supervisor.close();
    console.info('N0 local', scenario, JSON.stringify({ ...stats, usageBytes, steps, sawEnd, exit: result.result }));
  } finally {
    if (scenario === 'sink-timeout') waitingWrite.resolve({ bytesWritten: 0 });
    await sink.close();
    if (!losesSink) await unlink(join(root, 'worker.events'));
  }
}, 30_000);
