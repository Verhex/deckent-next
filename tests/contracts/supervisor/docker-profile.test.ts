import { mkdtemp, rm } from 'node:fs/promises';
import { arch, hostname, platform, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DockerSupervisor, recordedDockerSupervisor, recordedWorkerIsolation, runNodeDockerCommand } from '#adapters/index.js';
import { workerIsolationProven } from '#domain/index.js';
const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
it.skipIf(!imageId || process.platform !== 'linux')('captures actual Docker origin and restores exact immutable options without accepting foreign origin or unknown parameters', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'deckent-profile-')); const os = userInfo();
  try {
    const options = { executable: '/usr/bin/docker', imageId: imageId!, workspaceRoot, uid: os.uid, gid: os.gid,
      memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
      deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
    const original = new DockerSupervisor(options); const profile = await original.captureProfile(); const snapshot = structuredClone(options);
    options.memoryBytes *= 2;
    expect(profile.parameters.options).toEqual(snapshot); expect(Object.isFrozen(profile.parameters.options)).toBe(true);
    expect(profile.adapterVersion).toBe(3); expect(profile.parameters.isolation).toEqual({ schemaVersion: 1, network: 'none', egress: { kind: 'none' } });
    expect(profile.parameters.endpoint).toMatch(/^unix:\/\/\//);
    const originalHost = process.env.DOCKER_HOST; const originalContext = process.env.DOCKER_CONTEXT;
    let restored: DockerSupervisor;
    try {
      process.env.DOCKER_HOST = 'unix:///tmp/deckent-profile-missing.sock';
      process.env.DOCKER_CONTEXT = 'deckent-profile-missing-context';
      restored = await DockerSupervisor.restoreProfile(JSON.parse(JSON.stringify(profile)), async (command, signal) => {
        expect(command.args.slice(0, 2)).toEqual(['--host', profile.parameters.endpoint]);
        return runNodeDockerCommand(command, signal);
      });
      expect(await restored.captureProfile()).toEqual(profile);
    } finally {
      if (originalHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = originalHost;
      if (originalContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = originalContext;
    }
    expect(await restored.captureProfile()).toEqual(profile);
    const changed = JSON.parse(JSON.stringify(profile)); changed.parameters.origin.daemonId = 'foreign-daemon';
    await expect(DockerSupervisor.restoreProfile(changed)).rejects.toMatchObject({ code: 'SUPERVISOR_PROFILE_ORIGIN_MISMATCH' });
    changed.parameters.origin.hostname = 'foreign-host';
    let commands = 0;
    await expect(DockerSupervisor.restoreProfile(changed, async () => { commands++; throw new Error('must not contact daemon'); })).rejects.toMatchObject({ code: 'SUPERVISOR_PROFILE_ORIGIN_MISMATCH' });
    expect(commands).toBe(0);
    const invalid = JSON.parse(JSON.stringify(profile)); invalid.parameters.options.secret = 'not-accepted';
    await expect(DockerSupervisor.restoreProfile(invalid)).rejects.toMatchObject({ code: 'SUPERVISOR_PROFILE_INVALID' });
    await expect(DockerSupervisor.restoreProfile({ ...profile, adapterVersion: 1 })).rejects.toMatchObject({ code: 'SUPERVISOR_PROFILE_INVALID' });
    // alpha.56 D2: a record written before the isolation block (v2) still restores; a v3 record without its block is invalid.
    const legacy = JSON.parse(JSON.stringify(profile.parameters)) as Record<string, unknown>; delete legacy['isolation'];
    await expect(DockerSupervisor.restoreProfile({ ...profile, adapterVersion: 2, parameters: legacy })).resolves.toBeInstanceOf(DockerSupervisor);
    await expect(DockerSupervisor.restoreProfile({ ...profile, parameters: legacy })).rejects.toMatchObject({ code: 'SUPERVISOR_PROFILE_INVALID' });
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
}, 15000);

// Audit 8328ff4a9 (alpha.56 D2): a v3 block is valid only as the one its options derive — a socket-mounted connection is the provider gateway,
// none is no egress — so a record claiming less (or other) than its options give proves nothing: recovery reads null, restore stops before the daemon.
it.skipIf(process.platform !== 'linux')('a v3 isolation block that is not the one derived from its options is invalid', async () => {
  const os = userInfo(), none = { schemaVersion: 1, network: 'none', egress: { kind: 'none' } }, gateway = { ...none, egress: { kind: 'provider-gateway', provider: 'anthropic' } };
  const connection = { schemaVersion: 1, socketPath: '/run/deckent/c.sock', bootstrapPath: '/run/deckent/b.mjs', bootstrapSha256: 'b'.repeat(64), provider: 'anthropic' };
  const profile = (isolation: unknown, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, adapterId: 'docker', adapterVersion: 3, parameters: { endpoint: 'unix:///var/run/docker.sock',
    options: { executable: '/usr/bin/docker', imageId: `sha256:${'a'.repeat(64)}`, workspaceRoot: '/tmp/deckent-profile', uid: 1000, gid: 1000, ...extra },
    origin: { hostname: hostname(), platform: platform(), architecture: arch(), uid: os.uid, gid: os.gid, daemonId: 'daemon' }, isolation } });
  expect(recordedWorkerIsolation(profile(none))).toEqual(none);
  expect(recordedWorkerIsolation(profile(gateway, { connection }))).toEqual(gateway);
  for (const [isolation, extra] of [[none, { connection }], [gateway, {}], [{ ...none, network: 'bridge' }, {}]] as const) {
    expect(recordedWorkerIsolation(profile(isolation, extra)), JSON.stringify(isolation)).toBeNull();
    let commands = 0;
    await expect(DockerSupervisor.restoreProfile(profile(isolation, extra), async () => { commands++; throw new Error('must not contact daemon'); }))
      .rejects.toMatchObject({ code: 'SUPERVISOR_PROFILE_INVALID' });
    expect(commands).toBe(0);
  }
});

// COMPOSITION-BUDGET-2: the lazy recorded-custody supervisor is the Docker adapter's (moved from the runs composition).
it('restores a recorded supervisor lazily: its profile is answered without the daemon, an invalid profile is refused at once', async () => {
  const profile = { schemaVersion: 1 as const, adapterId: 'no-such-adapter', adapterVersion: 1, parameters: {} };
  const recorded = recordedDockerSupervisor(profile);
  expect(await recorded.captureProfile()).toEqual(profile);
  // First use restores; a profile of another adapter is rejected by the Docker restore, never run.
  await expect(recorded.observe({} as never)).rejects.toThrow();
  expect(() => recordedDockerSupervisor({ ...profile, schemaVersion: 2 } as never)).toThrow();
});

// U9-7c `worker-relay-profile-custody`: a SIWC relay worker records adapter v4 with the v2 private-model-relay isolation derived from its options;
// a v3 meaning, a mismatched block or a missing relay is never read as proven, and the record carries nonsecret handles only.
it.skipIf(process.platform !== 'linux')('records a relay worker as v4 / isolation v2 and refuses every mismatched or downcast relay record', async () => {
  const os = userInfo(), A = 'synthetic-upstream-access-canary-A', C = 'synthetic-relay-capability-canary-C';
  const relay = { schemaVersion: 1, socketPath: '/run/deckent/r.sock', bootstrapPath: '/run/deckent/b.mjs', bootstrapSha256: 'b'.repeat(64), helperPath: '/run/deckent/h.mjs',
    helperSha256: 'c'.repeat(64), hardeningPath: '/run/deckent/n.node', hardeningSha256: 'f'.repeat(64), policySha256: 'd'.repeat(64), bindingSha256: 'e'.repeat(64) };
  const isolation = { schemaVersion: 2, network: 'none', egress: { kind: 'private-model-relay', provider: 'siwc', policySha256: 'd'.repeat(64), bindingSha256: 'e'.repeat(64) } };
  const options = { executable: '/usr/bin/docker', imageId: `sha256:${'a'.repeat(64)}`, workspaceRoot: '/tmp/deckent-profile', uid: os.uid, gid: os.gid,
    memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
  const captured = await new DockerSupervisor({ ...options, relay }, async command => ({ stdout: command.args[0] === 'info' || command.args[2] === 'info' ? 'daemon\n'
    : JSON.stringify({ Host: 'unix:///var/run/docker.sock' }), stderr: '' })).captureProfile();
  expect(captured.adapterVersion).toBe(4); expect(captured.parameters.isolation).toEqual(isolation);
  expect(recordedWorkerIsolation(captured)).toEqual(isolation); expect(workerIsolationProven(recordedWorkerIsolation(captured))).toBe(true);
  const text = JSON.stringify(captured); expect(text).not.toContain(A); expect(text).not.toContain(C);
  const variant = (version: number, block: unknown, withRelay = true) => ({ ...captured, adapterVersion: version,
    parameters: { ...captured.parameters, isolation: block, options: withRelay ? captured.parameters.options : options } });
  for (const [label, record] of [['v3 meaning', variant(3, isolation)], ['v1 block', variant(4, { schemaVersion: 1, network: 'none', egress: { kind: 'none' } })],
    ['other binding', variant(4, { ...isolation, egress: { ...isolation.egress, bindingSha256: 'f'.repeat(64) } })], ['no relay', variant(4, isolation, false)]] as const) {
    expect(recordedWorkerIsolation(record), label).toBeNull(); expect(workerIsolationProven(recordedWorkerIsolation(record)), label).toBe(false);
  }
  expect(() => new DockerSupervisor({ ...options, relay, connection: { schemaVersion: 1, socketPath: '/run/c.sock', bootstrapPath: '/run/b.mjs', bootstrapSha256: 'b'.repeat(64), provider: 'codex' } }))
    .toThrow();
});
