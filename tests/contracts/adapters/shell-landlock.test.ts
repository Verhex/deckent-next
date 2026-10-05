import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLandlockRules, describeHostShellResult, hostShellRealm, landlockShellSandbox, resolveShellRealm, type ShellCapabilities } from '#adapters/core/host-shell/index.js';
import { createWorkspaceScope } from '#adapters/index.js';
import { summarizeAgentToolResult } from '#surfaces/core/terminal-kit/index.js';

const roots: string[] = [], locked: string[] = [];
afterEach(async () => {
  for (const dir of locked.splice(0)) await chmod(dir, 0o700).catch(() => undefined);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
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

describe.skipIf(process.platform === 'win32')('requires POSIX sandbox rule paths: Landlock rule set (S11): carve around protected paths, .git read-only', () => {
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
    // Astra 2154 R3 (Landlock side): beyond the depth bound the whole set is refused; an unreadable directory takes no rule (unreachable).
    await mkdir(join(p.root, Array.from({ length: 34 }, () => 'd').join('/')), { recursive: true });
    expect(await buildLandlockRules({ project: p.scope, scratchDir: p.scratch })).toMatchObject({ ok: false, reason: expect.stringContaining('deeper') });
    await rm(join(p.root, 'd'), { recursive: true, force: true });
    await mkdir(join(p.root, 'locked')); await writeFile(join(p.root, 'locked', '.env'), 'LOCKED_SECRET\n'); await chmod(join(p.root, 'locked'), 0o000); locked.push(join(p.root, 'locked'));
    const carved = await buildLandlockRules({ project: p.scope, scratchDir: p.scratch });
    expect(carved.ok && carved.rules.some(([, path]) => path === 'locked' || path.startsWith('locked/'))).toBe(false);
  });
});

