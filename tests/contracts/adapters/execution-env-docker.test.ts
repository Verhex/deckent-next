import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCKER_APT, HOST_DOCKER_PORTS, dockerCardBody, dockerCommandLines, dockerInstallOffer, dockerPrintLines, dockerResultLines, dockerSourcesFile, observeDockerHost, planDockerInstall, runDockerInstall,
  stageDockerFiles, sudoEnvironment, verifyInstalledSource, type DockerHostFacts, type DockerHostPorts, type DockerInstallPlan, type DockerStepRun } from '#adapters/core/execution-env-docker/index.js';
import { EXECUTION_RUNTIMES, executionSetupFamily, type ExecutionFacts } from '#adapters/core/setup-detect-execution/index.js';
import { FIRST_RUN_EXECUTION_ENVIRONMENT_IDS, SetupStageRegistry, planSetup } from '#engine/index.js';

// I-D2 (INIT-D2, ANALYSIS §11(c) cond. 1–7): dated apt data with the pinned key, the pure planner, read-only probes, the foreground executor.
// sudo is never the real one here: every effect goes through a recording fake.

/** OpenPGP v4 fingerprint of the first public-key packet (RFC 9580 §5.5.4): SHA-1 over 0x99, a two-octet length and the packet body. */
function fingerprint(armored: readonly string[]): string {
  const body = armored.slice(armored.indexOf('') + 1).filter(line => !line.startsWith('=') && !line.startsWith('-----')).join('');
  const bytes = Buffer.from(body, 'base64'), tag = bytes[0]!;
  let length: number, offset: number;
  if (tag & 0x40) { expect(tag & 0x3f).toBe(6); [length, offset] = bytes[1]! < 192 ? [bytes[1]!, 2] : [((bytes[1]! - 192) << 8) + bytes[2]! + 192, 3]; }
  else { expect((tag >> 2) & 0x0f).toBe(6); const type = tag & 3; [length, offset] = type === 0 ? [bytes[1]!, 2] : type === 1 ? [bytes.readUInt16BE(1), 3] : [bytes.readUInt32BE(1), 5]; }
  const packet = bytes.subarray(offset, offset + length), head = Buffer.from([0x99, (length >> 8) & 0xff, length & 0xff]);
  return createHash('sha1').update(head).update(packet).digest('hex').toUpperCase();
}
const ubuntu = { ID: 'ubuntu', ID_LIKE: 'debian', VERSION_CODENAME: 'noble', UBUNTU_CODENAME: 'noble' };
const facts = (patch: Partial<DockerHostFacts> = {}): DockerHostFacts => ({ platform: 'linux', osRelease: ubuntu, architecture: 'amd64', desktop: false, conflicts: [],
  existingSource: null, network: true, user: 'alice', unknown: [], ...patch });
const install = (plan: DockerInstallPlan) => { if (plan.kind !== 'install') throw new Error(`expected install, got ${plan.reason}`); return plan; };
const executionFacts = (cli: 'found' | 'absent' | 'unknown'): ExecutionFacts => ({ schemaVersion: 1, runtimes: [{ id: 'docker', label: 'Docker', support: 'supported', cli,
  path: null, version: null, daemon: 'not-run', serverVersion: null, kind: null, endpoint: null, group: null }] });

describe('Docker apt registry (cond. 3, 7)', () => {
  it('the shipped key is the pinned one: OpenPGP v4 fingerprint and file digest recomputed from the armored key', () => {
    expect(fingerprint(DOCKER_APT.key.armored)).toBe(DOCKER_APT.key.fingerprint);
    expect(DOCKER_APT.key.fingerprint).toBe('9DC858229FC7DD38854AE2D88D81803C0EBFCD88');
    expect(createHash('sha256').update(`${DOCKER_APT.key.armored.join('\n')}\n`).digest('hex')).toBe(DOCKER_APT.key.sha256);
    expect(DOCKER_APT.checked).toBe('2026-10-19');
    expect(DOCKER_APT.distributions.map(entry => entry.url)).toEqual(['https://download.docker.com/linux/ubuntu', 'https://download.docker.com/linux/debian']);
  });
  it('one execution-environment id everywhere: this asset, the detection registry entry and the v13 policy seed', () => {
    expect(EXECUTION_RUNTIMES.filter(entry => entry.support === 'supported').map(entry => entry.id)).toEqual([DOCKER_APT.environment]);
    expect(FIRST_RUN_EXECUTION_ENVIRONMENT_IDS).toEqual([DOCKER_APT.environment]);
  });
});

