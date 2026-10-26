import { chmod, mkdir, mkdtemp, readdir, rm, readFile, stat, truncate, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planSetup, SetupStageRegistry, type SetupObservation, type SetupStage } from '#engine/index.js';
import { MESSAGE_REGISTRY } from '#platform/index.js';
import { HOST_EXECUTION_PORTS, detectExecutionFacts, executionSetupFamily, parseExecutionRuntimes, type ExecutionDetectPorts,
  type ExecutionFacts } from '#adapters/core/setup-detect-execution/index.js';
import { firstCommitTarget, observeFirstCommitRecovery, applyFirstCommit, codingSetupFamily, detectCodingFacts, firstCommitGit, previewFirstCommit, type CodingFacts, type FirstCommitGit } from '#adapters/core/setup-detect-coding/index.js';
import { resolveCliLocale } from '#surfaces/core/cli-kit/index.js';
import { observeSetup, setupMessage } from '#surfaces/core/setup/index.js';

// I-S2: init detection. Execution-environment facts (Docker present, version, service reachable, user permission, kind), coding/git facts,
// locale facts; all read-only. Fakes stand for absent, stopped and no-permission Docker; the real host run is in the HANDOFF transcript.
const temps: string[] = [];
const temp = async (name: string) => { const path = await mkdtemp(join(tmpdir(), `deckent-is2-${name}-`)); temps.push(path); return path; };
afterEach(async () => { for (const path of temps.splice(0)) { await chmod(path, 0o700).catch(() => undefined); await rm(path, { recursive: true, force: true }); } });

/** A fake `docker` that logs every argv line and answers per FAKE_MODE: up | desktop | rootless | down. Never touches anything else. */
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$1" in
  version) if [ "$FAKE_MODE" = down ]; then echo '{"Client":{"Version":"29.1.3"},"Server":null}'; echo 'Cannot connect' >&2; exit 1; fi
    echo '{"Client":{"Version":"29.1.3"},"Server":{"Version":"29.1.2"}}';;
  context) echo "{\\"Host\\":\\"unix://$FAKE_SOCKET\\",\\"SkipTLSVerify\\":false}";;
  info) case "$FAKE_MODE" in
    desktop) echo '{"OperatingSystem":"Docker Desktop","SecurityOptions":[]}';;
    rootless) echo '{"OperatingSystem":"Ubuntu 24.04","SecurityOptions":["name=seccomp,profile=builtin","name=rootless"]}';;
    *) echo '{"OperatingSystem":"Ubuntu 24.04","SecurityOptions":["name=seccomp,profile=builtin"]}';; esac;;
  *) exit 64;;
