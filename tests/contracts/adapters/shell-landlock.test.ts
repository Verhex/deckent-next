import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLandlockRules, describeHostShellResult, hostShellRealm, landlockShellSandbox, resolveShellRealm, type ShellCapabilities } from '#adapters/core/host-shell/index.js';
import { createWorkspaceScope } from '#adapters/index.js';
import { summarizeAgentToolResult } from '#surfaces/core/terminal-kit/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const caps = (abi: number | null, bubblewrap: ShellCapabilities['bubblewrap'] = 'unavailable'): ShellCapabilities => ({ platform: 'linux', bubblewrap,
  userNamespace: 'available', landlock: abi === null ? { status: 'unavailable', abi: null } : { status: 'available', abi } });

/** A project shaped like a real one: a repository, secrets at the root and deeper, a clean tree, an ignored tree, links. */
async function project() {
  const base = await mkdtemp(join(tmpdir(), 'dn-landlock-')); roots.push(base);
  const root = join(base, 'project'), scratch = join(base, 'scratch'), outside = join(base, 'outside');
  for (const dir of [join(root, '.git', 'hooks'), join(root, 'src', 'deep'), join(root, 'pkg', 'api'), join(root, 'node_modules', 'x'), join(root, '.deckent', 'host'),
    join(root, 'docs'), scratch, outside]) await mkdir(dir, { recursive: true });
  await writeFile(join(root, '.git', 'config'), '[core]\n'); await writeFile(join(root, '.env'), 'TOP_SECRET=1\n');
  await writeFile(join(root, 'pkg', 'api', '.env'), 'DEEP_SECRET=1\n'); await writeFile(join(root, 'pkg', 'api', 'server.ts'), 'export {};\n');
  await writeFile(join(root, 'pkg', 'readme.md'), 'pkg\n'); await writeFile(join(root, 'src', 'deep', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'node_modules', 'x', 'index.js'), ''); await writeFile(join(root, '.deckent', 'host', 'channel.md'), 'private\n');
  await writeFile(join(root, 'docs', 'guide.md'), 'guide\n'); await writeFile(join(root, 'README.md'), 'readme\n');
  await writeFile(join(outside, 'secret'), 'OUTSIDE_SECRET\n');
  await symlink(outside, join(root, 'docs', 'out')); await link(join(root, '.env'), join(root, 'src', 'alias.txt'));
  // The Core deny floor (the turn adds the layout's owner-only resources to it; same predicate).
  const scope = await createWorkspaceScope(root);
  return { base, root: scope.root, scratch, outside, scope };
}

describe('Landlock rule set (S11): carve around protected paths, .git read-only', () => {
  it('grants whole clean trees, lists carved directories only, keeps .git read-only and gives protected paths and links no rule', async () => {
    const p = await project();
    const built = await buildLandlockRules({ project: p.scope, scratchDir: p.scratch });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const inProject = built.rules.filter(([, path]) => !path.startsWith('/'));
    expect(new Map(inProject.map(([cls, path]) => [path, cls]))).toEqual(new Map([
      ['.', 'l'], ['.git', 'r'], ['README.md', 'w'], ['docs', 'w'], ['node_modules', 'w'],
      ['pkg', 'l'], ['pkg/readme.md', 'w'], ['pkg/api', 'l'], ['pkg/api/server.ts', 'w'],
      ['src', 'l'], ['src/deep', 'w'], ['.deckent', 'l'], ['.deckent/host', 'l'],
    ]));
    // The scratch area is read-write; system paths read-only (with execute where binaries live); nothing under HOME or /tmp.
    expect(built.rules).toContainEqual(['w', p.scratch]);
    expect(built.rules).toContainEqual(['r', '/etc']);
    expect(built.rules.some(([cls, path]) => cls === 'x' && path === '/usr')).toBe(true);
    expect(built.rules.some(([, path]) => path === homedir() || path === '/tmp' || path === tmpdir())).toBe(false);
  });
  it('fails closed past its bounds instead of running with a partial rule set', async () => {
    const p = await project();
    const built = await buildLandlockRules({ project: p.scope, scratchDir: p.scratch }, { maxEntries: 5 });
    expect(built).toMatchObject({ ok: false, reason: expect.stringContaining('entries') });
  });
});