describe('planner (cond. 3, 6)', () => {
  it('a supported release: the exact sudo steps, from the official repository only, no shell, no pipe, no download script', () => {
    const plan = install(planDockerInstall(facts(), '/tmp/deckent-docker-x'));
    expect(plan.source).toEqual({ distribution: 'ubuntu', codename: 'noble', architecture: 'amd64', url: 'https://download.docker.com/linux/ubuntu' });
    expect(dockerCommandLines(plan.steps)).toEqual([
      'sudo install -m 0755 -d /etc/apt/keyrings', 'sudo install -m 0644 /tmp/deckent-docker-x/docker.asc /etc/apt/keyrings/docker.asc',
      'sudo install -m 0644 /tmp/deckent-docker-x/docker.sources /etc/apt/sources.list.d/docker.sources', 'sudo apt-get update',
      'sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin', 'sudo usermod -aG docker alice']);
    expect(plan.steps.flatMap(step => step.argv).join(' ')).not.toMatch(/curl|wget|\bsh\b|bash|\||get\.docker\.com/u);
    expect(plan.steps.every(step => step.timeoutMs > 0)).toBe(true);
    expect(dockerSourcesFile(plan.source)).toBe('Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\n'
      + 'Signed-By: /etc/apt/keyrings/docker.asc\n');
    expect(install(planDockerInstall(facts({ osRelease: { ID: 'debian', VERSION_CODENAME: 'trixie' }, architecture: 'arm64' }), '/s')).source.codename).toBe('trixie');
  });
  it('every other case prints the honest next step and never installs', () => {
    const cases: Array<[Partial<DockerHostFacts>, string, boolean]> = [
      [{ platform: 'other' }, 'platform', false], [{ platform: 'wsl', desktop: true }, 'desktop', true],
      [{ osRelease: { ID: 'linuxmint', ID_LIKE: 'ubuntu', UBUNTU_CODENAME: 'noble' } }, 'distribution', false], [{ osRelease: { ...ubuntu, UBUNTU_CODENAME: 'focal', VERSION_CODENAME: 'focal' } }, 'distribution', false],
      [{ architecture: 'i386' }, 'distribution', false], [{ osRelease: null }, 'distribution', false], [{ conflicts: ['docker.io', 'runc'] }, 'conflicts', true],
      [{ existingSource: '/etc/apt/sources.list.d/docker.list' }, 'repository', true], [{ network: false }, 'network', true],
      // Astra 2672 R1: an unanswered host check refuses before conflicts/source/network are trusted.
      [{ unknown: ['dpkg-query'] }, 'probe', true], [{ unknown: ['/etc/apt/sources.list.d/docker.list'], network: true }, 'probe', true]];
    for (const [patch, reason, steps] of cases) {
      const plan = planDockerInstall(facts(patch), '/tmp/s');
      expect(plan, reason).toMatchObject({ kind: 'print', reason });
      expect(plan.steps !== null, reason).toBe(steps);
    }
    expect(planDockerInstall(facts(), null)).toMatchObject({ kind: 'print', reason: 'network' });
    const lines = dockerPrintLines(planDockerInstall(facts({ conflicts: ['docker.io'] }), '/tmp/s') as Extract<DockerInstallPlan, { kind: 'print' }>, 'tr');
    expect(lines[0]).toContain('docker.io');
    expect(lines.slice(1)).toEqual(dockerCommandLines(install(planDockerInstall(facts(), '/tmp/s')).steps).map(line => `  $ ${line}`));
  });
  it('the card shows every command, the source, the pinned key, the root-equivalent group, NOPASSWD and how to undo (EN and TR)', () => {
    const plan = install(planDockerInstall(facts(), '/tmp/s'));
    for (const locale of ['en', 'tr'] as const) {
      const body = dockerCardBody(plan, locale).join('\n');
      for (const line of dockerCommandLines(plan.steps)) expect(body).toContain(line);
      expect(body).toContain('9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88');
      expect(body).toContain('https://download.docker.com/linux/ubuntu');
      expect(body).toContain('root');
      expect(body).toContain('NOPASSWD');
      expect(body).toContain('apt-get purge docker-ce');
    }
  });
});

