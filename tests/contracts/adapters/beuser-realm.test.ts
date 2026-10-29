import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { verifiedPrincipalSchema, beuserEvaluatorPrincipalRef } from '#domain/index.js';
import { beuserBindingSchema } from '#domain/core/beuser/index.js';
import { pinBeuserLimits, BEUSER_ARRANGE_REGISTRY, type BeuserContext } from '#engine/core/beuser-contract/index.js';
import { BeuserRealmApplication, createBeuserRealmSeal, beuserBindingDigest, type BeuserRealmCustody, type BeuserRealmHandle, type BeuserRealmLease, type BeuserRealmRuntime } from '#engine/core/beuser-realm/index.js';
import { DockerBeuserRealmRuntime, canonicalRealmPath, pinRealmOptions, inspectBeuserRealm, BEUSER_REALM_RECIPE, probeBeuserSystemd, type BeuserRealmCommand, type BeuserEvidenceRetention } from '#adapters/core/beuser-realm/index.js';
import { readlink } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { measureInstalledPackage } from '#adapters/core/installation-artifacts/index.js';
import { readBeuserCandidate, verifyBeuserDistribution, createBeuserArrange } from '#adapters/core/beuser-realm/index.js';
import { execFileSync } from 'node:child_process';
import { sha256, redactForRecord } from '#platform/index.js';