describe('shell realm selection with Landlock (S11)', () => {
  const sandbox = [landlockShellSandbox({ project: { root: '/nonexistent', denied: () => false, ignoredDirs: new Set<string>() }, scratchDir: null })];
  it('chooses Landlock for prefer-sandbox and require-sandbox, never for host', () => {
    for (const mode of ['prefer-sandbox', 'require-sandbox'] as const) {
      expect(resolveShellRealm(mode, caps(7), sandbox)).toMatchObject({ ok: true, realm: { kind: 'landlock' }, marker: 'sandbox: landlock', notice: null,
        posture: expect.stringContaining('Landlock') });
    }
    expect(resolveShellRealm('host', caps(7), sandbox)).toMatchObject({ ok: true, realm: hostShellRealm, notice: null, marker: null,
      posture: expect.stringContaining('not a sandbox') });
  });
  it('names what an old kernel leaves open (typed DEGRADED, visible notice)', () => {
    const degraded = resolveShellRealm('prefer-sandbox', caps(3), sandbox);
    expect(degraded).toMatchObject({ ok: true, realm: { kind: 'landlock' }, marker: 'sandbox: degraded', notice: expect.stringContaining('DEGRADED') });
    expect(degraded.ok && degraded.notice).toMatch(/signal/);
    expect(resolveShellRealm('prefer-sandbox', caps(1), sandbox)).toMatchObject({ notice: expect.stringMatching(/truncat/) });
  });
  it('without Landlock: prefer falls back visibly to the host, require refuses (a fake probe)', () => {
    expect(resolveShellRealm('prefer-sandbox', caps(null), sandbox)).toMatchObject({ ok: true, realm: { kind: 'host' }, marker: 'sandbox: none',
      notice: expect.stringContaining('sandbox: none') });
    expect(resolveShellRealm('require-sandbox', caps(null), sandbox)).toEqual({ ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE' });
    // No provider (a caller that cannot describe the project) never gets a Landlock realm.
    expect(resolveShellRealm('require-sandbox', caps(7))).toEqual({ ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE' });
  });
  it('the result names the realm in its first line; only trusted metadata carries the degraded posture to the finished line', () => {
    const ran = { status: 'exited' as const, exitCode: 0, signal: null, output: 'hi\n', totalBytes: 3, omittedBytes: 0, durationMs: 100, cleanup: 'clean' as const };
    expect(describeHostShellResult('ls', ran, { marker: 'sandbox: landlock', notice: null })).toBe('[deckent] run_shell: sandbox: landlock; exit 0 after 0.1s (ls)\nhi\n');
    const degraded = describeHostShellResult('ls', ran, { marker: 'sandbox: degraded', notice: 'N' });
    expect(degraded).toBe('[deckent] run_shell: sandbox: degraded; exit 0 after 0.1s (ls)\nhi\n\nN');
    expect(summarizeAgentToolResult('run_shell', degraded)).toEqual({ kind: 'sandbox-degraded' });
    expect(summarizeAgentToolResult('run_shell', '[deckent] run_shell: sandbox: landlock; exit 0 after 0.1s (ls)\n')).toBeNull();
  });
});

const kernelAbi = (() => {
  try {
    const probe = join(import.meta.dirname, '../../../src/adapters/core/host-shell/native/build/Release/shell-capabilities');
    return process.platform === 'linux' ? Number(JSON.parse(execFileSync(probe, { encoding: 'utf8' })).landlockAbi) : 0;
  } catch { return 0; }
})();
const gitAvailable = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
/** A readable regular file of the real HOME (its content is never read by the test itself). */
const homeFile = (() => {
  try { return readdirSync(homedir()).map(name => join(homedir(), name)).find(path => { try { return statSync(path).isFile(); } catch { return false; } }) ?? null; }
  catch { return null; }
})();

async function realmOf(p: Awaited<ReturnType<typeof project>>) {
  const resolution = resolveShellRealm('prefer-sandbox', caps(kernelAbi), [landlockShellSandbox({ project: p.scope, scratchDir: p.scratch })]);
  if (!resolution.ok || resolution.realm.kind !== 'landlock') throw new Error('landlock realm expected');
  return resolution.realm;
}

describe.skipIf(kernelAbi < 1)('Landlock realm, real kernel and real bash (S11 acceptance)', () => {
  async function realm() {
    const p = await project();
    const landlock = await realmOf(p);
    const run = (command: string, timeoutMs = 20_000) => landlock.run({ command, cwd: p.root, environment: { PATH: '/usr/bin:/bin' }, timeoutMs,
      fixedEnv: { TMPDIR: p.scratch } });
    return { ...p, run };
  }
  it('secrets outside the project, in HOME and protected project paths are unreadable; hard links and links out are no way around', async () => {
    const r = await realm();
    for (const path of [`${r.outside}/secret`, '.env', 'pkg/api/.env', 'src/alias.txt', 'docs/out/secret', '.deckent/host/channel.md', ...(homeFile ? [homeFile] : [])]) {
      const ran = await r.run(`cat '${path}' > /dev/null && echo READ`);
      expect(ran.output, path).not.toContain('READ');
      expect(ran.output, path).toMatch(/Permission denied|No such file/);
    }
  });
  it('system paths and .git are not writable, .git stays readable, git works read-only', async () => {
    const r = await realm();
    expect((await r.run('echo x > /etc/deckent-landlock-probe')).exitCode).not.toBe(0);
    expect((await r.run('echo x >> .git/config')).exitCode).not.toBe(0);
    expect((await r.run('touch .git/hooks/pre-commit')).exitCode).not.toBe(0);
    expect(await readFile(join(r.root, '.git', 'config'), 'utf8')).toBe('[core]\n');
    expect((await r.run('cat .git/config')).output).toBe('[core]\n');
  });
  it('project files and the scratch area are writable; HOME is the scratch area; creating at the carved root is refused (documented)', async () => {
    const r = await realm();
    const ran = await r.run(`echo more >> README.md && echo new > src/deep/b.ts && mkdir -p docs/x && echo n > docs/x/n && echo s > "$TMPDIR/s" && echo "$HOME"`);
    expect(ran).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(ran.output.trim()).toBe(r.scratch);
    expect(await readFile(join(r.root, 'README.md'), 'utf8')).toBe('readme\nmore\n');
    expect(await readFile(join(r.scratch, 's'), 'utf8')).toBe('s\n');
    expect((await r.run('touch new-at-root')).exitCode).not.toBe(0);
    expect(existsSync(join(r.root, 'new-at-root'))).toBe(false);
  });
  it.skipIf(kernelAbi < 4)('has no network: a TCP connection to a listening local port never arrives', async () => {
    const r = await realm();
    let accepted = 0;
    const server = createServer(socket => { accepted++; socket.destroy(); });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
    try {
      const port = (server.address() as { port: number }).port;
      const ran = await r.run(`exec 3<>/dev/tcp/127.0.0.1/${port} && echo connected`);
      expect(ran.output).not.toContain('connected');
      expect(accepted).toBe(0);
    } finally { server.close(); }
  });
  it('a sandbox that cannot be set up runs nothing and is reported as a start failure (never as the exit of the command itself)', async () => {
    const p = await project();
    // The kernel offers less than the posture the realm promised (e.g. a probe from before a kernel change): the helper refuses.
    const resolution = resolveShellRealm('prefer-sandbox', caps(kernelAbi + 1), [landlockShellSandbox({ project: p.scope, scratchDir: p.scratch })]);
    if (!resolution.ok) throw new Error('realm expected');
    const ran = await resolution.realm.run({ command: 'touch src/deep/ran', cwd: p.root, environment: { PATH: '/usr/bin:/bin' } });
    expect(ran).toMatchObject({ status: 'spawn-failed', exitCode: null, output: expect.stringMatching(/^\[deckent\] shell-sandbox: .*ABI.*; nothing was run\.$/u) });
    expect(existsSync(join(p.root, 'src', 'deep', 'ran'))).toBe(false);
    // A command that imitates the failure is still an ordinary exit.
    const forged = await (await realmOf(p)).run({ command: 'echo "shell-sandbox: setup failed" >&2; exit 125', cwd: p.root, environment: { PATH: '/usr/bin:/bin' } });
    expect(forged).toMatchObject({ status: 'exited', exitCode: 125 });
  });
  it.skipIf(!gitAvailable)('git works read-only in a repository and in a worktree; a forged .git file opens nothing outside', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dn-landlock-git-')); roots.push(base);
    const main = join(base, 'main'), tree = join(base, 'tree'), other = join(base, 'other'), scratch = join(base, 'scratch');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    await mkdir(scratch);
    for (const repo of [main, other]) { await mkdir(repo); git(repo, 'init', '-q'); await writeFile(join(repo, 'a.txt'), 'a\n'); git(repo, 'add', 'a.txt'); git(repo, 'commit', '-qm', 'a'); }
    git(main, 'worktree', 'add', '-q', tree);
    // A forged pointer in a subdirectory (a sandboxed command could write one): it must not open the other repository.
    await mkdir(join(tree, 'sub')); await writeFile(join(tree, 'sub', '.git'), `gitdir: ${join(other, '.git')}\n`);
    for (const root of [main, tree]) {
      const scope = await createWorkspaceScope(root);
      const resolution = resolveShellRealm('prefer-sandbox', caps(kernelAbi), [landlockShellSandbox({ project: scope, scratchDir: scratch })]);
      if (!resolution.ok) throw new Error('realm expected');
      const ran = await resolution.realm.run({ command: 'echo b >> a.txt && git status --short a.txt && git commit -qam x; echo "commit=$?"; cat ' + `${other}/.git/HEAD`,
        cwd: scope.root, environment: { PATH: '/usr/bin:/bin' } });
      expect(ran.output, root).toMatch(/^ M a\.txt\n(.|\n)*index\.lock.*Permission denied(.|\n)*commit=128\n(.|\n)*Permission denied/u);
      expect(ran.output, root).not.toContain('refs/heads');
    }
  });
  it('keeps the process-group contract: a timeout ends the sandboxed group, background children included', async () => {
    const r = await realm();
    const ran = await r.run('sleep 30 & echo $! > "$TMPDIR/child.pid"; wait', 700);
    expect(ran.status).toBe('timed-out');
    const pid = Number((await readFile(join(r.scratch, 'child.pid'), 'utf8')).trim());
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((() => { try { process.kill(pid, 0); return true; } catch { return false; } })()).toBe(false);
  });
});