describe('read-only host probes', () => {
  const ports = (patch: Partial<DockerHostPorts> & { files?: Record<string, string> } = {}) => {
    const runs: string[][] = [], heads: string[] = [];
    const port: DockerHostPorts = { find: async name => `/usr/bin/${name}`, user: () => 'alice', platform: () => 'linux',
      read: async path => patch.files?.[path] ?? null, exists: async path => path in (patch.files ?? {}),
      reachable: async url => { heads.push(url); return true; },
      run: async (file, args) => { runs.push([file, ...args]); return file.endsWith('dpkg') ? { code: 0, stdout: 'amd64\n', stderr: '' }
        : { code: 1, stdout: 'docker.io ii \nrunc un \ncontainerd rc \n', stderr: 'dpkg-query: no packages found matching podman-docker' }; }, ...patch };
    return { port, runs, heads };
  };
  it('reads the release (quoted values), architecture and installed conflicts; HEADs only the signed release index; never runs anything privileged', async () => {
    const { port, runs, heads } = ports({ files: { '/etc/os-release': 'NAME="Ubuntu"\nID=ubuntu\nVERSION_CODENAME=noble\nUBUNTU_CODENAME="noble"\n' } });
    const observed = await observeDockerHost({ PATH: '/usr/bin' }, false, port);
    expect(observed).toMatchObject({ platform: 'linux', architecture: 'amd64', conflicts: ['docker.io'], existingSource: null, desktop: false, network: true, user: 'alice' });
    expect(observed.osRelease).toMatchObject({ ID: 'ubuntu', UBUNTU_CODENAME: 'noble', NAME: 'Ubuntu' });
    expect(heads).toEqual(['https://download.docker.com/linux/ubuntu/dists/noble/InRelease']);
    expect(runs.map(argv => argv[0])).toEqual(['/usr/bin/dpkg', '/usr/bin/dpkg-query']);
    expect(runs.flat().join(' ')).not.toMatch(/sudo|apt-get|install|usermod/u);
  });
  it('negative (Astra 2672 R1): a host check without a clean answer is never read as a clean host — print, zero privileged spawns', async () => {
    const files = { '/etc/os-release': 'ID=ubuntu\nVERSION_CODENAME=noble\n' };
    const planOf = async (patch: Partial<DockerHostPorts>) => { const observed = await observeDockerHost({ PATH: '/usr/bin' }, false, ports({ files, ...patch }).port);
      return { observed, plan: planDockerInstall(observed, '/tmp/s') }; };
    const answer = (result: { code: number | null; stdout: string }) => ports({ files, run: async file => file.endsWith('dpkg') ? { code: 0, stdout: 'amd64\n', stderr: '' }
      : { ...result, stderr: '' } }).port.run;
    const unanswered: Array<[string, Partial<DockerHostPorts>]> = [
      ['missing dpkg-query', { find: async name => name === 'dpkg-query' ? null : `/usr/bin/${name}` }],
      ['timeout/abort with partial stdout', { run: answer({ code: null, stdout: 'runc ii \n' }) }],
      ['dpkg-query exit 2', { run: answer({ code: 2, stdout: '' }) }],
      ['source file EACCES/EIO', { exists: async path => path.startsWith('/etc/apt/') ? null : false }]];
    for (const [label, patch] of unanswered) {
      const { observed, plan } = await planOf(patch);
      expect(observed.unknown.length, label).toBeGreaterThan(0);
      // An unanswered dpkg-query never contributes conflicts from its partial stdout (the default fake lists docker.io as installed).
      if (label !== 'source file EACCES/EIO') expect(observed.conflicts, label).toEqual([]);
      expect(plan, label).toMatchObject({ kind: 'print', reason: 'probe' });
    }
    expect(dockerPrintLines((await planOf({ run: answer({ code: 2, stdout: '' }) })).plan as Extract<DockerInstallPlan, { kind: 'print' }>, 'en')[0]).toContain('dpkg-query');
    // Held-installed and half-installed packages conflict; removed ones (rc) and never-installed ones (un) do not.
    expect((await planOf({ run: answer({ code: 0, stdout: 'containerd hi \nrunc iU \ndocker.io rc \npodman-docker un \n' }) })).observed.conflicts).toEqual(['containerd', 'runc']);
    // Controls: the normal "no package found" exit 1 is a clean answer (install offered); a real conflict prints conflicts.
    expect((await planOf({ run: answer({ code: 1, stdout: '' }) })).plan).toMatchObject({ kind: 'install' });
    expect((await planOf({ run: answer({ code: 0, stdout: 'docker.io ii \n' }) })).plan).toMatchObject({ kind: 'print', reason: 'conflicts' });
  });
  it('negative (review 2674 P2): the architecture counts only from a clean dpkg exit; stdout with a failed exit is no architecture (print only)', async () => {
    const files = { '/etc/os-release': 'ID=ubuntu\nVERSION_CODENAME=noble\n' };
    for (const code of [1, 2, null]) {
      const observed = await observeDockerHost({ PATH: '/usr/bin' }, false, ports({ files, run: async (file: string) => file.endsWith('dpkg')
        ? { code, stdout: 'amd64\n', stderr: '' } : { code: 1, stdout: '', stderr: '' } }).port);
      expect(observed.architecture, String(code)).toBeNull();
      expect(planDockerInstall(observed, '/tmp/s'), String(code)).toMatchObject({ kind: 'print', reason: 'distribution' });
    }
  });
  it('the host exists probe: present → true, ENOENT → false, anything else (EACCES) → null', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docker-exists-')), locked = join(root, 'locked');
    try {
      await writeFile(join(root, 'file'), ''); await mkdir(locked, { mode: 0o700 }); await writeFile(join(locked, 'inside'), ''); await chmod(locked, 0o000);
      const exists = HOST_DOCKER_PORTS({}).exists;
      expect(await exists(join(root, 'file'))).toBe(true);
      expect(await exists(join(root, 'missing'))).toBe(false);
      if (process.getuid?.() !== 0) expect(await exists(join(locked, 'inside'))).toBeNull();
    } finally { await chmod(locked, 0o700).catch(() => undefined); await rm(root, { recursive: true, force: true }); }
  });
  it('Docker Desktop is looked for only on WSL; an unsupported release makes no network call; an older source file is reported', async () => {
    const marker = DOCKER_APT.desktopMarkers[0]!, files = { '/etc/os-release': 'ID=ubuntu\nVERSION_CODENAME=noble\n', [marker]: '' };
    expect((await observeDockerHost({}, false, ports({ files, platform: () => 'wsl' }).port)).desktop).toBe(true);
    expect((await observeDockerHost({}, false, ports({ files, platform: () => 'linux' }).port)).desktop).toBe(false);
    expect((await observeDockerHost({}, true, ports({ files }).port)).desktop).toBe(true);
    const mint = ports({ files: { '/etc/os-release': 'ID=linuxmint\nID_LIKE=ubuntu\nUBUNTU_CODENAME=noble\n' } });
    expect(await observeDockerHost({}, false, mint.port)).toMatchObject({ network: false });
    expect(mint.heads).toEqual([]);
    expect((await observeDockerHost({}, false, ports({ files: { ...files, '/etc/apt/sources.list.d/docker.list': '' } }).port)).existingSource).toBe('/etc/apt/sources.list.d/docker.list');
  });
  it('stages the shipped key and the deb822 file in a new private directory', async () => {
    const plan = install(planDockerInstall(facts(), '/x'));
    const staging = await stageDockerFiles(plan.source);
    expect((await stat(staging)).mode & 0o777).toBe(0o700);
    expect((await readdir(staging)).sort()).toEqual(['docker.asc', 'docker.sources']);
    expect(await readFile(`${staging}/docker.asc`, 'utf8')).toBe(`${DOCKER_APT.key.armored.join('\n')}\n`);
    expect(await readFile(`${staging}/docker.sources`, 'utf8')).toBe(dockerSourcesFile(plan.source));
    expect((await stat(`${staging}/docker.asc`)).mode & 0o777).toBe(0o644);
    await rm(staging, { recursive: true, force: true });
  });
});