const retain: BeuserEvidenceRetention = async (_context, evidence) => `fixture-retained:${evidence.digest}`;
const roots: string[] = [];
const packageLimits = { maxFiles: 32, maxFileBytes: 16384, maxTotalBytes: 65536, maxDepth: 8 };
async function distributionFixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'beuser-distribution-'))); roots.push(base);
  const root = join(base, 'package'), controllerRoot = join(base, 'controller');
  await mkdir(join(root, 'dist'), { recursive: true }); await mkdir(controllerRoot, { mode: 0o700 });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1', files: ['dist'] }));
  return { root, controllerRoot, target: join(root, 'dist/index.js') };
}
async function distribution(root: string) {
  const measured = await measureInstalledPackage(root, packageLimits);
  const files = measured.files.map(({ path, sha256, size }) => ({ path, sha256, size }));
  return { files, digest: sha256(JSON.stringify(files)) };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function context(): BeuserContext {
  return { binding: beuserBindingSchema.parse({ schemaVersion: 1, identity: { scopeId: 'scope', runId: 'run', taskId: 'task', attemptId: 'attempt', generation: 1, layoutRevision: 'layout' },
    candidate: { adapter: 'package', version: 'fixture', evidenceRef: 'fixture', stateDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) },
    candidateDigest: 'c'.repeat(64), personaDigest: 'd'.repeat(64), journeyDigest: 'e'.repeat(64), rubricDigest: 'f'.repeat(64),
    realmId: 'realm', nonce: '12345678-1234-4234-8234-123456789abc', transcriptId: 'transcript' }),
  principal: verifiedPrincipalSchema.parse({ id: 'evaluator', ...beuserEvaluatorPrincipalRef({ issuer: 'fixture', subject: 'owner' }), assurance: 'workload-verified', scopeIds: ['scope'] }),
  signal: new AbortController().signal, limits: pinBeuserLimits({ schemaVersion: 1, revision: 'fixture', source: 'fixture', provisional: true,
    maxSteps: 10, maxWallMs: 10000, maxWaitMs: 1000, maxCalls: 2, maxTokens: 100, maxCost: 1, currency: 'USD', maxReruns: 1,
    maxTranscriptBytes: 10000, maxArtifactBytes: 10000, cleanupDeadlineMs: 1000, criticalRepetitions: 1 }) };
}
function harness(ctx = context()) {
  let lease: BeuserRealmLease | null = null;
  const handle = { binding: ctx.binding, containerId: 'a'.repeat(64), incarnation: '22345678-1234-4234-8234-123456789abc', controlDirectory: '/fixture/private', controlIdentity: '1:2' };
  const custody: BeuserRealmCustody = {
    reserve: vi.fn(async c => { if (lease) throw new Error('already claimed'); lease = { handle: null, observation: { binding: c.binding, state: 'unknown', evidenceRefs: [] } }; }),
    publish: vi.fn(async (_c, h) => { lease = { handle: h, observation: lease!.observation }; }),
    load: vi.fn(async () => lease), settle: vi.fn(async (_c, observation) => { lease = { handle: lease!.handle, observation }; }),
  };
  const runtime: BeuserRealmRuntime = {
    create: vi.fn(async (_c, publish) => { await publish(handle); return handle; }),
    inspect: vi.fn(async () => ({ valid: true, evidenceRefs: ['fixture-readback'] })),
    remove: vi.fn(async () => ({ processesAbsent: true, cgroupAbsent: true, filesystemAbsent: true, evidenceRefs: ['fixture-absence'] })),
  };
  return { ctx, handle, custody, runtime, app: new BeuserRealmApplication(runtime, custody) };
}
it('admits only retained binding and fresh inspection; arrange exec is TTY-less after admission; cleanup works after cancellation and cannot reuse a terminal realm', async () => {
  const h = harness(); const made = await h.app.create(h.ctx);
  expect((await h.app.admit(h.ctx, made)).state).toBe('admitted');
  const cancelled = AbortSignal.abort();
  expect((await h.app.destroy({ ...h.ctx, signal: cancelled })).state).toBe('destroyed');
  expect(h.runtime.remove).toHaveBeenCalledOnce();
  await expect(h.app.create(h.ctx)).rejects.toThrow('already claimed');
  expect(h.runtime.create).toHaveBeenCalledOnce();
  await expect(h.app.admit(h.ctx, made)).rejects.toMatchObject({ code: 'BEUSER_TARGET_NOT_SANDBOX' });
  {
    const r = harness(), fresh = await r.app.create(r.ctx), calls: string[][] = [], step = BEUSER_ARRANGE_REGISTRY.steps[0]!;
    if (step.kind === 'check') throw new Error('fixture: the first catalog step has an effect');
    const options = { controllerRoot: '/fixture/controller', packageRoot: '/fixture/package', executable: '/usr/bin/docker', image: 'sha256:' + 'a'.repeat(64),
      uid: 1000, gid: 1001, memoryBytes: 1048576, nanoCpus: 1000000000, pids: 10, filesystemBytes: 1048576 };
    const command: BeuserRealmCommand = async args => { calls.push([...args]);
      return JSON.stringify(args.includes(JSON.stringify([step, r.ctx.limits.maxArtifactBytes])) ? { exitCode: 0, stdoutBytes: 1, stdoutDigest: '0'.repeat(64) } : 'installed'); };
    const arrange = createBeuserArrange({ realm: r.app, custody: r.custody, options, language: 'tr', command });
    await expect(arrange.run(r.ctx, step)).rejects.toMatchObject({ code: 'BEUSER_TARGET_NOT_SANDBOX' });
    expect(calls).toEqual([]);
    await r.app.admit(r.ctx, fresh);
    expect(await arrange.run(r.ctx, step)).toEqual({ exitCode: 0, stdoutBytes: 1, stdoutDigest: '0'.repeat(64) });
    expect(await arrange.observe(r.ctx, step.readback)).toBe('installed');
    for (const args of calls) {
      expect(args.slice(0, 4)).toEqual(['container', 'exec', '--user', '1000:1001']);
      expect(args.slice(0, args.indexOf(r.handle.containerId)).filter(arg => /^-(i|t|it|ti)$|^--(interactive|tty)/u.test(arg))).toEqual([]);
      expect(args.join('\n')).not.toMatch(/pty-driver|TERM=/u);
    }
    const exec = calls[0]!, at = exec.indexOf(r.handle.containerId);
    expect(exec.slice(0, at).join(' ')).toContain('--env LANG=tr --env LC_ALL=tr --env HOME=/realm/home --env DECKENT_GLOBAL_HOME=/realm/home/.deckent');
    // The exact in-realm wrappers, pointed at a probe instead of the packaged CLI and at a temporary work target instead of /realm.
    const [node, ...tail] = exec.slice(at + 1), entry = `${BEUSER_REALM_RECIPE.packageTarget}/dist/composition/core/cli/internal/entry.js`;
    expect(node).toBe(BEUSER_REALM_RECIPE.nodeExecutable);
    const script = tail[tail.indexOf('--eval') + 1]!, base = await realpath(await mkdtemp(join(tmpdir(), 'beuser-arrange-'))), work = join(base, 'realm'); roots.push(base);
    expect(script.split(entry)).toHaveLength(2);
    await mkdir(work);
    const local = (text: string) => text.replace(entry, join(base, 'probe.mjs')).replaceAll(JSON.stringify(BEUSER_REALM_RECIPE.workTarget), JSON.stringify(work));
    const observeScript = calls[1]!.at(-2)!, wrap = (value: unknown) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', local(script),
      JSON.stringify([value, 4096])], { input: 'y\n', encoding: 'utf8' })) as { exitCode: number | null };
    const look = (readback: unknown) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', local(observeScript), JSON.stringify(readback)], { encoding: 'utf8' })) as unknown;
    // Offered input never reaches the child, no terminal, exit code returned.
    const seen = JSON.stringify({ tty: false, stdin: 0 });
    await writeFile(join(base, 'probe.mjs'), "import { readFileSync } from 'node:fs'; process.stdout.write(JSON.stringify({ tty: Boolean(process.stdin.isTTY || process.stdout.isTTY), stdin: readFileSync(0).length })); process.exit(7);");
    expect(wrap({ kind: 'cli', args: ['init', '--json'], timeoutMs: 5000 })).toEqual({ exitCode: 7, stdoutBytes: Buffer.byteLength(seen), stdoutDigest: sha256(seen) });
    // Fixture files and Git stay inside the work target: written with their mode; never through a symlink, a symlinked parent or `..`.
    const notes = BEUSER_ARRANGE_REGISTRY.steps.find(row => row.id === 'team-notes')!;
    expect(wrap(notes)).toEqual({ exitCode: 0, stdoutBytes: 0, stdoutDigest: sha256('') });
    expect(look({ kind: 'path', path: join(work, '.deckent/team-notes.md'), expected: { state: 'file' } })).toEqual(
      { state: 'file', mode: '0644', sha256: (notes.readback.expected as { sha256: string }).sha256 });
    expect(look({ kind: 'path', path: join(work, 'missing'), expected: { state: 'absent' } })).toEqual({ state: 'absent' });
    await symlink(base, join(work, 'escape')); await symlink(join(base, 'target.md'), join(work, 'link.md'));
    for (const path of ['escape/out.md', 'link.md', '../out.md']) expect(wrap({ ...notes, path }).exitCode).toBe(1);
    for (const name of ['out.md', 'target.md']) expect(look({ kind: 'path', path: join(base, name), expected: { state: 'absent' } })).toEqual({ state: 'absent' });
    for (const id of ['git-repository', 'team-notes-tracked', 'team-notes-committed']) expect(wrap(BEUSER_ARRANGE_REGISTRY.steps.find(row => row.id === id))).toMatchObject({ exitCode: 0 });
    expect(look({ kind: 'git', path: '.deckent/team-notes.md', expected: 'tracked' })).toBe('tracked');
    expect(look({ kind: 'git', path: 'link.md', expected: 'tracked' })).toBe('untracked');
  }
});
it('refuses wrong nonce/generation and forged observations before runtime inspection even with the admitted evaluator', async () => {
  const h = harness(); const made = await h.app.create(h.ctx);
  for (const binding of [{ ...h.ctx.binding, nonce: '32345678-1234-4234-8234-123456789abc' },
    { ...h.ctx.binding, identity: { ...h.ctx.binding.identity, generation: 2 } }, { ...h.ctx.binding, realmId: 'foreign' }]) {
    await expect(h.app.admit({ ...h.ctx, binding }, { ...made, binding })).rejects.toMatchObject({ code: 'BEUSER_TARGET_NOT_SANDBOX' });
  }
  await expect(h.app.admit(h.ctx, { ...made, binding: { ...made.binding, nonce: '' } })).rejects.toThrow();
  expect(h.runtime.inspect).not.toHaveBeenCalled();
});
it('quarantines changed isolation, unknown cleanup and cleanup timeout; reconciles launcher loss without creation retry', async () => {
  const h = harness(); const made = await h.app.create(h.ctx);
  vi.mocked(h.runtime.inspect).mockResolvedValue({ valid: false, evidenceRefs: ['fixture-drift'] });
  await expect(h.app.admit(h.ctx, made)).rejects.toMatchObject({ code: 'BEUSER_TARGET_NOT_SANDBOX' });
  vi.mocked(h.runtime.remove).mockResolvedValue({ processesAbsent: true, cgroupAbsent: false, filesystemAbsent: true, evidenceRefs: ['fixture-partial'] });
  expect((await h.app.destroy(h.ctx)).state).toBe('quarantined');
  vi.mocked(h.runtime.remove).mockRejectedValue(new Error('fixture cleanup timeout'));
  expect((await h.app.reconcile(h.ctx)).state).toBe('quarantined');
  vi.mocked(h.runtime.remove).mockResolvedValue({ processesAbsent: true, cgroupAbsent: true, filesystemAbsent: true, evidenceRefs: ['fixture-absence'] });
  expect((await h.app.reconcile(h.ctx)).state).toBe('destroyed');
  expect(h.runtime.create).toHaveBeenCalledOnce();
});
it('partial create retains immutable custody and cleans through it instead of guessing a process name', async () => {
  const h = harness();
  vi.mocked(h.runtime.create).mockImplementation(async (_c, publish) => { await publish(h.handle); throw new Error('lost launcher'); });
  await expect(h.app.create(h.ctx)).rejects.toThrow('lost launcher');
  expect(h.runtime.remove).toHaveBeenCalledWith(expect.anything(), h.handle);
  expect((await h.app.observe(h.ctx)).state).toBe('destroyed');
});
it('rejects symlinks/traversal and missing finite resource config before Docker; generated allocation is published before launch', async () => {
  if (process.platform !== 'linux') { expect(() => pinRealmOptions({})).toThrow(); console.info('verify-not-run: Linux realm positive path'); return; }
  const base = await realpath(await mkdtemp(join(tmpdir(), 'beuser-realm-'))); roots.push(base);
  const controllerRoot = join(base, 'controller'), packageRoot = join(base, 'package');
  await mkdir(controllerRoot, { mode: 0o700 }); await mkdir(packageRoot); await symlink(packageRoot, join(base, 'alias'));
  await expect(canonicalRealmPath(join(base, 'alias'), 'directory')).rejects.toMatchObject({ code: 'BEUSER_TARGET_NOT_SANDBOX' });
  await expect(canonicalRealmPath(packageRoot + '/../package', 'directory')).rejects.toMatchObject({ code: 'BEUSER_TARGET_NOT_SANDBOX' });
  expect(() => pinRealmOptions({})).toThrow('BEUSER_TARGET_NOT_SANDBOX');
  const order: string[] = [], ctx = context();
  const command: BeuserRealmCommand = async args => {
    order.push(args[1]!);
    if (args[1] === 'create') { await writeFile(args[args.indexOf('--cidfile') + 1]!, 'a'.repeat(64), { mode: 0o600 }); return 'a'.repeat(64); }
    return '';
  };
  const runtime = new DockerBeuserRealmRuntime({ controllerRoot, packageRoot, executable: '/usr/bin/docker', image: 'sha256:' + 'a'.repeat(64),
    uid: 1000, gid: 1000, memoryBytes: 1048576, nanoCpus: 1000000000, pids: 10, filesystemBytes: 1048576 },
  { retainEvidence: retain, verifyPackage: async () => true, removalEvidence: async () => ({ processesAbsent: false, cgroupAbsent: false, filesystemAbsent: false, evidenceRefs: [] }) }, command);
  const handles: BeuserRealmHandle[] = [];
  const handle = await runtime.create(ctx, async value => { order.push('publish'); handles.push(value); });
  expect(order).toEqual(['publish', 'create', 'publish', 'start']);
  expect(handles[0]?.containerId).toBe(''); expect(handle.containerId).toBe('a'.repeat(64));
  expect(handle.binding.nonce).toBe(ctx.binding.nonce);
});
it('inspection proves uid/namespaces/network/mounts/cgroup and refuses each distinct host escape despite an approved creation', async () => {
  if (process.platform !== 'linux') { console.info('verify-not-run: namespace readback requires Linux'); return; }
  const h = harness(), ctx = h.ctx, recipe = BEUSER_REALM_RECIPE;
  const options = { controllerRoot: '/fixture', packageRoot: '/package-fixture', executable: '/usr/bin/docker', image: 'sha256:' + 'a'.repeat(64),
    uid: 1000, gid: 1000, memoryBytes: 1048576, nanoCpus: 1000000000, pids: 10, filesystemBytes: 1048576 };
  const ns = Object.fromEntries(await Promise.all(['mnt', 'pid', 'net', 'ipc', 'uts', 'cgroup'].map(async key => [key, (await readlink(`/proc/self/ns/${key}`)) + '-private'])));
  const inspect = { Id: h.handle.containerId, Image: options.image, State: { Running: true, Pid: 123, StartedAt: 'fixture' },
    Config: { User: '1000:1000', Env: [], Labels: { 'deckent.beuser.binding': beuserBindingDigest(ctx.binding), 'deckent.beuser.incarnation': h.handle.incarnation } },
    HostConfig: { NetworkMode: 'none', Privileged: false, ReadonlyRootfs: true, CapAdd: null, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
      PidMode: '', IpcMode: 'private', UTSMode: '', CgroupnsMode: 'private', Memory: options.memoryBytes, MemorySwap: options.memoryBytes, NanoCpus: options.nanoCpus,
      PidsLimit: options.pids, Devices: [], Binds: null, Tmpfs: { '/realm': 'fixture', '/tmp': 'fixture' } },
    Mounts: [{ Type: 'bind', Source: options.packageRoot, Destination: recipe.packageTarget, RW: false },
      { Type: 'bind', Source: h.handle.controlDirectory + '/genesis.json', Destination: recipe.genesisTarget, RW: false }], NetworkSettings: { Networks: { none: {} }, Ports: {} } };
  const probe = { uid: 1000, gid: 1000, status: { NoNewPrivs: '1', CapEff: '00000000', CapPrm: '00000000', CapBnd: '00000000', CapAmb: '00000000', CapInh: '00000000', Seccomp: '2' }, ns, ptsDevice: 'fixture-private-device',
    mounts: [`1 0 0:1 / ${recipe.packageTarget} ro - bind fixture ro`, `2 0 0:1 / ${recipe.genesisTarget} ro - bind fixture ro`,
      '3 0 0:1 / /dev/pts rw - devpts devpts rw', '4 0 0:1 / /realm rw - tmpfs tmpfs rw'].join('\n'),
    cgroup: { memory: '1048576', pids: '10', cpu: '100000 100000' }, net: ['lo'], genesis: createBeuserRealmSeal(ctx.binding) };
  const command: BeuserRealmCommand = async args => JSON.stringify(args[1] === 'inspect' ? [inspect] : probe);
  const first = await inspectBeuserRealm(ctx, h.handle, options, command, retain);
  expect(first.valid).toBe(true);
  await expect(inspectBeuserRealm(ctx, h.handle, options, command, async () => { throw new Error('evidence unavailable'); })).rejects.toThrow('evidence unavailable');
  inspect.Config.Env = ['UNRELATED=synthetic-private-image-value'];
  Object.assign(inspect.Config.Labels, { unrelated: 'synthetic-private-label' });
  expect((await inspectBeuserRealm(ctx, h.handle, options, command, retain)).evidenceRefs).toEqual(first.evidenceRefs);
  for (const mutation of [() => { inspect.HostConfig.NetworkMode = 'host'; }, () => { inspect.HostConfig.Privileged = true; },
    () => { inspect.Mounts.push({ Type: 'bind', Source: '/host/home', Destination: '/foreign', RW: false }); },
    () => { inspect.Config.Labels['deckent.beuser.incarnation'] = 'wrong'; }, () => { probe.uid = 0; },
    () => { probe.net = ['lo', 'eth0']; }, () => { probe.cgroup.memory = 'max'; }, () => { probe.status.NoNewPrivs = '0'; }]) {
    const originalInspect = structuredClone(inspect), originalProbe = structuredClone(probe); mutation();
    await expect(inspectBeuserRealm(ctx, h.handle, options, command, retain)).rejects.toMatchObject({ code: 'BEUSER_TARGET_NOT_SANDBOX' });
    Object.assign(inspect, originalInspect); Object.assign(probe, originalProbe);
  }
});
it('Docker cleanup refuses foreign incarnation, retains uncertain removal and reconciles the exact id without reuse', async testContext => {
  if (process.platform !== 'linux') { testContext.skip('verify-not-run: Linux Docker adapter fixture'); return; }
  const base = await realpath(await mkdtemp(join(tmpdir(), 'beuser-cleanup-'))); roots.push(base);
  const controllerRoot = join(base, 'controller'), packageRoot = join(base, 'package');
  await mkdir(controllerRoot, { mode: 0o700 }); await mkdir(packageRoot);
  const ctx = context(), log: string[][] = [];
  // Mutable fixture transport is trusted supervisor I/O, never persona output or a real isolation receipt.
  let foreign = false, gone = false, certain = false;
  let handle: BeuserRealmHandle;
  const command: BeuserRealmCommand = async args => {
    log.push([...args]);
    if (args[1] === 'create') { await writeFile(args[args.indexOf('--cidfile') + 1]!, 'b'.repeat(64), { mode: 0o600 }); return 'b'.repeat(64); }
    if (args[1] === 'inspect') {
      if (gone) throw new Error('fixture backend unavailable');
      return JSON.stringify([{ Id: handle.containerId, Config: { Labels: { 'deckent.beuser.binding': beuserBindingDigest(ctx.binding),
        'deckent.beuser.incarnation': foreign ? 'foreign' : handle.incarnation } } }]);
    }
    if (args[1] === 'rm') gone = true;
    return '';
  };
  const runtime = new DockerBeuserRealmRuntime({ controllerRoot, packageRoot, executable: '/usr/bin/docker', image: 'sha256:' + 'a'.repeat(64),
    uid: 1000, gid: 1000, memoryBytes: 1048576, nanoCpus: 1000000000, pids: 10, filesystemBytes: 1048576 },
  { retainEvidence: retain, verifyPackage: async () => true, removalEvidence: async () => ({ processesAbsent: true, cgroupAbsent: certain, filesystemAbsent: certain, evidenceRefs: ['fixture-proof'] }) }, command);
  handle = await runtime.create(ctx, async value => { handle = value; });
  foreign = true;
  await expect(runtime.remove(ctx, handle)).rejects.toMatchObject({ code: 'BEUSER_TARGET_NOT_SANDBOX' });
  expect(log.filter(args => args[1] === 'rm')).toHaveLength(0);
  foreign = false;
  expect((await runtime.remove(ctx, handle)).cgroupAbsent).toBe(false);
  expect(log.find(args => args[1] === 'rm')).toEqual(['container', 'rm', '--force', '--volumes', handle.containerId]);
  expect(await realpath(handle.controlDirectory)).toBe(handle.controlDirectory);
  certain = true;
  // An arbitrary inspect failure is not promoted to absence, even when the removal callback would claim it.
  await expect(runtime.remove(ctx, handle)).rejects.toThrow('fixture backend unavailable');
  expect(log.filter(args => args[1] === 'rm')).toHaveLength(1);
});


