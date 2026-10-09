import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentShellHardFloor, agentWorkspaceDeny, buildLandlockRules, createWorkspaceScope, isWriteApprovalFloored, landlockShellSandbox,
  resolveShellRealm, type ShellSandboxLayout } from '#adapters/index.js';
import { bubblewrapShellSandbox, resolveBubblewrapView } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { resolveProductLayout } from '#platform/index.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

const measured = await measureTestShellHost();
const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const SECRET = 'W3-SYNTHETIC-CREDENTIAL';
const CREDENTIALS = ['.config/gh/hosts.yml', '.docker/config.json', '.kube/config', '.codex/auth.json', '.git-credentials',
  '.aws/credentials', '.aws/config', '.azure/accessTokens.json', '.azure/msal_token_cache.json', '.config/gcloud/application_default_credentials.json',
  '.config/doctl/config.yaml', '.oci/config', '.aliyun/config.json', '.config/aliyun/config.json', '.config/hcloud/cli.toml',
  '.config/ibmcloud/config.json', '.bluemix/config.json', '.terraform.d/credentials.tfrc.json', '.dbus/session-bus/fake'];
async function fixture(fullAccess = false) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-w3-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'), global = join(home, '.deckent'), scratch = join(root, 'scratch');
  for (const path of [join(project, '.deckent'), join(project, 'src'), global, scratch]) await mkdir(path, { recursive: true });
  for (const name of ['config.json', 'policy.json']) await writeFile(join(project, '.deckent', name), '{}\n');
  for (const name of ['secrets.key', 'secrets.sealed.json']) await writeFile(join(global, name), SECRET);
  for (const name of CREDENTIALS) { const path = join(home, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, SECRET); }
  const environment: Record<string, string> = { HOME: home, PATH: '/usr/bin:/bin', DECKENT_GLOBAL_HOME: global };
  const product = resolveProductLayout({ projectRoot: project });
  const layout: ShellSandboxLayout = { project: await createWorkspaceScope(project, agentWorkspaceDeny(project, product, fullAccess)), scratchDir: scratch,
    writeFloor: isWriteApprovalFloored, repositoryWritable: fullAccess, hardFloor: agentShellHardFloor(project, product, [environment]) };
  const run = async (provider: 'bubblewrap' | 'landlock', command: string, open = false) => {
    const sandbox = provider === 'bubblewrap' ? bubblewrapShellSandbox(layout) : landlockShellSandbox(layout);
    const resolved = resolveShellRealm('require-sandbox', measured, [sandbox]);
    if (!resolved.ok) throw new Error(`${provider}: ${resolved.code}`);
    return resolved.realm.run({ command, cwd: project, environment, fixedEnv: { TMPDIR: scratch }, timeoutMs: 10_000,
      // Approved call: deliberately request the ordinary floor writable, testing the independent hard floor.
      writeFloorReadOnly: false, ...(open ? { open: true } : {}) });
  };
  return { root, project, home, global, environment, layout, run };
}
async function socket(path: string) {
  await mkdir(dirname(path), { recursive: true });
  const server = createServer(peer => peer.end('UNSAFE-HOST-IPC')); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
}
const connect = (path: string) => `python3 -c 'import socket; s=socket.socket(socket.AF_UNIX); s.connect("${path}"); print(s.recv(100).decode())'`;