describe('foreground executor (cond. 2, 4)', () => {
  const plan = install(planDockerInstall(facts(), '/tmp/s'));
  const fake = (results: Array<DockerStepRun | ((index: number) => DockerStepRun)> = []) => {
    const calls: Array<{ file: string; args: readonly string[]; env: Readonly<Record<string, string | undefined>>; timeoutMs: number }> = [];
    return { calls, spawn: async (file: string, args: readonly string[], options: { env: Readonly<Record<string, string | undefined>>; timeoutMs: number }) => {
      calls.push({ file, args, env: options.env, timeoutMs: options.timeoutMs });
      const next = results[calls.length - 1];
      return typeof next === 'function' ? next(calls.length) : next ?? { code: 0, signal: null };
    } };
  };
  const env = { PATH: '/home/alice/bin:/usr/bin', TERM: 'xterm-256color', LANG: 'tr_TR.UTF-8', DECKENT_SECRET_PASSPHRASE: 'pass', ANTHROPIC_API_KEY: 'sk-x', SUDO_ASKPASS: '/tmp/a' }; // ggignore: fixed fake values the test proves never reach sudo (secret-scanner false positive)
  it('sudo -k first, then each step with `--` in order, a fixed clean environment and the registry timeouts; the version is recorded', async () => {
    const { calls, spawn } = fake();
    const result = await runDockerInstall(plan, env, { sudo: '/usr/bin/sudo', spawn, version: async () => '5:29.0.0-1~ubuntu.24.04~noble', verify: async () => true });
    expect(result).toEqual({ status: 'succeeded', step: null, exitCode: 0, version: '5:29.0.0-1~ubuntu.24.04~noble' });
    expect(calls.map(call => [call.file, ...call.args])).toEqual([['/usr/bin/sudo', '-k'], ...plan.steps.map(step => ['/usr/bin/sudo', '--', ...step.argv])]);
    expect(calls.slice(1).map(call => call.timeoutMs)).toEqual(plan.steps.map(step => step.timeoutMs));
    for (const call of calls) {
      expect(call.env).toEqual({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', TERM: 'xterm-256color', LANG: 'tr_TR.UTF-8' });
      expect(call.args).not.toContain('-S');
      expect(call.args).not.toContain('-A');
    }
    expect(sudoEnvironment(env)).not.toHaveProperty('SUDO_ASKPASS');
  });
  it('the terminal belongs to sudo while the steps run: a read of it left by the card is paused for every step and resumed after (CI-104)', async () => {
    const seen: Array<boolean | null> = [];
    const input = { isTTY: true, readableFlowing: true as boolean | null, pause() { this.readableFlowing = false; }, resume() { this.readableFlowing = true; } };
    const spawn = async () => { seen.push(input.readableFlowing); return { code: 0, signal: null }; };
    await runDockerInstall(plan, env, { sudo: '/usr/bin/sudo', spawn, version: async () => null, verify: async () => true, input });
    expect(seen).toEqual(Array(plan.steps.length + 1).fill(false));
    expect(input.readableFlowing).toBe(true);
    // Also after a failed step.
    await runDockerInstall(plan, env, { sudo: '/usr/bin/sudo', spawn: async () => ({ code: 1, signal: null }), version: async () => null, input });
    expect(input.readableFlowing).toBe(true);
    // A card that closed leaves no listener but its terminal read open (readableFlowing null): paused for the steps, not resumed after.
    let paused = 0, resumed = 0;
    const left = { isTTY: true, readableFlowing: null as boolean | null, pause: () => { paused++; }, resume: () => { resumed++; } };
    await runDockerInstall(plan, env, { sudo: '/usr/bin/sudo', spawn: async () => ({ code: 0, signal: null }), version: async () => null, verify: async () => true, input: left });
    expect([paused, resumed]).toEqual([1, 0]);
    // Not a terminal (pipe, test runner): untouched.
    const pipe = { isTTY: false, readableFlowing: true as boolean | null, pause: () => { throw new Error('paused a pipe'); }, resume: () => { throw new Error('resumed a pipe'); } };
    await runDockerInstall(plan, env, { sudo: '/usr/bin/sudo', spawn: async () => ({ code: 0, signal: null }), version: async () => null, verify: async () => true, input: pipe });
  });
  it('a non-zero step stops the run (failed, nothing after it ran); no exit (timeout, signal) is uncertain; nothing is retried', async () => {
    const failed = fake([{ code: 0, signal: null }, { code: 0, signal: null }, { code: 0, signal: null }, { code: 0, signal: null }, { code: 100, signal: null }]);
    expect(await runDockerInstall(plan, env, { sudo: '/usr/bin/sudo', spawn: failed.spawn, version: async () => null, verify: async () => true })).toEqual({ status: 'failed', step: 4, exitCode: 100, version: null });
    expect(failed.calls).toHaveLength(5);
    const lost = fake([{ code: 0, signal: null }, { code: 0, signal: null }, { code: 0, signal: null }, { code: 0, signal: null }, { code: 0, signal: null }, { code: null, signal: 'SIGTERM' }]);
    expect(await runDockerInstall(plan, env, { sudo: '/usr/bin/sudo', spawn: lost.spawn, version: async () => null, verify: async () => true })).toMatchObject({ status: 'uncertain', step: 5 });
    expect(lost.calls).toHaveLength(6);
    const wrongPassword = fake([{ code: 0, signal: null }, { code: 1, signal: null }]);
    expect(await runDockerInstall(plan, env, { sudo: '/usr/bin/sudo', spawn: wrongPassword.spawn, version: async () => null, verify: async () => true })).toMatchObject({ status: 'failed', step: 1, exitCode: 1 });
    expect(wrongPassword.calls).toHaveLength(2);
  });
  it('a key or source file that is not the shipped one stops the run before apt-get update trusts it (cond. 3 at install time)', async () => {
    const swapped = fake();
    const result = await runDockerInstall(plan, env, { sudo: '/usr/bin/sudo', spawn: swapped.spawn, version: async () => null, verify: async () => false });
    expect(result).toEqual({ status: 'failed', step: 3, exitCode: null, version: null, mismatch: true });
    expect(swapped.calls.map(call => call.args.at(-1))).toEqual(['-k', '/etc/apt/keyrings', '/etc/apt/keyrings/docker.asc', '/etc/apt/sources.list.d/docker.sources']);
    expect(dockerResultLines(result, plan.steps.length, { code: 'setup.execution.none' }, 'en')[0]).toContain('not the one Deckent shipped');
    const dir = await mkdtemp(join(tmpdir(), 'deckent-i-d2-verify-')), data = { ...DOCKER_APT, keyring: join(dir, 'docker.asc'), sourcesFile: join(dir, 'docker.sources') };
    try {
      const check = verifyInstalledSource(plan, data);
      expect(await check()).toBe(false);
      await writeFile(data.keyring, `${DOCKER_APT.key.armored.join('\n')}\n`); await writeFile(data.sourcesFile, dockerSourcesFile(plan.source, data));
      expect(await check()).toBe(true);
      await writeFile(data.keyring, `${DOCKER_APT.key.armored.join('\n')}\n# planted\n`);
      expect(await check()).toBe(false);
      await writeFile(data.keyring, `${DOCKER_APT.key.armored.join('\n')}\n`); await writeFile(data.sourcesFile, dockerSourcesFile({ ...plan.source, url: 'https://mirror.example/linux/ubuntu' }, data));
      expect(await check()).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('Ctrl+C during a step makes its effect unknown even when the step then exits', async () => {
    // The terminal's Ctrl+C reaches the foreground child and Deckent alike: call the executor's own handler (never a real signal in a test worker).
    const before = process.listeners('SIGINT');
    const interrupted = fake([{ code: 0, signal: null }, () => { (process.listeners('SIGINT').find(listener => !before.includes(listener)) as () => void)(); return { code: 130, signal: null }; }]);
    expect(await runDockerInstall(plan, env, { sudo: '/usr/bin/sudo', spawn: interrupted.spawn, version: async () => null, verify: async () => true })).toMatchObject({ status: 'uncertain', step: 1 });
    expect(process.listeners('SIGINT')).toEqual(before);
  });
});

describe('the setup seam (cond. 1)', () => {
  it('offered only to a person, only when Docker is absent; never `--yes`-eligible, default no', () => {
    expect(dockerInstallOffer(false)(executionFacts('absent'))).toBeNull();
    expect(dockerInstallOffer(true)(executionFacts('found'))).toBeNull();
    expect(dockerInstallOffer(true)(executionFacts('unknown'))).toBeNull();
    expect(dockerInstallOffer(true)(executionFacts('absent'))).toEqual({ operation: { id: 'execution-environment.install', version: 1, input: { environment: 'docker' } },
      question: { key: 'setup.execution.install', params: { runtime: 'Docker' } }, cli: null });
    const registry = new SetupStageRegistry([executionSetupFamily({ install: dockerInstallOffer(true) })]);
    const observation = { schemaVersion: 2 as const, environment: { platform: 'linux' as const, node: 'supported' as const }, language: { configured: 'en' as const, requested: null, system: null },
      folder: { installation: 'present' as const, homeRoot: false, configuredScope: 'installation', suggestedScope: null }, profile: { available: [] }, policy: { state: 'current' as const },
      sandbox: { realm: 'bubblewrap' as const, selfTest: 'ok' as const, usernsRestricted: false }, model: { connections: 1 }, check: { state: 'ok' as const },
      families: { execution: executionFacts('absent') } };
    const stage = planSetup(observation, { schemaVersion: 2, values: {} }, registry).stages.find(item => item.id === 'execution:runtime')!;
    expect(stage).toMatchObject({ state: 'needs-answer', default: false, autoEligible: false, operation: { id: 'execution-environment.install' } });
    const answered = planSetup(observation, { schemaVersion: 2, values: { 'execution:runtime': true } }, registry).stages.find(item => item.id === 'execution:runtime')!;
    expect(answered).toMatchObject({ state: 'ready', autoEligible: false });
  });
});
