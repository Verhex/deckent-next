import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceScope, probeShellCapabilities, resolveShellRealm, hostShellRealm, type ShellCapabilities,
  type ShellSandboxLayout } from '#adapters/index.js';
import { bubblewrapArguments, bubblewrapShellSandbox, resolveBubblewrapView, BUBBLEWRAP_KNOWN_PATHS } from '#adapters/core/shell-sandbox-bwrap/index.js';

// S9 at the real boundary: the installed bubblewrap, a real bash, a real project with a `.git`, a real HOME with a secret, a scratch area.
const capabilities = await probeShellCapabilities();
const sandboxReady = capabilities.bubblewrap === 'available' && capabilities.userNamespace === 'available' && existsSync('/usr/bin/bwrap');
const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const linux = (overrides: Partial<ShellCapabilities> = {}): ShellCapabilities => ({ platform: 'linux', bubblewrap: 'available', userNamespace: 'available',
  landlock: { status: 'available', abi: 7 }, ...overrides });

/** A project (git repository) with denied files, a HOME with a secret and a PATH toolchain, a scratch area — all under /tmp like the runtime fixtures. */
async function fixture(options: { worktree?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-bwrap-')); roots.push(root);
  const home = join(root, 'home'), scratch = join(root, 'data', 'state', 'scratch', 'owner', 'session'), main = join(root, 'main');
  const project = options.worktree ? join(root, 'worktree') : main;
  await Promise.all([mkdir(join(home, '.ssh'), { recursive: true, mode: 0o700 }), mkdir(join(home, 'tools', 'bin'), { recursive: true }),
    mkdir(join(home, 'tools', 'lib'), { recursive: true }), mkdir(scratch, { recursive: true, mode: 0o700 }), mkdir(join(main, 'src'), { recursive: true }),
    mkdir(join(main, 'secrets'), { recursive: true }), mkdir(join(main, '.deckent', 'host'), { recursive: true }), mkdir(join(main, '.brain'), { recursive: true }),
    mkdir(join(main, 'node_modules', 'pkg'), { recursive: true })]);
  await Promise.all([writeFile(join(home, '.ssh', 'id_test'), 'SECRET-HOME-KEY\n', { mode: 0o600 }), writeFile(join(home, 'note.txt'), 'SECRET-HOME-NOTE\n'),
    writeFile(join(home, 'tools', 'bin', 'hello'), '#!/bin/sh\necho hello-from-tools; cat "$(dirname "$0")/../lib/data.txt"\n', { mode: 0o755 }),
    writeFile(join(home, 'tools', 'lib', 'data.txt'), 'lib-data\n'), writeFile(join(main, 'src', 'a.ts'), 'export const a = 1;\n'),
    writeFile(join(main, '.env'), 'SECRET-ENV=1\n'), writeFile(join(main, 'secrets', 'key.pem'), 'SECRET-PEM\n'),
    writeFile(join(main, '.deckent', 'host', 'channel.md'), 'SECRET-CHANNEL\n'), writeFile(join(main, '.brain', 'memory.db'), 'SECRET-BRAIN\n'),
    writeFile(join(main, '.gitignore'), '.brain/\nnode_modules/\n'), writeFile(join(main, 'node_modules', 'pkg', '.npmrc'), 'not-masked-ignored-dir\n')]);
  await symlink('.env', join(main, 'env-link'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: main, env: { ...process.env, HOME: home, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a',
    GIT_COMMITTER_EMAIL: 'a@x' }, stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('add', 'src'); git('commit', '-q', '-m', 'init');
  if (options.worktree) git('worktree', 'add', '-q', project, '-b', 'lane');
  const scope = await createWorkspaceScope(project);
  const layout: ShellSandboxLayout = { project: scope, scratchDir: scratch };
  const environment = { HOME: home, PATH: `${join(home, 'tools', 'bin')}:/usr/local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8' };
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
  it('bounds the tmpfs mounts and ends before the command', () => {
    expect(at('--size', String(64 * 1024 * 1024), '--tmpfs', '/tmp')).toBeGreaterThan(-1);
    expect(args.at(-1)).not.toBe('--');
    expect(BUBBLEWRAP_KNOWN_PATHS).toContain('/usr/bin/bwrap');
  });
});

describe('bubblewrap realm selection (S9)', () => {
  it('is chosen under prefer/require when bubblewrap and the user namespace are available, never under host', async () => {
    const f = await fixture();
    const usable = f.sandbox.usable(linux());
    if (!sandboxReady) { expect(usable.ok).toBe(false); return; }
    expect(resolveShellRealm('prefer-sandbox', linux(), [f.sandbox])).toMatchObject({ ok: true, realm: { kind: 'bubblewrap' }, notice: null, posture: expect.stringContaining('bubblewrap') });
    expect(resolveShellRealm('require-sandbox', linux(), [f.sandbox])).toMatchObject({ ok: true, realm: { kind: 'bubblewrap' }, notice: null });
    expect(resolveShellRealm('host', linux(), [f.sandbox])).toMatchObject({ ok: true, realm: hostShellRealm, notice: null, posture: expect.stringContaining('not a sandbox') });
  });
  it('is unusable without the binary at a known path, without the user namespace, or with an unknown measurement — visibly, never a silent fallback', async () => {
    const f = await fixture();
    const missing = bubblewrapShellSandbox(f.layout, { binaryPaths: [join(f.root, 'no-bwrap')] });
    expect(missing.usable(linux())).toMatchObject({ ok: false, reason: expect.stringContaining('bwrap') });
    expect(f.sandbox.usable(linux({ bubblewrap: 'unavailable' }))).toMatchObject({ ok: false, reason: expect.stringContaining('bubblewrap') });
    expect(f.sandbox.usable(linux({ userNamespace: 'unknown' }))).toMatchObject({ ok: false, reason: expect.stringContaining('user namespace') });
    expect(resolveShellRealm('prefer-sandbox', linux({ userNamespace: 'unavailable' }), [f.sandbox])).toMatchObject({ ok: true, realm: { kind: 'host' },
      notice: expect.stringMatching(/^\[deckent\] sandbox: none; .*bubblewrap: .*user namespace/u) });
    expect(resolveShellRealm('require-sandbox', linux({ userNamespace: 'unavailable' }), [f.sandbox])).toEqual({ ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE' });
    expect(resolveShellRealm('require-sandbox', linux(), [missing])).toEqual({ ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE' });
  });
  it('lays out the view from the scope: deny floor masks, every .git read-only, symlinks and ignored directories untouched', async () => {
    const f = await fixture();
    const view = await resolveBubblewrapView(f.layout, f.environment);
    if (!view.ok) throw new Error(view.reason);
    expect(view.view).toMatchObject({ projectRoot: f.scope.root, scratchDir: f.scratch, home: f.home });
    expect(view.view.maskedFiles).toEqual(expect.arrayContaining([join(f.scope.root, '.env'), join(f.scope.root, 'secrets', 'key.pem'), join(f.scope.root, '.brain', 'memory.db')]));
    expect(view.view.maskedDirectories).toContain(join(f.scope.root, '.deckent', 'host'));
    expect(view.view.readOnlyPaths).toEqual([join(f.scope.root, '.git')]);
    const all = [...view.view.maskedFiles, ...view.view.maskedDirectories];
    expect(all).not.toContain(join(f.scope.root, 'env-link')); expect(all).not.toContain(join(f.scope.root, 'src', 'a.ts'));
    expect(all.some(path => path.includes('node_modules'))).toBe(false);
    expect(view.view.maskedFiles.some(path => path.endsWith('/node_modules/pkg/.npmrc'))).toBe(false);
    expect(view.view.toolchainPaths).toEqual([join(f.home, 'tools', 'bin'), join(f.home, 'tools', 'lib')]);
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
    const args = bubblewrapArguments(view.view);
    const bound = args.flatMap((arg, i) => ['--bind', '--ro-bind', '--ro-bind-try'].includes(arg) ? [args[i + 2]] : []);
    for (const path of [f.home, dirname(f.home), '/home', '/', join(f.home, '.local'), join(f.home, '.local', 'share'), dirname(f.scope.root)]) expect(bound).not.toContain(path);
  });
  it('binds the gitdir and common dir of a worktree read-only', async () => {
    const f = await fixture({ worktree: true });
    const view = await resolveBubblewrapView(f.layout, f.environment);
    if (!view.ok) throw new Error(view.reason);
    expect(view.view.readOnlyPaths).toEqual(expect.arrayContaining([join(f.main, '.git', 'worktrees', 'worktree'), join(f.main, '.git')]));
  });
});

describe.skipIf(!sandboxReady)('bubblewrap realm with the real bwrap and a real shell (S9)', () => {
  it('hides HOME and the deny floor, keeps the project and the scratch area writable, and the PATH toolchain reachable read-only', async () => {
    const f = await fixture();
    const result = await f.run('cat .env secrets/key.pem .deckent/host/channel.md .brain/memory.db env-link 2>&1; ls -A ~ 2>&1; cat ~/.ssh/id_test ~/note.txt 2>&1;'
      + ' echo project > made.txt; echo scratch > "$TMPDIR/made.txt"; hello; echo tool > ~/tools/bin/z 2>&1; echo "tool-write=$?"; echo leak > .env 2>&1; echo "env-write=$?"; echo "pid=$$"');
    expect(result.status).toBe('exited');
    expect(result.output).not.toContain('SECRET');
    expect(result.output).toMatch(/cat: \.env: Permission denied/u); expect(result.output).toMatch(/cat: \.brain\/memory\.db: Permission denied/u);
    expect(result.output).toMatch(/cat: \.deckent\/host\/channel\.md: No such file or directory/u);
    expect(result.output).toContain('hello-from-tools\nlib-data\n');
    expect(result.output).toMatch(/tool-write=1/u); expect(result.output).toMatch(/env-write=1/u);
    expect(result.output).toMatch(/id_test: No such file or directory/u);
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
  it('reads a worktree through its read-only gitdir and refuses writes there', async () => {
    const f = await fixture({ worktree: true });
    const gitdir = join(f.main, '.git', 'worktrees', 'worktree');
    const result = await f.run(`git status --short; echo "status=$?"; git log --oneline -1 | wc -l; echo x >> "${gitdir}/config" 2>&1; echo "gitdir=$?"; echo x >> "${f.main}/.git/config" 2>&1; echo "common=$?"`);
    expect(result.output).toMatch(/status=0\n1\n/u); expect(result.output).toMatch(/gitdir=1/u); expect(result.output).toMatch(/common=1/u);
  });
  it('has no network: a port the host reaches is unreachable from the sandbox', async () => {
    const f = await fixture();
    const server = createServer(socket => socket.end('hello')); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
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