esac
`;
async function fakeBin(names: Readonly<Record<string, string>>) {
  const dir = await temp('bin');
  for (const [name, body] of Object.entries(names)) { await writeFile(join(dir, name), body); await chmod(join(dir, name), 0o755); }
  return dir;
}
async function dockerHost(mode: string, socket: string, extra: Readonly<Record<string, string>> = {}) {
  const bin = await fakeBin({ docker: FAKE_DOCKER, ...extra }), log = join(await temp('log'), 'argv.log');
  await writeFile(log, '');
  return { env: { PATH: bin, FAKE_MODE: mode, FAKE_SOCKET: socket, FAKE_LOG: log, FAKE_GROUPS: '' }, log };
}
const docker = (facts: ExecutionFacts) => facts.runtimes[0]!;
const decide = (facts: unknown, family = executionSetupFamily(), answer?: unknown) =>
  family.stages[0]!.evaluate({ facts, answer, scopeId: 's', states: new Map() });

// POSIX fakes (`#!/bin/sh`, file modes): not run on native Windows, like the sibling POSIX-mode adapter tests.
const posix = process.platform === 'win32';
describe.skipIf(posix)('I-S2 execution-environment detection', () => {
  it('the registry is data: Docker is the supported entry, Podman is reported only; a malformed registry is refused', () => {
    const [first, second] = parseExecutionRuntimes({ schemaVersion: 1, runtimes: [{ id: 'x', label: 'X', support: 'unsupported', executable: 'x' }] });
    expect(first).toMatchObject({ id: 'x' }); expect(second).toBeUndefined();
    expect(() => parseExecutionRuntimes({ schemaVersion: 1, runtimes: [{ id: 'x', label: 'X', support: 'supported', executable: 'x' }] })).toThrow();
    expect(() => parseExecutionRuntimes({ schemaVersion: 2, runtimes: [] })).toThrow();
  });

  it('absent: no CLI on PATH → nothing else runs; the stage says no Run, /do or delivery (D3 label)', async () => {
    const facts = await detectExecutionFacts({ env: { PATH: await fakeBin({}) } });
    expect(docker(facts)).toMatchObject({ cli: 'absent', daemon: 'not-run', path: null });
    expect(facts.runtimes.map(row => row.support)).toEqual(['supported', 'unsupported']);
    expect(decide(facts)).toMatchObject({ state: 'blocked', reason: { code: 'setup.execution.none' } });
    expect(MESSAGE_REGISTRY.catalogs.en['setup.execution.none']).toContain('work, /do and delivery cannot run');
  });

  it('reachable engine, Desktop and rootless are told apart from `docker info`; only read verbs run', async () => {
    for (const [mode, kind, code] of [['up', 'engine', 'ready'], ['desktop', 'desktop', 'readyDesktop'], ['rootless', 'rootless', 'readyRootless']] as const) {
      const host = await dockerHost(mode, '/nonexistent/docker.sock'), facts = await detectExecutionFacts({ env: host.env });
      expect(docker(facts)).toMatchObject({ cli: 'found', version: '29.1.3', daemon: 'reachable', serverVersion: '29.1.2', kind, endpoint: 'system', group: null });
      expect(decide(facts)).toEqual({ state: 'done', reason: { code: `setup.execution.${code}`, params: { runtime: 'Docker', version: '29.1.2' } } });
      const verbs = (await import('node:fs/promises')).readFile(host.log, 'utf8').then(text => text.trim().split('\n').map(line => line.split(' ')[0]));
      expect(await verbs).toEqual(['version', 'context', 'info']);
    }
  });

  it('stopped: the CLI answers but the service socket is missing → unreachable, never started', async () => {
    const host = await dockerHost('down', join(await temp('sock'), 'docker.sock')), facts = await detectExecutionFacts({ env: host.env });
    expect(docker(facts)).toMatchObject({ cli: 'found', version: '29.1.3', daemon: 'unreachable', serverVersion: null, group: null });
    expect(decide(facts)).toMatchObject({ state: 'blocked', reason: { code: 'setup.execution.stopped', params: { runtime: 'Docker' } } });
    expect(await (await import('node:fs/promises')).readFile(host.log, 'utf8')).not.toMatch(/^(start|run|pull|create|system|context use)/mu);
  });

  it.skipIf(process.getuid?.() === 0)('no permission: the socket exists but this user may not open it; the group answer tells re-login from not a member', async () => {
    const dir = await temp('sock'), socket = join(dir, 'docker.sock');
    await writeFile(socket, ''); await chmod(socket, 0o000);
    const gid = (await stat(socket)).gid;
    for (const [listed, group, code, session] of [[`1 ${gid}`, 'relogin', 'relogin', []], ['1 2', 'not-member', 'noPermission', []], ['', 'member', 'socketMode', [gid]]] as const) {
      const host = await dockerHost('down', socket, { id: '#!/bin/sh\necho "$FAKE_GROUPS"\n' });
      const ports: ExecutionDetectPorts = { ...HOST_EXECUTION_PORTS, groups: () => session, user: () => 'someone' };
      const facts = await detectExecutionFacts({ env: { ...host.env, FAKE_GROUPS: listed }, ports });
      expect(docker(facts)).toMatchObject({ daemon: 'no-permission', group });
      expect(decide(facts)).toMatchObject({ state: 'blocked', reason: { code: `setup.execution.${code}` } });
    }
    expect(MESSAGE_REGISTRY.catalogs.en['setup.execution.noPermission']).toContain('root-equivalent');
  });

  it('no answer in time is `unknown`, never a guess; Podman alone is reported as unsupported', async () => {
    const silent: ExecutionDetectPorts = { ...HOST_EXECUTION_PORTS, run: async () => ({ code: null, stdout: '', stderr: '' }) };
    const host = await dockerHost('up', '/nonexistent/docker.sock');
    const facts = await detectExecutionFacts({ env: host.env, ports: silent });
    expect(docker(facts)).toMatchObject({ cli: 'found', daemon: 'unknown', version: null });
    expect(decide(facts)).toMatchObject({ state: 'blocked', reason: { code: 'setup.execution.unknown' } });
    const podman = await detectExecutionFacts({ env: { PATH: await fakeBin({ podman: '#!/bin/sh\nexit 99\n' }) } });
    expect(podman.runtimes[1]).toMatchObject({ id: 'podman', cli: 'found', daemon: 'not-run' });
    expect(decide(podman)).toMatchObject({ state: 'unsupported', reason: { code: 'setup.execution.unsupportedOnly', params: { runtime: 'Podman' } } });
  });

  it('I-D2 seam: an install offer turns a machine without Docker into a question; No is settled; families stay off --yes', () => {
    const facts: ExecutionFacts = { schemaVersion: 1, runtimes: [{ id: 'docker', label: 'Docker', support: 'supported', cli: 'absent', path: null, version: null,
      daemon: 'not-run', serverVersion: null, kind: null, endpoint: null, group: null }] };
    const family = executionSetupFamily({ install: () => ({ operation: { id: 'execution-env.install', version: 1, input: {} },
      question: { key: 'setup.execution.installQuestion', params: {} }, cli: null }) });
    expect(decide(facts, family)).toMatchObject({ state: 'needs-answer', operation: { id: 'execution-env.install' }, default: false });
    expect(decide(facts, family, true)).toMatchObject({ state: 'ready', operation: { id: 'execution-env.install' } });
    expect(decide(facts, family, false)).toMatchObject({ state: 'skipped', reason: { code: 'setup.execution.declined' } });
    expect(decide(undefined)).toMatchObject({ state: 'blocked', reason: { code: 'setup.execution.unavailable' } });
    const desktop = { ...facts, runtimes: [{ ...facts.runtimes[0]!, cli: 'found' as const, daemon: 'unreachable' as const, kind: 'desktop' as const }] };
    expect(decide(desktop, family)).toMatchObject({ state: 'blocked', reason: { code: 'setup.execution.desktopStopped' } });
  });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args],
  { cwd, env: { PATH: process.env['PATH'] ?? '', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'ignore' });
const hostPath = process.env['PATH'] ?? '';
const coding = (facts: unknown, stage: number) => codingSetupFamily().stages[stage]!.evaluate({ facts, answer: undefined, scopeId: 's', states: new Map() });

describe.skipIf(posix)('I-S2 coding/git detection', () => {
  it('not a repository, no commits, commits with a separate clone, and no Git are each reported honestly', async () => {
    const plain = await temp('plain');
    const none = await detectCodingFacts({ root: plain, env: { PATH: hostPath, HOME: plain }, ports: { selfSource: async () => false } });
    expect(none).toMatchObject({ git: 'found', repository: 'none', commits: 'not-run' });
    expect(coding(none, 0)).toMatchObject({ state: 'skipped', reason: { code: 'setup.coding.notRepository' } });
    git(plain, 'init', '-q');
    const empty = await detectCodingFacts({ root: plain, env: { PATH: hostPath, HOME: plain }, ports: { selfSource: async () => false } });
    expect(empty).toMatchObject({ repository: 'present', commits: 'none' });
    expect(coding(empty, 0)).toMatchObject({ state: 'skipped', reason: { code: 'setup.coding.noCommitsInfo' } });
    await writeFile(join(plain, 'a.txt'), 'a'); git(plain, 'add', '.'); git(plain, 'commit', '-q', '-m', 'first');
    const clone = await temp('clone'); await mkdir(join(clone, '.git'));
    const full = await detectCodingFacts({ root: plain, env: { PATH: hostPath, HOME: plain }, workTargets: [clone, plain, '/nonexistent/target'], ports: { selfSource: async () => false } });
    expect(full).toMatchObject({ repository: 'present', commits: 'present', productSource: false, workTargets: { configured: 2, present: 1 } });
    expect(coding(full, 0)).toMatchObject({ state: 'done', reason: { code: 'setup.coding.repository', params: { targets: 1 } } });
    const self = await detectCodingFacts({ root: plain, env: { PATH: hostPath, HOME: plain }, ports: { selfSource: async () => true } });
    expect(coding(self, 0)).toMatchObject({ state: 'done', reason: { code: 'setup.coding.productSource' } });
    const noGit = await detectCodingFacts({ root: plain, env: { PATH: await fakeBin({}), HOME: plain } });
    expect(noGit).toMatchObject({ git: 'absent', repository: 'not-run', productSource: false });
    expect(coding(noGit, 0)).toMatchObject({ state: 'skipped', reason: { code: 'setup.coding.gitMissing' } });
    expect(coding({ ...full, repository: 'unknown' }, 0)).toMatchObject({ state: 'blocked', reason: { code: 'setup.coding.repositoryUnknown' } });
    expect(coding({ ...full, hosts: [{ id: 'codex', cli: 'found', login: 'absent' }] }, 1)).toMatchObject({ state: 'skipped', reason: { code: 'setup.coding.hostsInstalled', params: { hosts: 'codex' } } });
  });

  it('first commit: a secret shape past the first 64 KiB of a file is still flagged and left out by default (security review)', async () => {
    const root = await temp('first-deep'); git(root, 'init', '-q');
    await writeFile(join(root, 'notes.txt'), `${'x'.repeat(70_000)}\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n`);
    const preview = await previewFirstCommit({ root, env: { PATH: hostPath, HOME: root, GIT_CONFIG_NOSYSTEM: '1' }, message: 'First commit' });
    expect(preview).toMatchObject({ state: 'offered', selected: 0, rows: [{ path: 'notes.txt', flag: 'secret-content' }] });
  });
  it('first commit (alpha.56 U4-1c): a failed commit-tree and a ref race leave the repository as it was; a flagged .env is committed only when ticked', async () => {
    const repo = async (identity: boolean) => {
      const root = await temp('first'); git(root, 'init', '-q');
      const set = (key: string, value: string) => execFileSync('git', ['config', key, value], { cwd: root, env: { PATH: hostPath, HOME: root, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      if (identity) { set('user.name', 'Person'); set('user.email', 'person@example.test'); } else set('user.useConfigOnly', 'true');
      await writeFile(join(root, 'a.txt'), 'a\n'); await writeFile(join(root, '.env'), 'API_TOKEN=live-value-0123456789\n');
      return { root, env: { PATH: hostPath, HOME: root, GIT_CONFIG_NOSYSTEM: '1' }, message: 'First commit' };
    };
    const sh = (root: string, ...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, env: { PATH: hostPath, HOME: root, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const status = (root: string) => sh(root, 'status', '--porcelain=v2', '--untracked-files=all');
    const leftovers = async (root: string) => (await readdir(join(root, '.git'))).filter(name => name === 'index' || name === 'index.lock' || name.startsWith('deckent-first-commit.'));
    // 1. No identity (user.useConfigOnly): the preview says so; the apply fails at commit-tree and writes nothing.
    const bare = await repo(false), seen = await previewFirstCommit(bare);
    expect(seen).toMatchObject({ state: 'offered', identity: false, sign: false, hooks: 'not-run', total: 2, selected: 1, flagged: 1, rows: [{ path: '.env', flag: 'secret-name' }, { path: 'a.txt', flag: null }] });
    const before = status(bare.root);
    await expect(applyFirstCommit({ ...bare, digest: seen.state === 'offered' ? seen.digest : '' })).rejects.toMatchObject({ code: 'SETUP_FIRST_COMMIT_FAILED', params: { step: 'commit-tree' } });
    expect(status(bare.root)).toBe(before); expect(await leftovers(bare.root)).toEqual([]);
    // 2. Another commit lands between commit-tree and update-ref: the zero-oid ref update refuses, the person's commit and index stay as they were.
    const raced = await repo(true), real = await firstCommitGit(raced.root, raced.env), racing = sh(raced.root, 'commit-tree', '-m', 'race', sh(raced.root, 'hash-object', '-t', 'tree', '/dev/null').trim()).trim();
    let atRace = '';
    const port: FirstCommitGit = async (args, options) => {
      if (args[0] === 'update-ref') { sh(raced.root, 'update-ref', 'HEAD', racing); atRace = status(raced.root); }
      return real(args, options);
    };
    const offer = await previewFirstCommit(raced);
    await expect(applyFirstCommit({ ...raced, git: port, digest: offer.state === 'offered' ? offer.digest : '' })).rejects.toMatchObject({ code: 'SETUP_FIRST_COMMIT_CHANGED' });
    expect(status(raced.root)).toBe(atRace); expect(sh(raced.root, 'rev-parse', 'HEAD').trim()).toBe(racing); expect(await leftovers(raced.root)).toEqual([]);
    // 3. Default selection: .env stays untracked, a.txt is committed and clean (the index was swapped); ticking .env needs its own digest.
    const plain = await repo(true), first = await previewFirstCommit(plain), digest = first.state === 'offered' ? first.digest : '';
    await expect(applyFirstCommit({ ...plain, include: ['.env'], digest })).rejects.toMatchObject({ code: 'SETUP_FIRST_COMMIT_CHANGED' });
    await expect(applyFirstCommit({ ...plain, digest })).resolves.toMatchObject({ operation: 'coding.first-commit@1', files: 1, signed: false });
    expect(sh(plain.root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe('a.txt\n'); expect(status(plain.root)).toBe('? .env\n');
    expect(await previewFirstCommit(plain)).toEqual({ state: 'has-commits' });
    const ticked = await repo(true), withEnv = await previewFirstCommit({ ...ticked, include: ['.env'] });
    await applyFirstCommit({ ...ticked, include: ['.env'], digest: withEnv.state === 'offered' ? withEnv.digest : '' });
    expect(sh(ticked.root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe('.env\na.txt\n'); expect(status(ticked.root)).toBe('');
  });
  it.skipIf(process.platform === 'win32')('first commit (Astra A56 C1): history holds exactly the scanned bytes; a file changed after the preview or after the scan never lands', async () => {
    const env = { PATH: hostPath, HOME: '', GIT_CONFIG_NOSYSTEM: '1' }, secret = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n';
    const repo = async () => {
      const root = await temp('first-bound'); git(root, 'init', '-q');
      for (const [key, value] of [['user.name', 'Person'], ['user.email', 'person@example.test']]) execFileSync('git', ['config', key, value], { cwd: root, env: { ...env, HOME: root }, stdio: 'ignore' });
      await writeFile(join(root, 'a.txt'), 'a\n'); await writeFile(join(root, 'run.sh'), Buffer.from([0x23, 0x21, 0xff, 0x00, 0x0a])); await chmod(join(root, 'run.sh'), 0o755);
      execFileSync('ln', ['-s', 'a.txt', join(root, 'link')]);
      return { root, env: { ...env, HOME: root }, message: 'First commit' };
    };
    const sh = (root: string, ...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, env: { ...env, HOME: root }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    // Changed between the preview and the apply: the digest binds each selected file's content, so the apply refuses.
    const changed = await repo(), shown = await previewFirstCommit(changed);
    await writeFile(join(changed.root, 'a.txt'), 'b\n');
    await expect(applyFirstCommit({ ...changed, digest: shown.state === 'offered' ? shown.digest : '' })).rejects.toMatchObject({ code: 'SETUP_FIRST_COMMIT_CHANGED' });
    expect(() => sh(changed.root, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}')).toThrow();
    // Changed after the apply's own scan, while Git stages: the commit carries the scanned bytes, not the new ones.
    const raced = await repo(), real = await firstCommitGit(raced.root, raced.env), offer = await previewFirstCommit(raced);
    const port: FirstCommitGit = async (args, options) => {
      if (args[0] === 'hash-object' || args[0] === 'update-index') await writeFile(join(raced.root, 'a.txt'), secret);
      return real(args, options);
    };
    await expect(applyFirstCommit({ ...raced, git: port, digest: offer.state === 'offered' ? offer.digest : '' })).resolves.toMatchObject({ files: 3 });
    expect(sh(raced.root, 'show', 'HEAD:a.txt')).toBe('a\n');
    expect(execFileSync('git', ['show', 'HEAD:run.sh'], { cwd: raced.root, env: { ...env, HOME: raced.root } })).toEqual(Buffer.from([0x23, 0x21, 0xff, 0x00, 0x0a]));
    expect(sh(raced.root, 'ls-tree', 'HEAD').replace(/ [0-9a-f]{40,64}\t/gu, ' \t')).toBe('100644 blob \ta.txt\n120000 blob \tlink\n100755 blob \trun.sh\n');
    expect(sh(raced.root, 'show', 'HEAD:link')).toBe('a.txt');
  });

  it('coding-CLI sign-ins: presence by lstat only — an unreadable sign-in file is still "found", its content never leaves', async () => {
    const home = await temp('home'), moved = await temp('moved'), canary = 'CANARY-SECRET-is2';
    await mkdir(join(home, '.alpha')); await writeFile(join(home, '.alpha', 'auth.json'), canary); await chmod(join(home, '.alpha', 'auth.json'), 0o000);
    await writeFile(join(moved, 'cred.json'), canary); await chmod(join(moved, 'cred.json'), 0o000);
    const touched: string[] = [];
    const facts = await detectCodingFacts({ root: home, env: { PATH: await fakeBin({ 'alpha-cli': '#!/bin/sh\nexit 0\n' }), HOME: home, MOVED_HOME: moved }, ports: {
      executable: id => id === 'codex' ? 'alpha-cli' : `${id}-not-installed`,
      credential: id => id === 'codex' ? { homeOverride: '', home: '.alpha', file: 'auth.json' } : id === 'claude' ? { homeOverride: 'MOVED_HOME', home: '.nowhere', file: 'cred.json' } : null,
      kind: async path => { touched.push(path); const info = await stat(path).catch(() => null); return !info ? 'absent' : info.isFile() ? 'file' : 'directory'; },
      selfSource: async () => false } });
    const rows = Object.fromEntries(facts.hosts.map(row => [row.id, row]));
    expect(rows['codex']).toEqual({ id: 'codex', cli: 'found', login: 'found' });
    expect(rows['claude']).toMatchObject({ cli: 'absent', login: 'found' });
    expect(Object.values(rows).filter(row => row.login === 'unknown').length).toBeGreaterThanOrEqual(1);
    expect(touched).toEqual(expect.arrayContaining([join(home, '.alpha', 'auth.json'), join(moved, 'cred.json')]));
    expect(JSON.stringify(facts)).not.toContain(canary);
    expect(coding(facts, 1)).toMatchObject({ state: 'done', reason: { code: 'setup.coding.hostsFound', params: { count: 2 } } });
    expect(MESSAGE_REGISTRY.catalogs.en['setup.coding.hostsFound']).toContain('found, not verified');
  });

  it('detection never writes: the folder (also HOME) keeps the same entries, sizes and modification times', async () => {
    const root = await temp('root'); await writeFile(join(root, 'keep.txt'), 'x');
    const snapshot = async () => Promise.all((await readdir(root, { recursive: true })).sort().map(async name => {
      const info = await stat(join(root, name)); return `${name}:${info.size}:${info.mtimeMs}`; }));
    const before = [...await snapshot(), (await stat(root)).mtimeMs];
    await detectCodingFacts({ root, env: { PATH: hostPath, HOME: root } });
    await detectExecutionFacts({ env: { PATH: hostPath, HOME: root } });
    expect([...await snapshot(), (await stat(root)).mtimeMs]).toEqual(before);
  });
});

const observation = (families: Record<string, unknown>): SetupObservation => ({ schemaVersion: 2, environment: { platform: 'wsl', node: 'supported' },
  language: { configured: null, requested: null, system: 'tr' }, folder: { installation: 'none', homeRoot: false, configuredScope: null, suggestedScope: 'erp' },
  profile: { available: [{ id: 'core:solo', version: 1 }] }, policy: { state: 'absent' }, sandbox: { realm: 'bubblewrap', selfTest: 'ok', usernsRestricted: false },
  model: { connections: 0 }, check: { state: 'not-run' }, families });
const ready: ExecutionFacts = { schemaVersion: 1, runtimes: [{ id: 'docker', label: 'Docker', support: 'supported', cli: 'found', path: '/usr/bin/docker', version: '29.1.3',
  daemon: 'reachable', serverVersion: '29.1.3', kind: 'engine', endpoint: 'system', group: null }] };
const repo: CodingFacts = { schemaVersion: 1, git: 'found', gitPath: '/usr/bin/git', gitVersion: '2.43.0', repository: 'present', commits: 'present', productSource: false,
  workTargets: { configured: 0, present: 0 }, hosts: [{ id: 'codex', cli: 'found', login: 'found' }] };

describe('I-S2 families in the setup plan', () => {
  const registry = new SetupStageRegistry([executionSetupFamily(), codingSetupFamily()]);
  const at = (stages: readonly SetupStage[], id: string) => stages.find(stage => stage.id === id)!;
  it('a fresh dev machine: repository after the folder stage, the runtime after the sandbox stage, sign-ins after the model stage', () => {
    const plan = planSetup(observation({ execution: ready, coding: repo }), undefined, registry);
    expect(plan.stages.map(stage => stage.id)).toEqual(['core:language', 'core:environment', 'core:folder', 'coding:repository', 'core:profile', 'core:policy',
      'core:sandbox', 'core:final-check', 'core:model', 'coding:hosts', 'execution:runtime', 'execution:worker', 'execution:worker-settings', 'coding:first-commit']);
    expect(['coding:repository', 'execution:runtime', 'coding:hosts'].map(id => at(plan.stages, id).state)).toEqual(['done', 'done', 'done']);
    expect(plan.stages.filter(stage => stage.namespace !== 'core').every(stage => !stage.autoEligible && stage.operation === null)).toBe(true);
    for (const stage of plan.stages.filter(item => item.namespace !== 'core')) for (const locale of ['en', 'tr'] as const) {
      expect(setupMessage(stage.title, {}, locale)).not.toBe(stage.title); expect(setupMessage(stage.reason.code, stage.reason.params, locale)).not.toBe(stage.reason.code); }
  });
  it('an ERP server without Docker or Git: honest labels, nothing to apply, the plan stays valid', () => {
    const bare: ExecutionFacts = { schemaVersion: 1, runtimes: ready.runtimes.map(row => ({ ...row, cli: 'absent', path: null, version: null, daemon: 'not-run', serverVersion: null,
      kind: null, endpoint: null })) };
    const noGit: CodingFacts = { ...repo, git: 'absent', gitVersion: null, repository: 'not-run', commits: 'not-run', hosts: [] };
    const plan = planSetup(observation({ execution: bare, coding: noGit }), undefined, registry);
    expect(at(plan.stages, 'execution:runtime')).toMatchObject({ state: 'blocked', reason: { code: 'setup.execution.none' } });
    expect(at(plan.stages, 'coding:repository')).toMatchObject({ state: 'skipped', reason: { code: 'setup.coding.gitMissing' } });
    expect(at(plan.stages, 'coding:hosts')).toMatchObject({ state: 'skipped', reason: { code: 'setup.coding.hostsNone' } });
    // Families without facts (detection unavailable) are blocked, not invalid.
    expect(at(planSetup(observation({}), undefined, registry).stages, 'execution:runtime')).toMatchObject({ state: 'blocked', reason: { code: 'setup.execution.unavailable' } });
  });
  it('every reason and title key exists in English and Turkish', () => {
    const keys = Object.keys(MESSAGE_REGISTRY.catalogs.en).filter(key => /^setup\.(execution|coding)\./u.test(key));
    expect(keys.length).toBeGreaterThanOrEqual(24);
    for (const key of keys) expect((MESSAGE_REGISTRY.catalogs.tr as Record<string, string>)[key]).toBeTruthy();
  });
});

describe('I-S2 locale facts follow the L-KIT chain', () => {
  it('the observed system language equals the CLI chain (LC_ALL > LC_MESSAGES > LANG, empty = unset) for every case', async () => {
    const root = await temp('locale');
    const cases: NodeJS.ProcessEnv[] = [{ LANG: 'tr_TR.UTF-8' }, { LC_ALL: '', LANG: 'tr_TR.UTF-8' }, { LC_MESSAGES: 'tr_TR.UTF-8', LANG: 'en_US.UTF-8' },
      { LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'tr_TR' }, { LANG: 'de_DE.UTF-8', LC_MESSAGES: 'tr_TR' }, { LANG: 'C.UTF-8' }, {}];
    for (const env of cases) {
      const { observation: seen } = await observeSetup({ env: { ...env, HOME: root } }, root, undefined);
      expect(seen.language.system ?? 'en').toBe(resolveCliLocale({ env }));
    }
  });
});

it.skipIf(process.platform === 'win32')('first commit (Astra A56 D1/S2): the scan and the card bind the form Git stores (encoding, clean filter), and a file grown past the budget is never read', async () => {
  const env = { PATH: hostPath, HOME: '', GIT_CONFIG_NOSYSTEM: '1' }, marker = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n';
  const sh = (root: string, ...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, env: { ...env, HOME: root }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const repo = async (filter: string) => {
    const root = await temp('first-canonical'); git(root, 'init', '-q');
    for (const [key, value] of [['user.name', 'Person'], ['user.email', 'person@example.test'], ['filter.up.clean', filter]]) sh(root, 'config', key, value);
    await writeFile(join(root, '.gitattributes'), 'wide.txt working-tree-encoding=UTF-16\nlow.txt filter=up\nplain.txt working-tree-encoding=UTF-16\n');
    // The raw bytes carry no marker: UTF-16 hides it from a UTF-8 read; lower case is no match until the clean filter upper-cases it.
    await writeFile(join(root, 'wide.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(marker, 'utf16le')]));
    await writeFile(join(root, 'low.txt'), marker.toLowerCase());
    await writeFile(join(root, 'plain.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello\n', 'utf16le')]));
    return { root, env: { ...env, HOME: root }, message: 'First commit' };
  };
  const first = await repo('tr a-z A-Z'), seen = await previewFirstCommit(first);
  expect(seen).toMatchObject({ state: 'offered', selected: 2, rows: expect.arrayContaining([{ path: 'wide.txt', bytes: expect.any(Number), flag: 'secret-content' },
    { path: 'low.txt', bytes: expect.any(Number), flag: 'secret-content' }]) });
  await applyFirstCommit({ ...first, digest: seen.state === 'offered' ? seen.digest : '' });
  expect(sh(first.root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe('.gitattributes\nplain.txt\n');
  // The stored blob is Git's canonical (UTF-8) form, the same object `git add` would write; the work tree reads clean.
  expect(sh(first.root, 'rev-parse', 'HEAD:plain.txt').trim()).toBe(sh(first.root, 'hash-object', 'plain.txt').trim());
  expect(sh(first.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  // A filter change after the preview changes the stored form: the card no longer matches, nothing is committed.
  const second = await repo('cat'); await rm(join(second.root, 'wide.txt')); const shown = await previewFirstCommit(second);
  expect(shown).toMatchObject({ state: 'offered', selected: 3 });
  sh(second.root, 'config', 'filter.up.clean', 'tr a-z A-Z');
  await expect(applyFirstCommit({ ...second, digest: shown.state === 'offered' ? shown.digest : '' })).rejects.toMatchObject({ code: 'SETUP_FIRST_COMMIT_CHANGED' });
  expect(() => sh(second.root, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}')).toThrow();
  // S2: a file that grows past the byte budget after the scan is refused before it is allocated or read.
  const grown = await repo('cat'), offer = await previewFirstCommit(grown), real = await firstCommitGit(grown.root, grown.env);
  const allocated: number[] = [], alloc = Buffer.alloc.bind(Buffer);
  const port: FirstCommitGit = async (args, options) => {
    if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') { await writeFile(join(grown.root, 'plain.txt'), ''); await truncate(join(grown.root, 'plain.txt'), 104_857_601); }
    return real(args, options);
  };
  Buffer.alloc = ((size: number, ...rest: unknown[]) => { allocated.push(size); return (alloc as (...a: unknown[]) => Buffer)(size, ...rest); }) as typeof Buffer.alloc;
  try { await expect(applyFirstCommit({ ...grown, git: port, digest: offer.state === 'offered' ? offer.digest : '' })).rejects.toMatchObject({ code: 'SETUP_FIRST_COMMIT_CHANGED' }); }
  finally { Buffer.alloc = alloc; }
  expect(Math.max(0, ...allocated)).toBeLessThan(104_857_601);
});
it.skipIf(process.platform === 'win32')('U4C: failed index swap retains private path custody; recovery preserves unrelated staging and refuses same-path overlap', async () => {
  const sh = (root: string, ...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, env: { PATH: hostPath, HOME: root, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const repo = async () => { const root = await temp('recovery'); git(root, 'init', '-q'); sh(root, 'config', 'user.name', 'Person'); sh(root, 'config', 'user.email', 'person@example.test');
    await writeFile(join(root, 'a.txt'), 'first'); return { root, env: { PATH: hostPath, HOME: root, GIT_CONFIG_NOSYSTEM: '1' }, message: 'First' }; };
  for (const overlap of [false, true]) {
    const request = await repo(), real = await firstCommitGit(request.root, request.env), preview = await previewFirstCommit(request);
    const port: FirstCommitGit = async (args, options) => {
      const result = await real(args, options);
      if (args[0] === 'update-ref' && result.code === 0) {
        await rm(join(request.root, '.git/index.lock')); const path = overlap ? 'a.txt' : 'other.txt'; await writeFile(join(request.root, path), 'concurrent'); sh(request.root, 'add', path);
      }
      return result;
    };
    await expect(applyFirstCommit({ ...request, git: port, digest: preview.state === 'offered' ? preview.digest : '' })).rejects.toMatchObject({ code: 'SETUP_FIRST_COMMIT_INDEX_PENDING' });
    const seen = await observeFirstCommitRecovery(request.root, request.env);
    expect(seen.state).toBe('pending'); if (seen.state !== 'pending') throw new Error('missing recovery');
    expect((await stat(seen.pathsFile)).mode & 0o777).toBe(0o600); expect(await readFile(seen.pathsFile, 'utf8')).toBe('a.txt\0');
    if (overlap) { expect(seen.overlap).toEqual(['a.txt']); expect(seen.command).toBeNull(); }
    else {
      const before = sh(request.root, 'diff', '--cached', '--', 'other.txt');
      expect(seen.command).toContain('--pathspec-file-nul'); expect(seen.command).not.toContain('read-tree');
      sh(request.root, '--literal-pathspecs', 'reset', '-q', seen.commit, `--pathspec-from-file=${seen.pathsFile}`, '--pathspec-file-nul');
      expect(sh(request.root, 'diff', '--cached', '--', 'other.txt')).toBe(before);
      expect(await observeFirstCommitRecovery(request.root, request.env)).toEqual({ state: 'settled' });
    }
  }
});
it.skipIf(process.platform === 'win32')('U4C: the first-commit target reconciles the same effect key from Git instead of making a second commit', async () => {
  const root = await temp('effect'), env = { PATH: hostPath, HOME: root, GIT_CONFIG_NOSYSTEM: '1' };
  git(root, 'init', '-q'); execFileSync('git', ['config', 'user.name', 'Person'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); execFileSync('git', ['config', 'user.email', 'person@example.test'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await writeFile(join(root, 'a.txt'), 'data'); const preview = await previewFirstCommit({ root, env, message: 'First' });
  if (preview.state !== 'offered') throw new Error('not offered');
  const input = { message: 'First', digest: preview.digest };
  await mkdir(join(root, 'nested')); const target = await firstCommitTarget(join(root, 'nested'), env, input);
  expect(await target.lookup({ kind: target.kind, id: 'HEAD' }, 'wire-key')).toEqual({ status: 'absent' });
  const result = await target.apply({ target: { kind: target.kind, id: 'HEAD' }, operation: { id: 'coding.first-commit', version: 1 }, idempotencyKey: 'wire-key', expectedVersion: preview.digest, input });
  expect(await target.lookup({ kind: target.kind, id: 'HEAD' }, 'wire-key')).toEqual({ status: 'applied', version: result.version });
  expect(await target.lookup({ kind: target.kind, id: 'HEAD' }, 'different-key')).toBeNull();
  expect(await previewFirstCommit({ root, env, message: 'First' })).toEqual({ state: 'has-commits' });
});

it('U4C: first-commit is onboarding only, skipped for business folders and resumes index recovery without creating another commit', () => {
  const stage = codingSetupFamily().stages.find(row => row.id === 'coding:first-commit')!;
  const decide = (facts: Partial<CodingFacts>) => stage.evaluate({ facts, answer: undefined, scopeId: 's', states: new Map() });
  expect(stage.phase).toBe('onboarding');
  expect(decide({ repository: 'present', commits: 'present', firstCommitRecovery: 'unknown' }).state).toBe('blocked');
  expect(decide({ repository: 'none', commits: 'none' }).state).toBe('skipped');
  expect(decide({ repository: 'present', commits: 'none' })).toMatchObject({ state: 'ready', operation: { id: 'coding.first-commit' } });
  expect(decide({ repository: 'present', commits: 'present' }).state).toBe('done');
  expect(decide({ repository: 'present', commits: 'present', firstCommitRecovery: 'pending' })).toMatchObject({ state: 'ready', operation: { id: 'coding.first-commit-recovery' } });
});
