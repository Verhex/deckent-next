import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerSupervisor, landlockShellSandbox, type ShellSandboxFactory } from '#adapters/index.js';
import type { SandboxRequest } from '#engine/index.js';
import { openNativeConnection, openNativeEgressGateway } from '../../../dist/adapters/core/native-connection/index.js';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';
import { measureTestShellHost, linuxShellHost } from '../../fixtures/shell-host.js';

// OPEN-SANDBOX (owner MODES-3 checkpoint §4, 2026-09-29; live findings 3 and 4 of terminal session 1d428e9f): a full-access shell call in a
// bubblewrap realm runs in the open view — host network, the real HOME visible and writable, the project and `.git` writable — while the
// hard floor is structural: the project's product root is read-only (no name, existing or new, can be created in it), the global state root
// (the bundled bubblewrap copy, the user MCP registry and trust, secrets) is hidden and read-only, and credential-pattern files in HOME are
// masked. Standart and full-auto keep the closed view (no network, empty HOME). Real runtime service, real policy files, real bubblewrap.
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  await closeModeRuntimes();
});
const measured = await measureTestShellHost();
const bwrapReady = measured.bubblewrap.status === 'available';
const landlockAbi = measured.landlock.status === 'available' ? measured.landlock.abi ?? 0 : 0;
const landlockOnly: ShellSandboxFactory = layout => [{ kind: 'landlock', usable: () => landlockShellSandbox(layout).usable(linuxShellHost({ landlock: { status: 'available', abi: landlockAbi } })) }];
const FULL_ACCESS = rule('full-access', 'permission-mode', ['full-access'], 'allow', false, ['set']);
const GRANTS = [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'allow'), FULL_ACCESS];
const DATA = '.deckent/data';
const fa = { fullAccess: true } as const;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' });
const exists = (path: string) => access(path).then(() => true, () => false);
const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
/** A loopback HTTP server outside the sandbox (no external network needed). */
async function loopback(): Promise<number> {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('open-sandbox-pong'); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('LOOPBACK_ADDRESS');
  return address.port;
}
const fetchCommand = (port: number) => `exec 3<>/dev/tcp/127.0.0.1/${port} && printf 'GET / HTTP/1.0\\r\\n\\r\\n' >&3 && cat <&3`;

/** The runtime with a temporary HOME holding an ordinary file and credential-pattern files (the real HOME is never bound by these tests). */
async function openRuntime(shell: Record<string, unknown>, sandboxes?: ShellSandboxFactory) {
  const f = await modeRuntime({ grants: GRANTS, mode: 'full-auto', dataRoot: DATA, shell, ...(sandboxes ? { sandboxes } : {}) });
  const home = join(dirname(f.project), 'home');
  vi.stubEnv('HOME', home);
  await mkdir(join(home, '.config/tool'), { recursive: true });
  await writeFile(join(home, 'notes.txt'), 'home-notes\n');
  await writeFile(join(home, '.config/tool/id.pem'), 'PEM-SECRET\n');
  await writeFile(join(home, '.npmrc'), '//registry.example/:_authToken=NPM-SECRET\n');
  await writeFile(join(f.project, '.gitignore'), '.deckent/\n');
  git(f.project, 'init', '-q'); git(f.project, 'add', '-A'); git(f.project, 'commit', '-qm', 'base');
  return { ...f, home };
}