describe('W3: real sandbox negative paths (synthetic files and IPC only)', () => {
  for (const provider of ['bubblewrap', 'landlock'] as const) {
    const available = provider === 'bubblewrap' ? measured.bubblewrap.status === 'available' : measured.landlock.status === 'available';
    it.skipIf(!available)(`${provider}: approved closed calls cannot append, truncate, replace, chmod/open policy or create authority`, async () => {
      const f = await fixture();
      const mode = (await stat(join(f.project, '.deckent/policy.json'))).mode;
      for (const command of ['printf X >> .deckent/config.json', ': > .deckent/config.json', 'rm .deckent/config.json',
        'mv .deckent/config.json src/stolen',
        "python3 -c \"import os; os.setxattr('.deckent/policy.json', 'user.w3', b'x')\"", 'chmod 666 .deckent/policy.json; : >> .deckent/policy.json', 'printf X > .deckent/new-policy.json']) {
        const out = await f.run(provider, command);
        expect(out.status, out.output).toBe('exited');
        expect(out.exitCode, command).not.toBe(0);
      }
      for (const name of ['config.json', 'policy.json']) expect(await readFile(join(f.project, '.deckent', name), 'utf8')).toBe('{}\n');
      expect((await stat(join(f.project, '.deckent/policy.json'))).mode).toBe(mode);
      expect((await f.run(provider, 'echo allowed > src/allowed')).exitCode).toBe(0);
      expect(await readFile(join(f.project, 'src/allowed'), 'utf8')).toBe('allowed\n');
    });
    it.skipIf(!available)(`${provider}: closed calls cannot read global keys or connect to Docker/D-Bus pathname sockets`, async () => {
      const f = await fixture();
      const sock = join(f.project, 'docker.sock'); await socket(sock);
      for (const command of [`cat '${f.global}/secrets.key' '${f.global}/secrets.sealed.json'`, ...CREDENTIALS.map(name => `cat '${join(f.home, name)}'`), connect(sock)]) {
        const out = await f.run(provider, command);
        expect(out.status, out.output).toBe('exited');
        expect(out.exitCode).not.toBe(0);
        expect(out.output).not.toContain(SECRET); expect(out.output).not.toContain('UNSAFE-HOST-IPC');
      }
    });
  }
  it.skipIf(measured.bubblewrap.status !== 'available')('bubblewrap: full access keeps authority closed, masks every credential family, and refuses Docker and session D-Bus connections', async () => {
    const f = await fixture(true);
    const docker = join(f.project, 'docker.sock'), bus = join(f.root, 'runtime/bus');
    f.environment['XDG_RUNTIME_DIR'] = dirname(bus);
    f.environment['DBUS_SESSION_BUS_ADDRESS'] = `unix:path=${bus}`;
    await socket(docker); await socket(bus);
    for (const command of ['printf X >> .deckent/config.json', ': > .deckent/policy.json',
      ...CREDENTIALS.map(name => `cat '${join(f.home, name)}'`), `cat '${f.global}/secrets.key' '${f.global}/secrets.sealed.json'`, connect(docker), connect(bus)]) {
      const out = await f.run('bubblewrap', command, true);
      expect(out.status, out.output).toBe('exited'); expect(out.exitCode, command).not.toBe(0);
      expect(out.output).not.toContain(SECRET); expect(out.output).not.toContain('UNSAFE-HOST-IPC');
    }
    expect((await f.run('bubblewrap', `echo allowed > '${f.home}/notes.txt'; echo allowed > src/allowed`, true)).exitCode).toBe(0);
    expect(await readFile(join(f.project, '.deckent/config.json'), 'utf8')).toBe('{}\n');
    expect(await readFile(join(f.home, 'notes.txt'), 'utf8')).toBe('allowed\n');
  }, 60_000);
  it('a symlinked credential carrier refuses the open view instead of exposing its target', async () => {
    const f = await fixture(true); await writeFile(join(f.home, 'token.txt'), SECRET);
    await rm(join(f.home, '.codex/auth.json')); await symlink(join(f.home, 'token.txt'), join(f.home, '.codex/auth.json'));
    expect(await resolveBubblewrapView(f.layout, f.environment, {}, { open: true })).toMatchObject({ ok: false, reason: expect.stringContaining('credential path is a symbolic link') });
  });
  it('abstract session D-Bus cannot be file-masked: full access refuses this view', async () => {
    const f = await fixture(true);
    expect(await resolveBubblewrapView(f.layout, { ...f.environment, DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=w3-synthetic-bus' }, {}, { open: true }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('abstract session D-Bus') });
  });

  it('Landlock refuses system grants that would reopen an absolute installation root', async () => {
    const f = await fixture();
    for (const root of ['/etc/deckent-w3-synthetic', '/usr']) {
      expect(await buildLandlockRules({ ...f.layout, hardFloor: { ...f.layout.hardFloor!, roots: [root] } }))
        .toEqual({ ok: false, reason: 'a system read grant overlaps the installation hard floor' });
    }
  });

  it.skipIf(measured.landlock.status !== 'available')('Landlock blocks modern metadata syscalls even when the build headers omit them', async () => {
    const f = await fixture();
    const command = `python3 -c "import ctypes; c=ctypes.CDLL(None,use_errno=True); v=ctypes.create_string_buffer(b'x'); a=(ctypes.c_uint64*2)(ctypes.addressof(v),1); `
      + `calls=[(452,-100,b'.deckent/policy.json',438,0),(463,-100,b'.deckent/policy.json',0,b'user.w3',ctypes.byref(a),16),(466,-100,b'.deckent/policy.json',0,b'user.w3')]; `
      + `results=[(c.syscall(*args),ctypes.get_errno()) for args in calls]; assert results==[(-1,1)]*3,results; print('metadata blocked')"`;
    const out = await f.run('landlock', command);
    expect(out.status, out.output).toBe('exited'); expect(out.exitCode, out.output).toBe(0);
    expect(out.output).toContain('metadata blocked');
    expect((await stat(join(f.project, '.deckent/policy.json'))).mode & 0o777).toBe(0o644);
  });

});

// Fix round 2026-10-09 (lead, fail closed; owner Y 2026-09-30): a layout without the turn's hard floor floors `.deckent` whole and the data root
// (an absolute in-project data root normalized), with only `.deckent/docs` (and the `.deckent` entry needed to create it) left open.
it('without a turn hard floor: authority, unknown .deckent files and the data root are floored; only .deckent/docs stays open', async () => {
  const { sandboxHardFloored } = await import('#adapters/core/host-shell/index.js');
  const root = '/tmp/hf-project';
  const layoutWith = (dataRoot?: string) => ({ project: { root, ignoredDirs: new Set<string>(), protectedAnchors: new Set<string>(), denied: () => false },
    scratchDir: null, writeFloor: null, ...(dataRoot === undefined ? {} : { dataRoot }) }) as ShellSandboxLayout;
  for (const layout of [layoutWith(), layoutWith('.deckent/live-data'), layoutWith(`${root}/.deckent/live-data`)]) {
    for (const rel of ['.deckent/config.json', '.deckent/policy.json', '.deckent/bindings.json', '.deckent/approvals/-', '.deckent/state/ledger.db',
      '.deckent/project-identity/-', '.deckent/x', '.deckent/notes.md', '.deckent/unknown-dir/-', '.deckent/live-data/policy.json']) expect(sandboxHardFloored(layout, rel), rel).toBe(true);
    for (const rel of ['.deckent/-', '.deckent/docs', '.deckent/docs/-', '.deckent/docs/x.md', '.deckent/docs/a/b/-', 'src/a.ts']) expect(sandboxHardFloored(layout, rel), rel).toBe(false);
  }
  // An absolute data root inside the project is normalized and floored wherever it lives; one outside the project adds nothing here.
  for (const dataRoot of [`${root}/var/state`, 'var/state']) {
    expect(sandboxHardFloored(layoutWith(dataRoot), 'var/state/ledger.db'), dataRoot).toBe(true);
    expect(sandboxHardFloored(layoutWith(dataRoot), 'var/state/-'), dataRoot).toBe(true);
    expect(sandboxHardFloored(layoutWith(dataRoot), 'var/other.txt'), dataRoot).toBe(false);
  }
  expect(sandboxHardFloored(layoutWith(`${root}/.deckent/docs/data`), '.deckent/docs/data/policy.json')).toBe(true);
  expect(sandboxHardFloored(layoutWith('/elsewhere/data'), 'src/a.ts')).toBe(false);
});

// Astra 2486 P1: the owner-Y `.deckent/docs` subtree is a writable HOST bind only over the plain writable host project. Over an overlay (a
// write set) it stays inside the overlay and the in-project sealed root is not bound over it; a read-only project (the write set's
// allocation-failure posture) keeps docs read-only, even for an approved call with the ordinary floor writable.
describe.skipIf(measured.bubblewrap.status !== 'available')('Astra 2486 P1: no writable host docs bind over an overlay or a read-only project', () => {
  async function withDocs() {
    const f = await fixture();
    await mkdir(join(f.project, '.deckent', 'docs'), { recursive: true }); await writeFile(join(f.project, '.deckent', 'docs', 'report.md'), 'original\n');
    const upper = await mkdtemp(join(tmpdir(), 'deckent-w3-upper-')), work = await mkdtemp(join(tmpdir(), 'deckent-w3-work-')); roots.push(upper, work);
    // The live shape: the data root below `.deckent` (with the data root `.deckent` itself every entry is product state, so no docs bind exists).
    const live = resolveProductLayout({ projectRoot: f.project, root: join(f.project, '.deckent', 'live-data') });
    await mkdir(live.root, { recursive: true });
    const layout: ShellSandboxLayout = { ...f.layout, project: await createWorkspaceScope(f.project, agentWorkspaceDeny(f.project, live, false)), dataRoot: '.deckent/live-data',
      hardFloor: agentShellHardFloor(f.project, live, [f.environment]) };
    return { ...f, layout, upper, work, docs: join(f.project, '.deckent', 'docs') };
  }
  it('the plain writable view binds docs writable; the overlay and read-only views never do, and the overlay keeps .deckent inside it', async () => {
    const f = await withDocs();
    const plain = await resolveBubblewrapView(f.layout, f.environment, {}, { floorReadOnly: false });
    expect(plain.ok && plain.view.writablePaths).toEqual([f.docs]);
    const overlay = await resolveBubblewrapView(f.layout, f.environment, {}, { floorReadOnly: false, writeSet: { upper: f.upper, work: f.work } });
    expect(overlay.ok, overlay.ok ? '' : overlay.reason).toBe(true);
    if (overlay.ok) { expect(overlay.view.writablePaths).toBeUndefined(); expect(overlay.view.sealedPaths ?? []).not.toContain(join(f.project, '.deckent')); }
    const readOnly = await resolveBubblewrapView(f.layout, f.environment, {}, { floorReadOnly: false, projectReadOnly: true });
    expect(readOnly.ok && readOnly.view.writablePaths).toBeUndefined();
  });
  it('write set unavailable (read-only project, approved floor): a docs write is refused, the file is unchanged', async () => {
    const f = await withDocs();
    const usable = bubblewrapShellSandbox(f.layout).usable(measured);
    if (!usable.ok) throw new Error(usable.reason);
    const out = await usable.realm.run({ command: 'd=.deckent/docs; echo changed > "$d/report.md"; echo "rc=$?"', cwd: f.project, environment: f.environment,
      fixedEnv: { TMPDIR: join(f.root, 'scratch') }, timeoutMs: 10_000, writeFloorReadOnly: false, projectReadOnly: true });
    expect(out.output).not.toContain('rc=0');
    expect(await readFile(join(f.docs, 'report.md'), 'utf8')).toBe('original\n');
  });
});