describe('shell realm selection with Landlock (S11)', () => {
  const sandbox = [landlockShellSandbox({ project: { root: '/nonexistent', denied: () => false, ignoredDirs: new Set<string>() }, scratchDir: null })];
  // An owner-approved standart call (project and its write floor writable, `.git` read-only) — the default most assertions here care about.
  const OWNER_APPROVED_STANDART = { projectReadOnly: false, writeFloorReadOnly: false, repositoryWritable: false };
  it('chooses Landlock for prefer-sandbox and require-sandbox, never for host', () => {
    for (const mode of ['prefer-sandbox', 'require-sandbox'] as const) {
      const picked = resolveShellRealm(mode, caps(7), sandbox);
      expect(picked).toMatchObject({ ok: true, realm: { kind: 'landlock' }, marker: 'sandbox: landlock', notice: null });
      expect(picked.ok && picked.posture(OWNER_APPROVED_STANDART)).toContain('Landlock');
    }
    const host = resolveShellRealm('host', caps(7), sandbox);
    expect(host).toMatchObject({ ok: true, realm: hostShellRealm, notice: null, marker: null });
    expect(host.ok && host.posture(OWNER_APPROVED_STANDART)).toContain('not a sandbox');
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
    expect(resolveShellRealm('require-sandbox', caps(null), sandbox)).toEqual({ ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE',
      rejected: [{ kind: 'landlock', reason: 'landlock unavailable' }] });
    // No provider (a caller that cannot describe the project) never gets a Landlock realm.
    expect(resolveShellRealm('require-sandbox', caps(7))).toEqual({ ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE', rejected: [] });
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
  it('an unreadable directory stays unreachable even after the command changes its mode (Astra 2154 R3)', async () => {
    const p = await project();
    await mkdir(join(p.root, 'locked')); await writeFile(join(p.root, 'locked', '.env'), 'LOCKED_SECRET\n'); await chmod(join(p.root, 'locked'), 0o000); locked.push(join(p.root, 'locked'));
    const landlock = await realmOf(p);
    const ran = await landlock.run({ command: 'chmod 700 locked; cat locked/.env; echo "cat=$?"', cwd: p.root, environment: { PATH: '/usr/bin:/bin' }, timeoutMs: 20_000 });
    expect(ran.output).not.toContain('LOCKED_SECRET'); expect(ran.output).toMatch(/Permission denied/u); expect(ran.output.split('\n')).toContain('cat=1');
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
      // stdout (`git status`, `commit=`) and stderr (git's and cat's refusals) are checked apart, never for their interleaving.
      const lines = ran.output.split('\n');
      expect(lines, root).toContain(' M a.txt'); expect(lines, root).toContain('commit=128');
      expect(lines.some(line => line.includes('index.lock') && line.includes('Permission denied')), root).toBe(true);
      expect(lines.some(line => line.endsWith('/.git/HEAD: Permission denied')), root).toBe(true);
      expect(ran.output, root).not.toContain('refs/heads');
    }
  });
  it.skipIf(!gitAvailable)('closes another name of a protected inode wherever git metadata would grant it; a hard-linked clone stays usable (Astra 2156)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dn-landlock-alias-')); roots.push(base);
    const main = join(base, 'main'), tree = join(base, 'tree'), clone = join(base, 'clone'), scratch = join(base, 'scratch');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    await mkdir(scratch); await mkdir(main); git(main, 'init', '-q'); await writeFile(join(main, 'a.txt'), 'a\n'); git(main, 'add', 'a.txt'); git(main, 'commit', '-qm', 'a');
    git(main, 'worktree', 'add', '-q', tree); git(base, 'clone', '-q', main, clone);
    // (a) root `.git` file alias, (b)/(c) nested `.git` file alias, (d) alias inside `.git`, (e) alias inside the worktree's common repository.
    const forged = join(base, 'forged'); await mkdir(forged); await writeFile(join(forged, '.env'), 'ALIAS_SECRET\n'); await link(join(forged, '.env'), join(forged, '.git'));
    await writeFile(join(tree, '.env'), 'ALIAS_SECRET\n'); await mkdir(join(tree, 'sub')); await link(join(tree, '.env'), join(tree, 'sub', '.git'));
    await link(join(tree, '.env'), join(main, '.git', 'sentinel-alias')); await link(join(tree, '.env'), join(main, '.git', 'worktrees', 'tree', 'sentinel-alias'));
    await writeFile(join(clone, '.env'), 'ALIAS_SECRET\n'); await mkdir(join(clone, '.git', 'objects', 'aa'), { recursive: true }); await link(join(clone, '.env'), join(clone, '.git', 'objects', 'aa', 'a'.repeat(38)));
    const forgedRules = await buildLandlockRules({ project: await createWorkspaceScope(forged), scratchDir: scratch });
    expect(forgedRules.ok && forgedRules.rules.some(([, path]) => path === '.git')).toBe(false);
    for (const [root, aliases] of [[tree, ['sub/.git', join(main, '.git', 'sentinel-alias'), join(main, '.git', 'worktrees', 'tree', 'sentinel-alias')]], [clone, [`.git/objects/aa/${'a'.repeat(38)}`]]] as const) {
      const scope = await createWorkspaceScope(root);
      const resolution = resolveShellRealm('prefer-sandbox', caps(kernelAbi), [landlockShellSandbox({ project: scope, scratchDir: scratch })]);
      if (!resolution.ok) throw new Error('realm expected');
      // One pipe preserves shell write order, including redirection failures, before the exact suffix assertion.
      const ran = await resolution.realm.run({ command: `exec 2>&1; for p in ${aliases.map(alias => `'${alias}'`).join(' ')}; do cat "$p" 2>&1; echo x >> "$p" 2>&1; echo "w=$?"; done; git status --short; echo "status=$?"; git log --oneline -1 | wc -l`,
        cwd: scope.root, environment: { PATH: '/usr/bin:/bin' }, fixedEnv: { TMPDIR: scratch }, timeoutMs: 60_000 });
      expect(ran.output, root).not.toContain('ALIAS_SECRET');
      expect(ran.output.match(/Permission denied/gu)?.length, root).toBe(aliases.length * 2); expect(ran.output.match(/w=1/gu)?.length, root).toBe(aliases.length);
      expect(ran.output, root).toMatch(/status=0\n1\n$/u);
    }
    expect(execFileSync('find', [join(clone, '.git', 'objects'), '-type', 'f', '-links', '+1'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length).toBeGreaterThan(1);
  });
  it('re-checks git metadata every call: a file that became another name of a secret after a warm call takes no rule (Astra 2158)', async () => {
    const p = await project();
    const data = Buffer.from('blob 6\0hello\n'), hash = createHash('sha1').update(data).digest('hex');
    const object = join('.git', 'objects', hash.slice(0, 2), hash.slice(2));
    await mkdir(join(p.root, '.git', 'objects', hash.slice(0, 2)), { recursive: true });
    await writeFile(join(p.root, object), deflateSync(data)); await writeFile(join(p.root, '.git', 'cached-file'), 'PUBLIC_BEFORE\n');
    const landlock = await realmOf(p);
    const run = (command: string) => landlock.run({ command, cwd: p.root, environment: { PATH: '/usr/bin:/bin' }, timeoutMs: 20_000, fixedEnv: { TMPDIR: p.scratch } });
    expect((await run(`cat .git/cached-file; cat ${object} | wc -c`)).output).toMatch(/^PUBLIC_BEFORE\n\d+\n$/u);
    await rm(join(p.root, '.env')); await link(join(p.root, '.git', 'cached-file'), join(p.root, '.env')); await writeFile(join(p.root, '.env'), 'SECRET-LATER-PLAIN\n');
    await link(join(p.root, object), join(p.root, 'pkg', '.env')); await writeFile(join(p.root, 'pkg', '.env'), 'SECRET-LATER-OBJECT\n');
    const rules = await buildLandlockRules({ project: p.scope, scratchDir: p.scratch });
    // Neither file takes a read rule any more, and no directory above them is one read grant (they are carved: listing only).
    expect(rules.ok && rules.rules.some(([cls, path]) => cls === 'r' && (path === '.git/cached-file' || path === object || path === '.git' || path === dirname(object)))).toBe(false);
    const warm = await run(`cat .git/cached-file 2>&1; cat ${object} 2>&1`);
    expect(warm.output).not.toContain('SECRET'); expect(warm.output).toMatch(/cached-file: Permission denied\n.*Permission denied\n$/u);
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