it('private systemd capability remains unknown on a failed probe; no privilege or host bus option is introduced', async () => {
  const h = harness(); await h.app.create(h.ctx);
  const command = vi.fn<BeuserRealmCommand>(async () => { throw new Error('private user manager unavailable'); });
  expect(await probeBeuserSystemd(h.ctx, h.handle, command)).toEqual({ state: 'unknown', evidenceRefs: [], branches: ['S2-systemd', 'S4', 'S4b/K4'] });
  const args = command.mock.calls[0]![0];
  expect(args.slice(0, 3)).toEqual(['container', 'exec', h.handle.containerId]);
  expect(args).not.toContain('--privileged'); expect(args).not.toContain('--cap-add');
});

it('accepts ordinary assignments and vendor private-key header constants while record redaction still masks assignments', async () => {
  const { root, target } = await distributionFixture();
  const source = 'const token=value; const secret=options.secret; const pemHeader="-----BEGIN PRIVATE KEY-----";';
  await writeFile(target, source);
  const { files, digest } = await distribution(root);
  expect(await verifyBeuserDistribution(root, files, packageLimits, digest)).toBe(true);
  expect(redactForRecord('token=fictitious-value')).toBe('token=[REDACTED]');
});

it.skipIf(process.platform !== 'linux')('refuses credential-bearing, foreign and missing packages with the typed realm code before any launch', async () => {
  const { root, target, controllerRoot } = await distributionFixture(), ctx = context();
  await writeFile(target, 'export {};');
  const clean = await distribution(root);
  expect(await verifyBeuserDistribution(root, clean.files, packageLimits, clean.digest)).toBe(true);
  const command = vi.fn<BeuserRealmCommand>(), publish = vi.fn();
  const refused = async (files: typeof clean.files, digest: string) => {
    expect(await verifyBeuserDistribution(root, files, packageLimits, digest)).toBe(false);
    const runtime = new DockerBeuserRealmRuntime({ controllerRoot, packageRoot: root, executable: '/usr/bin/docker', image: 'sha256:' + 'a'.repeat(64),
      uid: 1000, gid: 1000, memoryBytes: 1048576, nanoCpus: 1000000000, pids: 10, filesystemBytes: 1048576 },
    { retainEvidence: retain, verifyPackage: (_context, path) => verifyBeuserDistribution(path, files, packageLimits, digest),
      removalEvidence: async () => ({ processesAbsent: false, cgroupAbsent: false, filesystemAbsent: false, evidenceRefs: [] }) }, command);
    await expect(runtime.create(ctx, publish)).rejects.toMatchObject({ code: 'BEUSER_TARGET_NOT_SANDBOX' });
    expect(command).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  };
  // Re-pin each planted credential: a hash mismatch must not be the reason for its refusal.
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  for (const content of ['sk-ant-fictitiousprovider', 'glpat-' + 'F'.repeat(20), 'ASIAABCDEFGHIJKLMNOP',
    'aws_secret_access_key=' + 'A'.repeat(40), 'sk_live_' + 'F'.repeat(16), 'xapp-' + 'F'.repeat(8),
    'pypi-' + 'F'.repeat(50), 'AccountKey=' + 'F'.repeat(20), 'Bearer fictitious-bearer-0123456789',
    'https://test:fictional-password@example.invalid/p', 'eyJfictional.payload.signature', pem,
    JSON.stringify({ privateKey: pem }), rsa]) {
    await writeFile(target, content); const { files, digest } = await distribution(root); await refused(files, digest);
  }
  await writeFile(target, 'export {};');
  await writeFile(join(root, 'foreign.txt'), 'foreign'); await refused(clean.files, clean.digest);
  await rm(join(root, 'foreign.txt')); await rm(target); await refused(clean.files, clean.digest);
});


