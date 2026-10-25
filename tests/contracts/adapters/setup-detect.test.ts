import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planSetup, SetupStageRegistry, type SetupObservation, type SetupStage } from '#engine/index.js';
import { MESSAGE_REGISTRY } from '#platform/index.js';
import { HOST_EXECUTION_PORTS, detectExecutionFacts, executionSetupFamily, parseExecutionRuntimes, type ExecutionDetectPorts,
  type ExecutionFacts } from '#adapters/core/setup-detect-execution/index.js';
import { codingSetupFamily, detectCodingFacts, type CodingFacts } from '#adapters/core/setup-detect-coding/index.js';
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
    expect(MESSAGE_REGISTRY.catalogs.en['setup.execution.none']).toContain('no Run, /do or delivery');
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
    expect(coding(empty, 0)).toMatchObject({ state: 'blocked', reason: { code: 'setup.coding.noCommits' } });
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
const repo: CodingFacts = { schemaVersion: 1, git: 'found', gitVersion: '2.43.0', repository: 'present', commits: 'present', productSource: false,
  workTargets: { configured: 0, present: 0 }, hosts: [{ id: 'codex', cli: 'found', login: 'found' }] };

describe('I-S2 families in the setup plan', () => {
  const registry = new SetupStageRegistry([executionSetupFamily(), codingSetupFamily()]);
  const at = (stages: readonly SetupStage[], id: string) => stages.find(stage => stage.id === id)!;
  it('a fresh dev machine: repository after the folder stage, the runtime after the sandbox stage, sign-ins after the model stage', () => {
    const plan = planSetup(observation({ execution: ready, coding: repo }), undefined, registry);
    expect(plan.stages.map(stage => stage.id)).toEqual(['core:language', 'core:environment', 'core:folder', 'coding:repository', 'core:profile', 'core:policy',
      'core:sandbox', 'core:final-check', 'execution:runtime', 'execution:worker', 'execution:worker-settings', 'core:model', 'coding:hosts']);
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