it.skipIf(!bwrapReady)('RC-S1: an approved open shell cannot see/connect to long-path gateways before or after spawn', async () => {
  const f = await openRuntime({ schemaVersion: 1, realm: 'require-sandbox' });
  await f.writeAuthority([rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', false),
    rule('shell-run', 'operation', ['host.shell.run'], 'allow'), FULL_ACCESS], 'full-auto', 'ipc-card');
  const directory = join(f.data, 'state/workspaces', 'a'.repeat(80)); await mkdir(directory, { recursive: true, mode: 0o700 });
  const connections: Awaited<ReturnType<typeof openNativeConnection>>[] = [];
  const open = async () => { const value = await openNativeConnection({ directory, binding: { schemaVersion: 1, provider: 'codex' },
    credential: { tokens: { access_token: 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.synthetic', id_token: 'fixture' } }, deadlineMs: 30_000 }); connections.push(value); return value; };
  const before = await open();
  const probe = `import json,os,socket
for row in json.load(open('src/ipc-paths.json')):
 assert not os.path.exists(row['socketPath'])
 if 'capabilityPath' in row: assert not os.path.exists(row['capabilityPath'])
 sock=socket.socket(socket.AF_UNIX); sock.settimeout(1)
 try: sock.connect(row['socketPath'])
 except OSError: pass
 else: raise AssertionError('credential socket reachable')
 finally: sock.close()
print('IPC_ISOLATED')`;
  const command = `touch src/ipc-ready; while ! test -f src/ipc-go; do sleep 0.02; done; python3 -c '${probe.replaceAll("'", "'\"'\"'")}'`;
  let egress: Awaited<ReturnType<typeof openNativeEgressGateway>> | undefined;
  const pending = f.call('run_shell', { command }, 'allow', fa);
  try {
    const until = Date.now() + 10_000;
    while (!await exists(join(f.project, 'src/ipc-ready'))) { if (Date.now() > until) throw new Error('sandbox did not start'); await new Promise(resolve => setTimeout(resolve, 20)); }
    const after = await open(); egress = await openNativeEgressGateway({ provider: 'codex', directory });
    for (const connection of connections) expect(Buffer.byteLength(connection.descriptor.socketPath)).toBeLessThanOrEqual(103);
    await writeFile(join(f.project, 'src/ipc-paths.json'), JSON.stringify([before.descriptor, after.descriptor, { socketPath: egress.socketPath }]));
    await writeFile(join(f.project, 'src/ipc-go'), 'go');
    const result = await pending;
    expect(result, f.evidence(result)).toMatchObject({ card: true, status: 'ok' }); expect(result.text).toContain('IPC_ISOLATED');
    for (const connection of connections) expect(connection.statistics().bootstrapReads).toBe(0);
  } finally {
    await writeFile(join(f.project, 'src/ipc-go'), 'stop'); await pending.catch(() => undefined);
    await egress?.close(); await Promise.all(connections.map(connection => connection.close()));
  }
}, 120_000);

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
it.skipIf(!bwrapReady || !imageId)('RC-S1: project A cannot list/read/bootstrap project B short-path gateways before/after spawn; B worker bootstraps', async () => {
  const f = await openRuntime({ schemaVersion: 1, realm: 'require-sandbox' });
  await f.writeAuthority([rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', false),
    rule('shell-run', 'operation', ['host.shell.run'], 'allow'), FULL_ACCESS], 'full-auto', 'short-ipc-card');
  const projectB = await mkdtemp('/tmp/db-'), directory = join(projectB, '.deckent/workspaces'), workspace = join(projectB, 'work');
  const connections: Awaited<ReturnType<typeof openNativeConnection>>[] = [];
  let pending: ReturnType<typeof f.call> | undefined, supervisor: DockerSupervisor | undefined, request: SandboxRequest | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 }); await mkdir(workspace);
    // Both projects' state roots are outside HOME; B exercises the former short-path branch, independently of A's protected roots.
    expect(f.data.startsWith('/tmp/')).toBe(true); expect(f.data.startsWith(f.home + '/')).toBe(false);
    expect(Buffer.byteLength(join(f.data, 'workspaces/connection-XXXXXX/gateway.sock'))).toBeLessThanOrEqual(103);
    expect(directory.startsWith(f.home + '/')).toBe(false); expect(directory.startsWith(f.project + '/')).toBe(false);
    expect(Buffer.byteLength(join(directory, 'connection-XXXXXX/gateway.sock'))).toBeLessThanOrEqual(103);
    const open = async () => { const value = await openNativeConnection({ directory, binding: { schemaVersion: 1, provider: 'codex' },
      credential: { tokens: { access_token: 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.synthetic', id_token: 'fixture' } }, deadlineMs: 60_000 }); connections.push(value); return value; };
    const before = await open();
    const probe = `import json,os,socket
rows=json.load(open('src/short-ipc-paths.json')); results=[]
for row in rows:
 listed=readable=connected=False; capability='unauthorized'
 try: listed=bool(os.listdir(os.path.dirname(row['socketPath'])))
 except OSError: pass
 try:
  with open(row['capabilityPath']) as source: capability=source.read(); readable=True
 except OSError: pass
 sock=socket.socket(socket.AF_UNIX); sock.settimeout(1)
 try:
  sock.connect(row['socketPath']); connected=True
  sock.sendall(('GET /bootstrap HTTP/1.0\\r\\nAuthorization: '+capability+'\\r\\n\\r\\n').encode()); sock.recv(65536)
 except OSError: pass
 finally: sock.close()
 results.append([listed,readable,connected])
assert results==[[False,False,False]]*len(rows), results
assert os.listdir(os.path.dirname(os.path.dirname(rows[0]['socketPath'])))==[]
print('SHORT_CROSS_PROJECT_IPC_ISOLATED')`;
    const command = `touch src/short-ipc-ready; while ! test -f src/short-ipc-go; do sleep 0.02; done; python3 -c '${probe.replaceAll("'", "'\"'\"'")}'`;
    pending = f.call('run_shell', { command }, 'allow', fa);
    const until = Date.now() + 10_000;
    while (!await exists(join(f.project, 'src/short-ipc-ready'))) { if (Date.now() > until) throw new Error('sandbox did not start'); await new Promise(resolve => setTimeout(resolve, 20)); }
    const after = await open();
    await writeFile(join(f.project, 'src/short-ipc-paths.json'), JSON.stringify([before.descriptor, after.descriptor]));
    await writeFile(join(f.project, 'src/short-ipc-go'), 'go');
    const result = await pending;
    for (const connection of connections) expect(connection.statistics().bootstrapReads).toBe(0);
    expect(result, f.evidence(result)).toMatchObject({ card: true, status: 'ok' }); expect(result.text).toContain('SHORT_CROSS_PROJECT_IPC_ISOLATED');
    expect(await readdir(directory)).toEqual([]);
    // The authorized worker still receives the socket and capability through its private Docker mounts, after A's attacks.
    supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: projectB, imageId: imageId!,
      uid: process.getuid!(), gid: process.getgid!(), logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 536870912, pids: 128, cpus: 1,
      tmpBytes: 67108864, deadlineMs: 20_000, controlTimeoutMs: 10_000, outputBytes: 65536, connection: after.descriptor });
    request = { protocolVersion: 1, identity: { runId: 'run', taskId: 'task', attemptId: randomUUID(), scopeId: 'test', generation: 1, layoutRevision: 'layout' },
      workspace, argv: ['node', '-e', "const fs=require('node:fs');const auth=JSON.parse(fs.readFileSync(process.env.HOME+'/.codex/auth.json'));if(!auth.tokens.access_token.endsWith('.synthetic'))process.exit(12);fs.writeFileSync('bootstrapped','yes')"] };
    expect((await supervisor.execute(request)).result).toEqual({ kind: 'exited', exitCode: 0 });
    expect(await readFile(join(workspace, 'bootstrapped'), 'utf8')).toBe('yes'); expect(after.statistics().bootstrapReads).toBe(1);
    expect(before.statistics().bootstrapReads).toBe(0);
  } finally {
    await writeFile(join(f.project, 'src/short-ipc-go'), 'stop'); await pending?.catch(() => undefined);
    if (supervisor && request) { await supervisor.cancel(request); await supervisor.release(request); }
    await Promise.all(connections.map(connection => connection.close())); await rm(projectB, { recursive: true, force: true });
  }
}, 120_000);


describe.skipIf(process.platform !== 'linux')('OPEN-SANDBOX: the full-access view of a bubblewrap realm', () => {
  it.skipIf(!bwrapReady)('full access reaches the network and HOME, writes the project and .git; the hard floor is structural', async () => {
    const f = await openRuntime({ schemaVersion: 1, realm: 'require-sandbox' });
    const port = await loopback();
    const globalRoot = process.env['DECKENT_GLOBAL_HOME']!;
    const launcherName = (await readdir(join(globalRoot, 'bin'))).find(name => name.startsWith('bwrap-'));
    const launcher = launcherName ? join(globalRoot, 'bin', launcherName) : null;
    const launcherHash = launcher ? await sha(launcher) : null;
    await writeFile(join(globalRoot, 'secrets.json'), '{"token":"GLOBAL-SECRET"}\n', { mode: 0o600 });

    // Network: the host network namespace (a loopback server started outside the sandbox answers).
    const net = await f.call('run_shell', { command: fetchCommand(port) }, 'deny', fa);
    expect({ card: net.card, status: net.status }).toEqual({ card: false, status: 'ok' });
    expect(net.text).toMatch(/^\[deckent\] run_shell: sandbox: bubblewrap; exit 0/u);
    expect(net.text).toContain('open-sandbox-pong');
    // HOME: visible and writable (a new name lands on the host).
    const home = await f.call('run_shell', { command: 'cat "$HOME/notes.txt" && echo written > "$HOME/new-home-file.txt"' }, 'deny', fa);
    expect({ status: home.status, read: home.text.includes('home-notes') }).toEqual({ status: 'ok', read: true });
    expect(await readFile(join(f.home, 'new-home-file.txt'), 'utf8')).toBe('written\n');
    // Project and .git: a write and a commit land.
    const commit = await f.call('run_shell', { command: 'echo b > src/b.ts && git add src/b.ts && git -c user.name=agent -c user.email=agent@example.invalid commit -qm open-commit' }, 'deny', fa);
    expect(commit.status).toBe('ok');
    expect(git(f.project, 'log', '--format=%s', '-1').trim()).toBe('open-commit');

    // Hard floor, project product root: no NEW name can be created under `.deckent/` (finding 3: `.deckent/mcp.json`), whatever the spelling.
    for (const command of ['echo {} > "$(printf .deck)ent/mcp.json"', 'mkdir "$(printf .deck)ent/newdir"', 'touch "$(printf .deck)ent/data/policy2.json"',
      'echo {} > "$(printf .deck)ent/data/state-new"']) {
      const refused = await f.call('run_shell', { command }, 'deny', fa);
      expect({ command, card: refused.card, failed: /exit [1-9]/u.test(refused.text), erofs: /Read-only file system|Permission denied/u.test(refused.text) })
        .toEqual({ command, card: false, failed: true, erofs: true });
    }
    for (const path of ['.deckent/mcp.json', '.deckent/newdir', '.deckent/data/policy2.json', '.deckent/data/state-new']) expect({ path, exists: await exists(join(f.project, path)) }).toEqual({ path, exists: false });
    // Existing product state stays unreadable (policy) and the configuration read-only.
    const peek = await f.call('run_shell', { command: 'cat "$(printf .deck)ent/data/policy.json"' }, 'deny', fa);
    expect(peek.text).not.toContain('schemaVersion');

    // Hard floor, global state root: its files are hidden and nothing can be written there (user MCP registry, secrets, the bwrap copy).
    const global = await f.call('run_shell', { command: `cat "${globalRoot}/secrets.json"; ls -A "${globalRoot}"; echo {} > "${globalRoot}/mcp.json"` }, 'deny', fa);
    expect(global.text).not.toContain('GLOBAL-SECRET');
    expect(global.text).not.toContain('bwrap-');
    expect(await exists(join(globalRoot, 'mcp.json'))).toBe(false);
    // The service's bubblewrap is the verified copy under this global root when no system launcher ≥ 0.12 is selected (this machine: 0.9.0).
    if (measured.bubblewrap.launcher?.source !== 'system') {
      expect(launcher).not.toBeNull();
      const replace = await f.call('run_shell', { command: `cp /bin/true "${launcher}"; chmod u+w "${launcher}"; : > "${launcher}"` }, 'deny', fa);
      expect(/exit [1-9]/u.test(replace.text)).toBe(true);
      expect(await sha(launcher!)).toBe(launcherHash);
    }
    // The product's conventional global root under this HOME (`~/.deckent`) is sealed the same way.
    const userRegistry = await f.call('run_shell', { command: 'echo {} > "$HOME/.deckent/mcp.json"' }, 'deny', fa);
    expect(/exit [1-9]/u.test(userRegistry.text)).toBe(true);
    expect(await exists(join(f.home, '.deckent/mcp.json'))).toBe(false);

    // Hard floor, credential patterns in HOME: masked (protected, not absent).
    const creds = await f.call('run_shell', { command: 'cat "$HOME/.config/tool/id.pem"; cat "$HOME/.npmrc"' }, 'deny', fa);
    expect(creds.text).not.toContain('PEM-SECRET');
    expect(creds.text).not.toContain('NPM-SECRET');
    expect(await readFile(join(f.home, '.npmrc'), 'utf8')).toContain('NPM-SECRET');

    // Standart/full-auto keep the closed view: even a call the owner approves at its card (not a full-access turn) has no network and an
    // empty HOME.
    const closedNet = await f.call('run_shell', { command: fetchCommand(port) }, 'allow');
    expect({ card: closedNet.card, ran: /sandbox: bubblewrap; exit [1-9]/u.test(closedNet.text), pong: closedNet.text.includes('open-sandbox-pong') }).toEqual({ card: true, ran: true, pong: false });
    const closedHome = await f.call('run_shell', { command: 'cat "$HOME/notes.txt"' }, 'allow');
    expect({ ran: /sandbox: bubblewrap; exit [1-9]/u.test(closedHome.text), read: closedHome.text.includes('home-notes') }).toEqual({ ran: true, read: false });
  }, 240_000);

  it.skipIf(!bwrapReady)('owner Y: an existing non-product subdirectory of .deckent (tracked docs) is writable — git checkout completes clean; the root and product dirs take no name', async () => {
    const f = await openRuntime({ schemaVersion: 1, realm: 'require-sandbox' });
    await mkdir(join(f.project, '.deckent/docs'), { recursive: true });
    await mkdir(join(f.project, '.deckent/crashes'), { recursive: true });
    await writeFile(join(f.project, '.gitignore'), '.deckent/*\n!.deckent/docs/\n');
    await writeFile(join(f.project, '.deckent/docs/a.md'), 'v1\n');
    git(f.project, 'add', '-A'); git(f.project, 'commit', '-qm', 'docs v1');
    await writeFile(join(f.project, '.deckent/docs/a.md'), 'v2\n');
    git(f.project, 'commit', '-qam', 'docs v2');
    const checkout = await f.call('run_shell', { command: 'git checkout -q HEAD~1 && git status --porcelain && echo CHECKOUT_DONE' }, 'deny', fa);
    expect({ status: checkout.status, done: checkout.text.includes('CHECKOUT_DONE') }).toEqual({ status: 'ok', done: true });
    expect(await readFile(join(f.project, '.deckent/docs/a.md'), 'utf8')).toBe('v1\n');
    expect(git(f.project, 'status', '--porcelain')).toBe('');
    const back = await f.call('run_shell', { command: 'git checkout -q - && echo new > .deckent/docs/new.md && echo DOCS_OK' }, 'deny', fa);
    expect(back.text).toContain('DOCS_OK');
    expect(await readFile(join(f.project, '.deckent/docs/a.md'), 'utf8')).toBe('v2\n');
    // The root takes no new name, and a registry resource directory (`crashes`) and the data root stay read-only.
    for (const command of ['mkdir "$(printf .deck)ent/docs2"', 'echo {} > "$(printf .deck)ent/mcp.json"', 'mkdir "$(printf .deck)ent/newdir"',
      'touch "$(printf .deck)ent/crashes/x"', 'touch "$(printf .deck)ent/data/x"']) {
      const refused = await f.call('run_shell', { command }, 'deny', fa);
      expect({ command, failed: /exit [1-9]/u.test(refused.text), erofs: /Read-only file system|Permission denied/u.test(refused.text) }).toEqual({ command, failed: true, erofs: true });
    }
    for (const path of ['.deckent/docs2', '.deckent/mcp.json', '.deckent/newdir', '.deckent/crashes/x', '.deckent/data/x']) expect({ path, exists: await exists(join(f.project, path)) }).toEqual({ path, exists: false });
  }, 180_000);

  it.skipIf(!bwrapReady)('SANDBOX-AD-SIZINTISI: neither view lists a product state name; the data root shows only the call\'s own scratch path, and .deckent/docs stays writable', async () => {
    const f = await openRuntime({ schemaVersion: 1, realm: 'require-sandbox' });
    await mkdir(join(f.project, '.deckent/docs'), { recursive: true });
    const names = 'find .deckent/data | sort; touch .deckent/data/planted 2>&1; echo "plant=$?"; echo ok > .deckent/docs/n.md; echo "rc=$?"';
    const open = await f.call('run_shell', { command: names }, 'deny', fa);
    const closed = await f.call('run_shell', { command: names }, 'allow');
    for (const [view, result] of [['open', open], ['closed', closed]] as const) {
      const listed = [...new Set(result.text.split('\n').filter(line => line.startsWith('.deckent/data')).map(line => line.replace(/\/[0-9a-f]{32}.*$/u, '')))];
      expect({ view, listed }).toEqual({ view, listed: ['.deckent/data', '.deckent/data/state', '.deckent/data/state/scratch'] });
      expect(result.text, view).not.toMatch(/ledger|runtime\.sock|backups|approvals|policy\.json|bindings\.json|installation-identity/u);
      expect(result.text, view).toContain('rc=0');
      expect(result.text, view).toContain('plant=1');   // the emptied directory is read-only: nothing is created in it
    }
    expect(await exists(join(f.project, '.deckent/data/planted'))).toBe(false);
    expect(await readFile(join(f.project, '.deckent/docs/n.md'), 'utf8')).toBe('ok\n');
  }, 180_000);

  it.skipIf(landlockAbi < 6)('without bubblewrap, full access is refused without a card or any host effect', async () => {
    for (const realm of ['prefer-sandbox', 'require-sandbox'] as const) {
      const f = await openRuntime({ schemaVersion: 1, realm }, landlockOnly);
      const marker = join(f.home, 'full-access-must-not-run');
      const result = await f.call('run_shell', { command: `cat "$HOME/notes.txt"; echo leaked > "${marker}"` }, 'deny', fa);
      expect(result.text).toContain('SHELL_SANDBOX_UNAVAILABLE');
      expect(result.text).not.toContain('home-notes');
      expect(result.card).toBe(false);
      expect(await exists(marker)).toBe(false);
      await closeModeRuntimes();
    }
  }, 180_000);
  for (const provider of ['bubblewrap', 'landlock'] as const) {
    it.skipIf(provider === 'bubblewrap' ? !bwrapReady : landlockAbi < 6)(`${provider}: full-auto asks for deletion, truncation and moves before any sandbox effect`, async () => {
      const f = await modeRuntime({ shell: { schemaVersion: 1, realm: 'require-sandbox' }, mode: 'full-auto',
        grants: [rule('shell', 'agent-tool', ['run_shell'], 'require-approval', true), rule('run', 'operation', ['host.shell.run'], 'allow')],
        ...(provider === 'landlock' ? { sandboxes: landlockOnly } : {}) });
      const original = await readFile(join(f.project, 'src/a.ts'), 'utf8');
      for (const command of ['find src -delete', '> src/a.ts', `mv src '${join(f.project, 'must-not-move')}'`]) {
        const result = await f.call('run_shell', { command }, 'deny');
        expect(result).toMatchObject({ card: true, status: 'denied' });
        expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe(original);
      }
      expect(await exists(join(f.project, 'must-not-move'))).toBe(false);
      await f.writeAuthority([rule('shell', 'agent-tool', ['run_shell'], 'require-approval', true), rule('run', 'operation', ['host.shell.run'], 'allow')], 'ask', 'floor');
      const config = join(f.project, '.deckent/config.json'), before = await readFile(config, 'utf8');
      const approved = await f.call('run_shell', { command: 'printf X >> "$(printf .deck)ent/config.json"' }, 'allow');
      expect(approved).toMatchObject({ card: true, status: 'error' });
      expect(approved.text).toMatch(/Read-only file system|Permission denied/u);
      expect(await readFile(config, 'utf8')).toBe(before);
      const card = approved.events.find(event => event.kind === 'approval.requested');
      expect(JSON.stringify(card)).not.toContain('protected files included');

    }, 120_000);
  }

});