it('reloads the full candidate manifest, pins source identity and refuses tampering before realm admission', async () => {
  const { root, target } = await distributionFixture();
  await writeFile(target, 'export {};');
  const source = { sourceCommit: '1'.repeat(40), sourceTreeSha256: '2'.repeat(64) };
  await writeFile(join(root, 'dist/build-identity.json'), JSON.stringify(source));
  const initial = await measureInstalledPackage(root, packageLimits);
  const manifest = JSON.stringify(Object.fromEntries(initial.files.map(file => [file.path, `${file.sha256}:${file.mode.toString(8)}`])));
  await writeFile(join(root, 'manifest.json'), manifest);
  await writeFile(join(root, 'release.json'), JSON.stringify({ schemaVersion: 1, packageVersion: '1', ...source, manifestSha256: sha256(manifest) }));
  const measured = await measureInstalledPackage(root, packageLimits), full = await distribution(root);
  const reference = { sha256: sha256(manifest), fileCount: measured.files.length, ...source, version: '1' };
  const read = (pin = reference) => readBeuserCandidate(root, pin, packageLimits, measured.measurementDigest, full.digest);
  expect((await read()).files.map(file => file.path)).toContain('manifest.json');
  expect((await read()).files.map(file => file.path)).toContain('release.json');
  await expect(read({ ...reference, sourceCommit: '3'.repeat(40) })).rejects.toMatchObject({ code: 'BEUSER_CANDIDATE_MISMATCH' });
  await expect(read({ ...reference, sourceTreeSha256: '4'.repeat(64) })).rejects.toMatchObject({ code: 'BEUSER_CANDIDATE_MISMATCH' });
  await expect(read({ ...reference, version: 'other-candidate' })).rejects.toMatchObject({ code: 'BEUSER_CANDIDATE_MISMATCH' });
  await expect(read({ ...reference, fileCount: reference.fileCount - 1 })).rejects.toMatchObject({ code: 'BEUSER_CANDIDATE_MISMATCH' });
  await expect(read({ ...reference, sha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'BEUSER_CANDIDATE_MISMATCH' });
  await writeFile(join(root, 'manifest.json'), manifest + '\n');
  await expect(read()).rejects.toMatchObject({ code: 'BEUSER_CANDIDATE_MISMATCH' });
  await writeFile(join(root, 'manifest.json'), manifest);
  await writeFile(join(root, 'foreign.txt'), 'foreign');
  await expect(read()).rejects.toMatchObject({ code: 'BEUSER_CANDIDATE_MISMATCH' });
});
