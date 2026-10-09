import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:net';
import { listenTcpFixture } from '../support/tcp-fixture-server.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bubblewrapObservation, buildLandlockRules, createWorkspaceScope, resolveShellRealm, hostShellRealm, type ShellCapabilities,
  type ShellSandboxLayout } from '#adapters/index.js';
import { bubblewrapArguments, bubblewrapShellSandbox, resolveBubblewrapView, BUBBLEWRAP_KNOWN_PATHS } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

// S9 at the real boundary: the installed bubblewrap, a real bash, a real project with a `.git`, a real HOME with a secret, a scratch area.
const capabilities = await measureTestShellHost();
const sandboxReady = capabilities.bubblewrap.status === 'available';
const roots: string[] = [], servers: Server[] = [], locked: string[] = [];
const DEEP = Array.from({ length: 34 }, () => 'd').join('/');
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const dir of locked.splice(0)) await chmod(dir, 0o700).catch(() => undefined);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
/** This host's measurement (its bubblewrap observation: the selected launcher, BWRAP-SELECT) with a fixed Landlock ABI. */
const linux = (overrides: Partial<ShellCapabilities> = {}): ShellCapabilities => ({ ...capabilities, landlock: { status: 'available', abi: 7 }, ...overrides });

/** A project (git repository) with denied files, a HOME with a secret and a PATH toolchain, a scratch area — all under /tmp like the runtime fixtures. */
async function fixture(options: { worktree?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-bwrap-')); roots.push(root);
  const home = join(root, 'home'), scratch = join(root, 'data', 'state', 'scratch', 'owner', 'session'), main = join(root, 'main');
  const project = options.worktree ? join(root, 'worktree') : main;
  await Promise.all([mkdir(join(home, '.ssh'), { recursive: true, mode: 0o700 }), mkdir(join(home, 'tools', 'bin'), { recursive: true }),
    mkdir(join(home, 'tools', 'lib'), { recursive: true }), mkdir(scratch, { recursive: true, mode: 0o700 }), mkdir(join(main, 'src'), { recursive: true }),
    mkdir(join(main, 'secrets'), { recursive: true }), mkdir(join(main, '.deckent', 'host'), { recursive: true }), mkdir(join(main, '.brain'), { recursive: true }),
    mkdir(join(main, 'node_modules', 'pkg'), { recursive: true }), mkdir(join(home, 'tools2', 'bin'), { recursive: true }), mkdir(join(main, DEEP), { recursive: true }),
    mkdir(join(main, 'locked'), { recursive: true })]);
  await Promise.all([writeFile(join(home, '.ssh', 'id_test'), 'SECRET-HOME-KEY\n', { mode: 0o600 }), writeFile(join(home, 'note.txt'), 'SECRET-HOME-NOTE\n'),
    writeFile(join(home, 'tools', 'bin', 'hello'), '#!/bin/sh\necho hello-from-tools; cat "$(dirname "$0")/../lib/data.txt"\n', { mode: 0o755 }),
    writeFile(join(home, 'tools', 'lib', 'data.txt'), 'lib-data\n'), writeFile(join(main, 'src', 'a.ts'), 'export const a = 1;\n'),
    writeFile(join(main, '.env'), 'SECRET-ENV=1\n'), writeFile(join(main, 'secrets', 'key.pem'), 'SECRET-PEM\n'),
    writeFile(join(main, '.deckent', 'host', 'channel.md'), 'SECRET-CHANNEL\n'), writeFile(join(main, '.brain', 'memory.db'), 'SECRET-BRAIN\n'),
    writeFile(join(main, '.gitignore'), '.brain/\nnode_modules/\n'), writeFile(join(main, 'node_modules', 'pkg', '.npmrc'), 'not-masked-ignored-dir\n'),
    writeFile(join(main, DEEP, '.env'), 'SECRET-DEEP\n'), writeFile(join(main, 'locked', '.env'), 'SECRET-LOCKED\n'), writeFile(join(main, 'plain.txt'), 'plain\n')]);
  await symlink('.env', join(main, 'env-link'));
  // Astra 2154: another name of the protected inode; a toolchain whose `lib` sibling is a link to HOME; a directory the walk cannot read.
  await link(join(main, '.env'), join(main, 'alias.txt')); await symlink(home, join(home, 'tools2', 'lib'));
  await chmod(join(main, 'locked'), 0o000); locked.push(join(main, 'locked'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: main, env: { ...process.env, HOME: home, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a',
    GIT_COMMITTER_EMAIL: 'a@x' }, stdio: 'pipe', timeout: 10_000 });
  git('init', '-q', '-b', 'main'); git('add', 'src'); git('commit', '-q', '-m', 'init');
  if (options.worktree) git('worktree', 'add', '-q', project, '-b', 'lane');
  const scope = await createWorkspaceScope(project);
  const layout: ShellSandboxLayout = { project: scope, scratchDir: scratch };
  const environment = { HOME: home, PATH: `${join(home, 'tools', 'bin')}:${join(home, 'tools2', 'bin')}:/usr/local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8' };
  const sandbox = bubblewrapShellSandbox(layout);
  const usable = sandbox.usable(capabilities);
  const run = (command: string, extra: { signal?: AbortSignal; timeoutMs?: number } = {}) => {
    if (!usable.ok) throw new Error(usable.reason);
    return usable.realm.run({ command, cwd: scope.root, environment, fixedEnv: { TMPDIR: scratch }, timeoutMs: extra.timeoutMs ?? 20_000, ...(extra.signal ? { signal: extra.signal } : {}) });
  };
  return { root, home, scratch, main, project, scope, layout, environment, sandbox, run };
}

/** Processes on this host whose command line carries `marker` (this process excluded). */
async function processesWith(marker: string): Promise<number[]> {
  const found: number[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) continue;
    try { if ((await readFile(`/proc/${entry}/cmdline`, 'latin1')).includes(marker)) found.push(Number(entry)); } catch { /* gone */ }
  }
  return found;
}

describe('bubblewrap argument contract (S9, pure)', () => {
  const view = { projectRoot: '/tmp/x/project', scratchDir: '/tmp/x/data/state/scratch/o/s', home: '/tmp/x/home', systemPaths: ['/usr', '/etc'],
    toolchainPaths: ['/tmp/x/home/tools/bin', '/tmp/x/home/tools/lib'], readOnlyPaths: ['/tmp/x/project/.git'],
    maskedDirectories: ['/tmp/x/project/.deckent/host'], maskedFiles: ['/tmp/x/project/.env'] };
  const args = bubblewrapArguments(view);
  const at = (...pair: string[]) => { for (let i = 0; i + pair.length <= args.length; i++) if (pair.every((part, j) => args[i + j] === part)) return i; return -1; };
  it('unshares everything, dies with the parent, starts a new session and never binds HOME', () => {
    for (const flag of ['--unshare-all', '--die-with-parent', '--new-session']) expect(args).toContain(flag);
    expect(at('--tmpfs', '/tmp/x/home')).toBeGreaterThan(-1);
    expect(at('--bind', '/tmp/x/home', '/tmp/x/home')).toBe(-1); expect(at('--ro-bind', '/tmp/x/home', '/tmp/x/home')).toBe(-1);
    expect(args.filter(arg => arg === '--share-net')).toEqual([]);
    expect(at('--proc', '/proc')).toBeGreaterThan(-1); expect(at('--dev', '/dev')).toBeGreaterThan(-1); expect(at('--chdir', '/tmp/x/project')).toBeGreaterThan(-1);
  });
  it('mounts in a load-bearing order: tmpfs /tmp and HOME, system and toolchain read-only, project rw, .git ro, masks, scratch rw', () => {
    const order = [at('--tmpfs', '/tmp'), at('--tmpfs', '/tmp/x/home'), at('--ro-bind-try', '/usr', '/usr'), at('--ro-bind-try', '/tmp/x/home/tools/bin', '/tmp/x/home/tools/bin'),
      at('--bind', '/tmp/x/project', '/tmp/x/project'), at('--ro-bind', '/tmp/x/project/.git', '/tmp/x/project/.git'), at('--tmpfs', '/tmp/x/project/.deckent/host'),
      at('--ro-bind', '/dev/null', '/tmp/x/project/.env'), at('--bind', '/tmp/x/data/state/scratch/o/s', '/tmp/x/data/state/scratch/o/s')];
    expect(order.every(index => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('an emptied product-state directory is an empty tmpfs that is remounted read-only after every mount, the scratch bind inside it included (SANDBOX-AD-SIZINTISI)', () => {
    const emptied = bubblewrapArguments({ ...view, emptiedDirectories: ['/tmp/x/project/.deckent/data'], scratchDir: '/tmp/x/project/.deckent/data/state/scratch/o/s' });
    const index = (...pair: string[]) => { for (let i = 0; i + pair.length <= emptied.length; i++) if (pair.every((part, j) => emptied[i + j] === part)) return i; return -1; };
    const tmpfs = index('--perms', '0555', '--tmpfs', '/tmp/x/project/.deckent/data'), scratch = index('--bind', '/tmp/x/project/.deckent/data/state/scratch/o/s', '/tmp/x/project/.deckent/data/state/scratch/o/s');
    const remount = index('--remount-ro', '/tmp/x/project/.deckent/data');
    expect(tmpfs).toBeGreaterThan(index('--bind', '/tmp/x/project', '/tmp/x/project'));
    expect(scratch).toBeGreaterThan(tmpfs); expect(remount).toBeGreaterThan(scratch);
    // Without the field the arguments carry no remount at all: nothing else changed.
    expect(args).not.toContain('--remount-ro');
  });
  it('bounds the tmpfs mounts and ends before the command', () => {
    expect(at('--size', String(64 * 1024 * 1024), '--tmpfs', '/tmp')).toBeGreaterThan(-1);
    expect(args.at(-1)).not.toBe('--');
    expect(BUBBLEWRAP_KNOWN_PATHS).toContain('/usr/bin/bwrap');
  });
});

describe.skipIf(process.platform === 'win32')('bubblewrap realm selection (S9; requires POSIX filesystem permissions and paths)', () => {
  it('is chosen under prefer/require when bubblewrap and the user namespace are available, never under host', async () => {
    const f = await fixture();
    const usable = f.sandbox.usable(linux());
    if (!sandboxReady) { expect(usable.ok).toBe(false); return; }
    const OWNER_APPROVED_STANDART = { projectReadOnly: false, writeFloorReadOnly: false, repositoryWritable: false };
    const prefer = resolveShellRealm('prefer-sandbox', linux(), [f.sandbox]);
    expect(prefer).toMatchObject({ ok: true, realm: { kind: 'bubblewrap' }, notice: null });
    expect(prefer.ok && prefer.posture(OWNER_APPROVED_STANDART)).toContain('bubblewrap');
    expect(resolveShellRealm('require-sandbox', linux(), [f.sandbox])).toMatchObject({ ok: true, realm: { kind: 'bubblewrap' }, notice: null });
    const host = resolveShellRealm('host', linux(), [f.sandbox]);
    expect(host).toMatchObject({ ok: true, realm: hostShellRealm, notice: null });
    expect(host.ok && host.posture(OWNER_APPROVED_STANDART)).toContain('not a sandbox');
  });
  it('is unusable without a selected launcher, with a restricted or unknown measurement, or when the launcher is gone — visibly, never a silent fallback', async () => {
    const f = await fixture();
    const none = linux({ bubblewrap: bubblewrapObservation('unavailable', 'bwrap at /usr/bin/bwrap: version 0.9.0 is below the minimum 0.12.0') });
    expect(f.sandbox.usable(none)).toMatchObject({ ok: false, reason: expect.stringMatching(/^bubblewrap unavailable \(.*below the minimum/u) });
    expect(f.sandbox.usable(linux({ bubblewrap: bubblewrapObservation('unknown') }))).toMatchObject({ ok: false, reason: 'bubblewrap unknown' });
    const restricted = linux({ bubblewrap: { ...bubblewrapObservation('restricted', 'bwrap at /x: setting up uid map: Permission denied; the kernel refuses bubblewrap the user namespace'),
      restriction: { kind: 'user-namespace', hint: 'the kernel refuses bubblewrap the user namespace' } } });
    expect(f.sandbox.usable(restricted)).toMatchObject({ ok: false, restricted: true, reason: expect.stringContaining('user namespace') });
    // Realm admission is Linux-only; a synthetic Linux measurement checks the pure resolver without claiming this host supports it.
    const selectedHost = { ...restricted, platform: 'linux' as const };
    expect(resolveShellRealm('prefer-sandbox', selectedHost, [f.sandbox])).toMatchObject({ ok: true, realm: { kind: 'host' },
      notice: expect.stringMatching(/^\[deckent\] sandbox: none; .*bubblewrap: .*user namespace/u) });
    expect(resolveShellRealm('require-sandbox', { ...none, platform: 'linux' }, [f.sandbox])).toEqual({ ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE',
      rejected: [{ kind: 'bubblewrap', reason: expect.stringMatching(/^bubblewrap unavailable \(.*below the minimum/u) }] });
    const gone = linux({ bubblewrap: { status: 'available', rejected: [], restriction: null, detail: null,
      launcher: { source: 'system', path: join(f.root, 'no-bwrap'), version: '0.13.0', sha256: null, overlay: true, identity: '0:0:0:0:0' } } });
    expect(f.sandbox.usable(gone)).toMatchObject({ ok: false, reason: expect.stringMatching(/no-bwrap is gone/u) });
    expect(resolveShellRealm('require-sandbox', { ...gone, platform: 'linux' }, [f.sandbox])).toEqual({ ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE',
      rejected: [{ kind: 'bubblewrap', reason: expect.stringMatching(/no-bwrap is gone/u) }] });
  });
  it('lays out the view from the scope: deny floor masks, every .git read-only, symlinks and ignored directories untouched', async () => {
    const f = await fixture();
    const view = await resolveBubblewrapView(f.layout, f.environment);
    if (!view.ok) throw new Error(view.reason);
    expect(view.view).toMatchObject({ projectRoot: f.scope.root, scratchDir: f.scratch, home: f.home });
    expect(view.view.maskedFiles).toEqual(expect.arrayContaining([join(f.scope.root, '.env'), join(f.scope.root, 'secrets', 'key.pem'),
      join(f.scope.root, 'alias.txt')]));
    // SANDBOX-AD-SIZINTISI: `.brain` holds the protected `memory.db` and nothing else, so it is one empty tmpfs (no per-file mask that would list the name).
    expect(view.view.emptiedDirectories).toContain(join(f.scope.root, '.brain'));
    expect(view.view.maskedFiles).not.toContain(join(f.scope.root, '.brain', 'memory.db'));
    expect(view.view.maskedFiles).not.toContain(join(f.scope.root, 'plain.txt'));
    // Astra 2154 R3: what the walk could not see is closed — the unreadable directory and the subtree beyond the depth bound are masked.
    
    // The layout root itself is never emptied (a command may create `.deckent/docs`); its denied `host` keeps its own mask.
    expect(view.view.emptiedDirectories ?? []).not.toContain(join(f.scope.root, '.deckent'));
    expect(view.view.maskedDirectories).toEqual(expect.arrayContaining([join(f.scope.root, '.deckent', 'host'), join(f.scope.root, 'locked'),
      join(f.scope.root, Array.from({ length: 33 }, () => 'd').join('/'))]));
    // Owner Y (2026-09-30) / lead fix round 2026-10-09: without the turn's hard floor only the default layout's authority/state resources are
    // floored, never `.deckent` whole (this fixture holds none of them), so `.deckent` stays writable for `.deckent/docs`.
    expect(view.view.readOnlyPaths).toEqual([join(f.scope.root, '.git')]);
    const all = [...view.view.maskedFiles, ...view.view.maskedDirectories, ...view.view.emptiedDirectories ?? []];
    expect(all).not.toContain(join(f.scope.root, 'env-link')); expect(all).not.toContain(join(f.scope.root, 'src', 'a.ts'));
    expect(all.some(path => path.includes('node_modules'))).toBe(false);
    expect(view.view.maskedFiles.some(path => path.endsWith('/node_modules/pkg/.npmrc'))).toBe(false);
    // Astra 2154 R1: `tools2/lib -> HOME` is not a canonical directory and is never a bind; the canonical `tools/lib` is.
    expect(view.view.toolchainPaths).toEqual([join(f.home, 'tools', 'bin'), join(f.home, 'tools', 'lib'), join(f.home, 'tools2', 'bin')]);
    expect(view.view.systemPaths).toContain('/usr'); expect(view.view.systemPaths.some(path => path.startsWith('/mnt') || path === '/run' || path === '/var')).toBe(false);
  });
  it('never binds HOME, an ancestor of HOME, the project or a non-program directory from PATH, only bin-like entries', async () => {
    const f = await fixture();
    await mkdir(join(f.home, '.local', 'share'), { recursive: true }); await mkdir(join(f.home, '.local', 'bin'), { recursive: true });
    const entries = [f.home, dirname(f.home), '/home', '/', join(f.home, '.local'), join(f.home, '.local', 'share'), f.scope.root, dirname(f.scope.root), f.scratch,
      join(f.home, 'tools', 'bin'), join(f.home, '.local', 'bin'), '/mnt/c/Windows', join(f.home, 'nowhere', 'bin')];
    const view = await resolveBubblewrapView(f.layout, { ...f.environment, PATH: entries.join(':') });
    if (!view.ok) throw new Error(view.reason);
    expect(view.view.toolchainPaths).toEqual([join(f.home, 'tools', 'bin'), join(f.home, 'tools', 'lib'), join(f.home, '.local', 'bin')]);
    const linked = await resolveBubblewrapView(f.layout, { ...f.environment, PATH: [join(f.home, 'tools2', 'bin'), join(f.home, 'tools2', 'lib', 'tools', 'bin')].join(':') });
    if (!linked.ok) throw new Error(linked.reason);
    // The entry behind the link resolves to the canonical `tools/bin` (admitted); the link itself and its `lib -> HOME` are never binds.
    expect(linked.view.toolchainPaths).toEqual([join(f.home, 'tools2', 'bin'), join(f.home, 'tools', 'bin'), join(f.home, 'tools', 'lib')]);
    const args = bubblewrapArguments(view.view);
    const bound = args.flatMap((arg, i) => ['--bind', '--ro-bind', '--ro-bind-try'].includes(arg) ? [args[i + 2]] : []);
    for (const path of [f.home, dirname(f.home), '/home', '/', join(f.home, '.local'), join(f.home, '.local', 'share'), dirname(f.scope.root)]) expect(bound).not.toContain(path);
  });
  it('binds the gitdir and common dir of a worktree read-only', async () => {
    const f = await fixture({ worktree: true });
    const view = await resolveBubblewrapView(f.layout, f.environment);
    if (!view.ok) throw new Error(view.reason);
    expect(view.view.readOnlyPaths).toEqual([join(f.scope.root, '.git'), join(f.main, '.git')]);
  });
  // Merge Astra 2170 x MODES-3: a full-access turn's layout writes the repository (and a worktree's common one), but a call whose project is
  // read-only keeps the repository read-only too — in both realms (no writable common repository under a read-only project).
  it('writes the repository of a full-access layout only while the call\'s project is writable (bubblewrap and Landlock)', async () => {
    const f = await fixture({ worktree: true });
    const layout = { ...f.layout, writeFloor: null, repositoryWritable: true }, common = join(f.main, '.git');
    const writable = await resolveBubblewrapView(layout, f.environment), readOnly = await resolveBubblewrapView(layout, f.environment, {}, { projectReadOnly: true });
    if (!writable.ok || !readOnly.ok) throw new Error('view refused');
    expect({ writable: writable.view.writablePaths, readOnly: writable.view.readOnlyPaths }).toEqual({ writable: [common], readOnly: [] });
    expect({ writable: readOnly.view.writablePaths, readOnly: readOnly.view.readOnlyPaths }).toEqual({ writable: undefined, readOnly: [join(f.scope.root, '.git'), common] });
    expect(bubblewrapArguments(readOnly.view).join(' ')).toContain(`--ro-bind ${f.scope.root} ${f.scope.root}`);
    const rules = async (projectReadOnly: boolean) => { const built = await buildLandlockRules(layout, {}, undefined, { projectReadOnly }); if (!built.ok) throw new Error(built.reason);
      return built.rules.filter(([cls, path]) => cls === 'w' && (path === '.git' || path.startsWith(common))).map(([, path]) => path); };
    expect((await rules(false)).length).toBeGreaterThan(0);
    expect(await rules(true)).toEqual([]);
  });
  it('a forged .git pointer opens nothing outside: nested files are ignored, the root file only in the verified worktree shape', async () => {
    const f = await fixture({ worktree: true });
    await mkdir(join(f.project, 'sub')); await writeFile(join(f.project, 'sub', '.git'), `gitdir: ${f.home}\n`);
    await mkdir(join(f.project, 'fake')); await writeFile(join(f.project, 'fake', 'commondir'), `${f.home}\n`);
    await writeFile(join(f.project, '.git'), 'gitdir: ./fake\n');
    const view = await resolveBubblewrapView(f.layout, f.environment);
    if (!view.ok) throw new Error(view.reason);
    expect(view.view.readOnlyPaths).toEqual([join(f.scope.root, '.git')]);
    const bound = bubblewrapArguments(view.view).flatMap((arg, i, args) => ['--bind', '--ro-bind', '--ro-bind-try'].includes(arg) ? [args[i + 2]] : []);
    expect(bound.some(path => path === f.home || path!.startsWith(`${f.home}/`) && !path!.startsWith(join(f.home, 'tools')))).toBe(false);
  });
});

describe.skipIf(!sandboxReady)('bubblewrap realm with the real bwrap and a real shell (S9)', () => {
  it('hides HOME and the deny floor, keeps the project and the scratch area writable, and the PATH toolchain reachable read-only', async () => {
    const f = await fixture();
    const result = await f.run('cat .env secrets/key.pem .deckent/host/channel.md .brain/memory.db env-link 2>&1; ls -A ~ 2>&1; cat ~/.ssh/id_test ~/note.txt 2>&1;'
      + ' echo project > made.txt; echo scratch > "$TMPDIR/made.txt"; hello; echo tool > ~/tools/bin/z 2>&1; echo "tool-write=$?"; echo leak > .env 2>&1; echo "env-write=$?"; echo "pid=$$"');
    expect(result.status).toBe('exited');
    expect(result.output).not.toContain('SECRET');
    expect(result.output).toMatch(/cat: \.env: Permission denied/u); expect(result.output).toMatch(/cat: \.brain\/memory\.db: No such file or directory/u); // the directory is an empty tmpfs: the name is not there either
    expect(result.output).toMatch(/cat: \.deckent\/host\/channel\.md: No such file or directory/u);
    expect(result.output).toContain('hello-from-tools\nlib-data\n');
    expect(result.output).toMatch(/tool-write=1/u); expect(result.output).toMatch(/env-write=1/u);
    expect(result.output).toMatch(/id_test: No such file or directory/u);
    expect(await readFile(join(f.project, '.env'), 'utf8')).toBe('SECRET-ENV=1\n');
    // Astra 2154 R1/R2/R3 with the real bwrap: the linked alias, the HOME behind `tools2/lib`, the deep and the locked `.env` stay closed;
    // a plain single-link file and the canonical toolchain stay open.
    const astra = await f.run(`cat alias.txt 2>&1; echo x >> alias.txt 2>&1; echo "alias-write=$?"; cat plain.txt; cat ~/tools2/lib/note.txt 2>&1; ls ~/tools2/lib 2>&1;`
      + ` cat ${DEEP}/.env 2>&1; chmod 700 locked 2>&1; cat locked/.env 2>&1; ls locked 2>&1 | wc -l`);
    expect(astra.output).not.toContain('SECRET');
    // Streams are checked line by line, never for their interleaving (stdout and stderr arrive in their own order; Astra 2162 R2).
    const lines = astra.output.split('\n');
    expect(lines).toContain('cat: alias.txt: Permission denied'); expect(lines.some(line => line.endsWith('alias.txt: Permission denied') && line.startsWith('bash:'))).toBe(true);
    expect(lines).toContain('alias-write=1'); expect(lines).toContain('plain');
    expect(lines.some(line => line.endsWith('tools2/lib/note.txt: No such file or directory'))).toBe(true);
    expect(lines).toContain('cat: locked/.env: No such file or directory'); expect(lines.filter(line => line === '0')).toHaveLength(1);
    expect(lines.some(line => line.includes(`${DEEP}/.env: No such file or directory`))).toBe(true);
    expect(await readFile(join(f.project, '.env'), 'utf8')).toBe('SECRET-ENV=1\n');
    expect(await readFile(join(f.project, 'made.txt'), 'utf8')).toBe('project\n');
    expect(await readFile(join(f.scratch, 'made.txt'), 'utf8')).toBe('scratch\n');
    expect(result.cleanup).toBe('clean');
  });
  it('refuses writes to /etc, to .git and to the host HOME; git still reads the repository', async () => {
    const f = await fixture();
    const before = await readFile(join(f.project, '.git', 'config'), 'utf8');
    const result = await f.run('echo x > /etc/deckent-probe 2>&1; echo "etc=$?"; echo x >> .git/config 2>&1; echo "git=$?"; touch ~/marker; echo "home=$?"; git status --short; echo "status=$?"');
    expect(result.output).toMatch(/Read-only file system/u);
    expect(result.output).toMatch(/etc=1/u); expect(result.output).toMatch(/git=1/u); expect(result.output).toMatch(/home=0/u); expect(result.output).toMatch(/status=0/u);
    expect(await readFile(join(f.project, '.git', 'config'), 'utf8')).toBe(before);
    expect(existsSync(join(f.home, 'marker'))).toBe(false); expect(existsSync('/etc/deckent-probe')).toBe(false);
  });
  it('reads a worktree through its read-only gitdir and refuses writes there; a forged nested .git pointer still opens nothing', async () => {
    const f = await fixture({ worktree: true });
    await mkdir(join(f.project, 'sub')); await writeFile(join(f.project, 'sub', '.git'), `gitdir: ${f.home}\n`);
    const forged = await f.run('cat ~/note.txt 2>&1; echo x > .git 2>&1; echo "gitfile=$?"');
    // The shell reports a failed redirection on its own stderr, so its order against stdout is not fixed: check each line alone.
    expect(forged.output).toMatch(/note\.txt: No such file or directory/u); expect(forged.output).toMatch(/\.git: Read-only file system/u);
    expect(forged.output).toMatch(/^gitfile=1$/mu); expect(forged.output).not.toContain('SECRET');
    const gitdir = join(f.main, '.git', 'worktrees', 'worktree');
    const result = await f.run(`git status --short; echo "status=$?"; git log --oneline -1 | wc -l; echo x >> "${gitdir}/config" 2>&1; echo "gitdir=$?"; echo x >> "${f.main}/.git/config" 2>&1; echo "common=$?"`);
    expect(result.output).toMatch(/status=0\n1\n/u); expect(result.output).toMatch(/gitdir=1/u); expect(result.output).toMatch(/common=1/u);
  });
  // Astra 2156: the inode floor applies before the git grants — a hard link to the protected `.env` named `.git` (root or nested), placed
  // inside `.git`, or inside a worktree's common repository is unreadable and unwritable; genuine git keeps working, a hard-linked local
  // clone's shared objects included.
  it('closes another name of a protected inode wherever git metadata would grant it (Astra 2156)', async () => {
    const f = await fixture({ worktree: true });
    await mkdir(join(f.project, 'sub')); await writeFile(join(f.project, '.env'), 'SECRET-WORKTREE\n');
    await link(join(f.project, '.env'), join(f.project, 'sub', '.git'));
    await link(join(f.project, '.env'), join(f.main, '.git', 'sentinel-alias'));
    await link(join(f.project, '.env'), join(f.main, '.git', 'worktrees', 'worktree', 'sentinel-alias'));
    const view = await resolveBubblewrapView(f.layout, f.environment);
    if (!view.ok) throw new Error(view.reason);
    expect(view.view.maskedFiles).toEqual(expect.arrayContaining([join(f.project, 'sub', '.git'), join(f.main, '.git', 'sentinel-alias'), join(f.main, '.git', 'worktrees', 'worktree', 'sentinel-alias')]));
    const ran = await f.run(`for p in sub/.git ${f.main}/.git/sentinel-alias ${f.main}/.git/worktrees/worktree/sentinel-alias; do cat "$p" 2>&1; echo x >> "$p" 2>&1; echo "w=$?"; done;`
      + ' git status --short; echo "status=$?"; git log --oneline -1 | wc -l');
    expect(ran.output).not.toContain('SECRET');
    expect(ran.output.match(/Permission denied/gu)?.length).toBe(6); expect(ran.output.match(/w=1/gu)?.length).toBe(3);
    expect(ran.output).toMatch(/status=0\n1\n$/u);
    expect(await readFile(join(f.project, '.env'), 'utf8')).toBe('SECRET-WORKTREE\n');
    // A root `.git` file that is another name of `.env` grants nothing (no worktree resolution, no read-only bind).
    const forged = join(f.root, 'forged'); await mkdir(forged); await writeFile(join(forged, '.env'), 'SECRET-FORGED\n'); await link(join(forged, '.env'), join(forged, '.git'));
    const forgedScope = await createWorkspaceScope(forged);
    const forgedView = await resolveBubblewrapView({ project: forgedScope, scratchDir: f.scratch }, f.environment);
    if (!forgedView.ok) throw new Error(forgedView.reason);
    expect(forgedView.view.readOnlyPaths).toEqual([]); expect(forgedView.view.maskedFiles).toEqual(expect.arrayContaining([join(forged, '.env'), join(forged, '.git')]));
  });
  it('keeps a hard-linked local clone usable: verified objects stay readable, an alias among them does not (Astra 2156)', async () => {
    const f = await fixture();
    const clone = join(f.root, 'clone');
    execFileSync('git', ['clone', '-q', f.main, clone], { env: { ...process.env, HOME: f.home }, stdio: 'pipe', timeout: 10_000 });
    const objects = execFileSync('find', [join(clone, '.git', 'objects'), '-type', 'f', '-links', '+1'], { encoding: 'utf8', timeout: 10_000 }).trim().split('\n').filter(Boolean);
    expect(objects.length).toBeGreaterThan(0);
    await writeFile(join(clone, '.env'), 'SECRET-CLONE\n'); await link(join(clone, '.env'), join(clone, '.git', 'objects', 'aa', 'a'.repeat(38)).replace(/\/aa\/a{38}$/u, '/aa/' + 'a'.repeat(38)))
      .catch(async () => { await mkdir(join(clone, '.git', 'objects', 'aa'), { recursive: true }); await link(join(clone, '.env'), join(clone, '.git', 'objects', 'aa', 'a'.repeat(38))); });
    const scope = await createWorkspaceScope(clone), layout = { project: scope, scratchDir: f.scratch };
    const view = await resolveBubblewrapView(layout, f.environment);
    if (!view.ok) throw new Error(view.reason);
    expect(view.view.maskedFiles.filter(path => path.includes('/.git/'))).toEqual([join(clone, '.git', 'objects', 'aa', 'a'.repeat(38))]);
    const usable = bubblewrapShellSandbox(layout).usable(capabilities);
    if (!usable.ok) throw new Error(usable.reason);
    const ran = await usable.realm.run({ command: `git log --oneline -1 | wc -l; git fsck --connectivity-only 2>&1 | grep -c "Could not read" ; cat .git/objects/aa/${'a'.repeat(38)} 2>&1`, cwd: scope.root, environment: f.environment,
      fixedEnv: { TMPDIR: f.scratch }, timeoutMs: 60_000 });
    const clone_lines = ran.output.split('\n').filter(Boolean);
    expect(clone_lines.filter(line => line === '1')).toHaveLength(1); expect(clone_lines.filter(line => line === '0')).toHaveLength(1);
    expect(clone_lines.some(line => line.endsWith('Permission denied'))).toBe(true); expect(clone_lines).toHaveLength(3); expect(ran.output).not.toContain('SECRET');
  });
  // Astra 2158: verdicts are taken afresh every call in the same process — a `.git` file that was clean (single-link, or a verified object)
  // and then gained another name (`.env`) and new content through it is closed on the next call, though its directory's times did not change.
  it('re-checks git metadata every call: a file that became another name of a secret after a warm call is closed (Astra 2158)', async () => {
    const f = await fixture();
    const data = Buffer.from('blob 6\0hello\n'), hash = createHash('sha1').update(data).digest('hex');
    const object = join('.git', 'objects', hash.slice(0, 2), hash.slice(2));
    await mkdir(join(f.project, '.git', 'objects', hash.slice(0, 2)), { recursive: true });
    await writeFile(join(f.project, object), deflateSync(data)); await writeFile(join(f.project, '.git', 'cached-file'), 'PUBLIC_BEFORE\n');
    const first = await f.run(`cat .git/cached-file; cat ${object} | wc -c`);
    expect(first.output).toMatch(/^PUBLIC_BEFORE\n\d+\n$/u);
    // Between two calls of the same process: link both under `.env` and write new protected content through that name.
    await rm(join(f.project, '.env')); await link(join(f.project, '.git', 'cached-file'), join(f.project, '.env')); await writeFile(join(f.project, '.env'), 'SECRET-LATER-PLAIN\n');
    await link(join(f.project, object), join(f.project, 'secrets', '.env')); await writeFile(join(f.project, 'secrets', '.env'), 'SECRET-LATER-OBJECT\n');
    const view = await resolveBubblewrapView(f.layout, f.environment);
    if (!view.ok) throw new Error(view.reason);
    expect(view.view.maskedFiles).toEqual(expect.arrayContaining([join(f.project, '.git', 'cached-file'), join(f.project, object)]));
    const warm = await f.run(`cat .git/cached-file 2>&1; cat ${object} 2>&1`);
    expect(warm.output).not.toContain('SECRET'); expect(warm.output).toMatch(/cached-file: Permission denied\n.*Permission denied\n$/u);
  });
  it('has no network: a port the host reaches is unreachable from the sandbox', async () => {
    const f = await fixture();
    // The host probe exits while the server still has unread/unsent data and resets the connection: that must not be an uncaught exception.
    const { server, port } = await listenTcpFixture(socket => socket.end('hello')); servers.push(server);
    const host = await hostShellRealm.run({ command: `exec 3<>/dev/tcp/127.0.0.1/${port} && echo host-connected`, cwd: f.project, environment: f.environment });
    expect(host.output).toContain('host-connected');
    const result = await f.run(`exec 3<>/dev/tcp/127.0.0.1/${port} && echo sandbox-connected; echo "net=$?"; cat /proc/net/dev | tail -n +3 | awk '{print $1}'`);
    expect(result.output).not.toContain('sandbox-connected');
    expect(result.output).toMatch(/net=1/u);
    expect(result.output.trim().split('\n').filter(line => line.endsWith(':'))).toEqual(['lo:']);
  });
  it('ends every process the command started with the call, even one that left the process group (PID namespace, die-with-parent)', async () => {
    const f = await fixture();
    const marker = `sleep 299.${process.pid % 1000}`;
    try {
      const result = await f.run(`setsid ${marker} > /dev/null 2>&1 & ${marker} & echo started`);
      expect(result.status).toBe('exited'); expect(result.output).toBe('started\n');
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(await processesWith(marker)).toEqual([]);
      expect(result.cleanup).toBe('clean');
    } finally { for (const pid of await processesWith(marker)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
  });
  it('cancellation and the timeout end the sandbox through the same process-group contract', async () => {
    const f = await fixture();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const cancelled = await f.run('sleep 30; echo late', { signal: controller.signal });
    expect(cancelled).toMatchObject({ status: 'cancelled', output: '' }); expect(cancelled.durationMs).toBeLessThan(5_000);
    const timed = await f.run('sleep 30; echo late', { timeoutMs: 300 });
    expect(timed).toMatchObject({ status: 'timed-out', output: '' }); expect(timed.durationMs).toBeLessThan(5_000);
  });
  it('refuses to run instead of running unmasked when the deny walk exceeds its bound', async () => {
    const f = await fixture();
    const view = await resolveBubblewrapView(f.layout, f.environment, { maxEntries: 3 });
    expect(view).toMatchObject({ ok: false, reason: expect.stringContaining('bound') });
    const sandbox = bubblewrapShellSandbox(f.layout, { maxEntries: 3 });
    const usable = sandbox.usable(capabilities);
    if (!usable.ok) throw new Error(usable.reason);
    const result = await usable.realm.run({ command: 'echo ran > must-not-exist', cwd: f.scope.root, environment: f.environment });
    expect(result).toMatchObject({ status: 'spawn-failed', output: expect.stringContaining('bound') });
    expect(existsSync(join(f.project, 'must-not-exist'))).toBe(false);
  });
});
