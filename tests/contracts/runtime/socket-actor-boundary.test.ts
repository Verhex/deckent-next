import { execFileSync, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_SERVICE_SCHEMA_VERSION } from '#engine/index.js';
import { resolveProductLayout } from '#platform/index.js';
import { createGlobMatcher, createWorkspaceScope, DEFAULT_WORKSPACE_READ_DENY, REPOSITORY_INTERNALS_DENY, type ShellSandboxLayout } from '#adapters/index.js';
import { bubblewrapArguments, bubblewrapShellSandbox, recheckRuntimeSocketMasks, resolveBubblewrapView } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { prepareRuntimeSocket, startLocalRuntimeSocketServer, type LocalRuntimeSocketOptions, type LocalRuntimeSocketServer } from '../../../src/adapters/core/local-runtime-socket/index.js';
import { landlockShellSandbox, resolveShellRealm } from '#adapters/core/host-shell/index.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

/**
 * SEC-1 (Claude Security F27 + F32): an agent shell of a full-access turn runs in bubblewrap's open view (host `/` bound, host network, the
 * owner's uid). Before the fix it could find the runtime socket under `/tmp/dk-<uid>-*`, connect, and send a v29 frame without `channel`;
 * the adapter admitted it on uid equality alone and the service treated it as the human owner. Two separate layers are proven here, each
 * with the risky input kept: (a) the real open view the adapter builds hides every runtime socket directory, so the endpoint is not even
 * reachable; (b) a peer in another PID/mount/user namespace that CAN reach the endpoint (a socket outside the mask) is refused at accept,
 * before any frame is read or dispatched. The client inside the sandbox is plain `node:net`, the same bytes any shell command could send.
 */
const measured = await measureTestShellHost();
const launcher = measured.bubblewrap.status === 'available' ? measured.bubblewrap.launcher?.path ?? null : null;
const landlockAbi = (() => {
  try { return process.platform === 'linux' ? Number(JSON.parse(execFileSync(join(import.meta.dirname, '../../../src/adapters/core/host-shell/native/build/Release/shell-capabilities'),
    { encoding: 'utf8' })).landlockAbi) : 0; } catch { return 0; }
})();
const owned: string[] = [];
// RESTART-HUNT (alpha.56.1): the kernel's bound-socket table can be made unreadable for one call; every other read is the real one.
const procTable = vi.hoisted(() => ({ unreadable: false, deniedStat: '', beforeRealpath: null as null | { path: string; run: () => Promise<void> } }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = ((path: unknown, ...rest: unknown[]) => procTable.unreadable && path === '/proc/net/unix'
    ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) : (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest)) as typeof actual.readFile;
  const lstat = ((path: unknown, ...rest: unknown[]) => path === procTable.deniedStat
    ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) : (actual.lstat as (...args: unknown[]) => unknown)(path, ...rest)) as typeof actual.lstat;
  const realpath = (async (path: unknown, ...rest: unknown[]) => {
    if (procTable.beforeRealpath?.path === path) { const hook = procTable.beforeRealpath; procTable.beforeRealpath = null; await hook.run(); }
    return (actual.realpath as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.realpath;
  return { ...actual, readFile, lstat, realpath, default: { ...actual, readFile, lstat, realpath } };
});
const servers: LocalRuntimeSocketServer[] = [];
afterEach(async () => {
  procTable.unreadable = false; procTable.deniedStat = ''; procTable.beforeRealpath = null;
  await Promise.all(servers.splice(0).map(server => server.dispose().catch(() => undefined)));
  await Promise.all(owned.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

// Writes one v29 frame with no `channel` (the request every CLI sends) and prints what came back: a response, a closed connection, or an error.
const CLIENT = String.raw`
const net = require('node:net'); const [endpoint, version] = process.argv.slice(1);
const body = Buffer.from(JSON.stringify({ schemaVersion: Number(version), requestId: 'sandbox-request', operation: 'describeService', input: {} }));
const head = Buffer.alloc(4); head.writeUInt32BE(body.length, 0);
let printed = false; const print = value => { if (!printed) { printed = true; process.stdout.write(JSON.stringify(value) + '\n'); } };
const socket = net.createConnection(endpoint); const chunks = [];
socket.on('connect', () => socket.end(Buffer.concat([head, body])));
socket.on('data', chunk => chunks.push(chunk));
socket.on('error', error => print({ error: error.code }));
socket.on('close', () => { const frame = Buffer.concat(chunks); print(frame.length > 4 ? { response: JSON.parse(frame.subarray(4).toString('utf8')) } : { closed: true }); });
setTimeout(() => { print({ timeout: true }); process.exit(0); }, 5000).unref();
`;

function options(endpoint: string): LocalRuntimeSocketOptions {
  return { endpoint, maxConnections: 4, inputMaxBytes: 4096, responseMaxBytes: 4096, acceptRetryDelayMs: 25, acceptRetryLimit: 3, headerTimeoutMs: 2_000, responseTimeoutMs: 2_000 };
}
async function serve(endpoint: string) {
  const seen: string[] = [];
  const server = await startLocalRuntimeSocketServer(options(endpoint), request => {
    seen.push(request.operation);
    return { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: true, result: { admitted: true } };
  });
  servers.push(server);
  return { server, seen };
}
// Asynchronous on purpose: the server under test runs in this process, so a synchronous child would block its accept loop.
function run(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.once('error', reject);
    child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}
function outcome(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  return line ? JSON.parse(line) as Record<string, unknown> : { noOutput: true };
}

describe.skipIf(process.platform !== 'linux')('SEC-1: an agent shell cannot reach or use the runtime socket', () => {
  it('pre-spawn only drops absent own-UID runtime masks from an open view; closed and unrelated masks stay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-sec1-recheck-')); owned.push(root);
    const endpoint = await prepareRuntimeSocket(resolveProductLayout({ projectRoot: root })), directory = dirname(endpoint); owned.push(directory);
    const unrelated = join(root, 'absent-credential'), privateIpc = `/tmp/dk-ipc-${process.getuid!()}`;
    const closed = { projectRoot: root, scratchDir: null, home: null, systemPaths: [], toolchainPaths: [], readOnlyPaths: [],
      maskedDirectories: [directory, unrelated, privateIpc], maskedFiles: [] };
    const view = { ...closed, open: { sealed: [], hidden: [] } };
    expect(await recheckRuntimeSocketMasks(view)).toBe(view);
    procTable.deniedStat = directory;
    expect(await recheckRuntimeSocketMasks(view)).toBe(view);
    procTable.deniedStat = '';
    await rmdir(directory);
    expect(await recheckRuntimeSocketMasks(closed)).toBe(closed);
    const rechecked = await recheckRuntimeSocketMasks(view);
    expect(rechecked.maskedDirectories).toEqual([unrelated, privateIpc]);
    expect(rechecked.maskedFiles).toBe(view.maskedFiles); expect(rechecked.open).toBe(view.open);
    expect(view.maskedDirectories).toEqual([directory, unrelated, privateIpc]);
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(!launcher)('(a) the full-access open view hides the runtime socket directory: the endpoint cannot be reached, nothing is dispatched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-sec1-open-')); owned.push(root);
    const project = join(root, 'project'), home = join(root, 'home'), global = join(root, 'global');
    await Promise.all([mkdir(join(project, '.deckent'), { recursive: true }), mkdir(home, { recursive: true }), mkdir(global, { recursive: true })]);
    const endpoint = await prepareRuntimeSocket(resolveProductLayout({ projectRoot: project }));
    owned.push(dirname(endpoint));
    expect(endpoint).toMatch(new RegExp(`^/tmp/dk-${process.getuid!()}-[0-9a-f]{64}/s$`));
    const { seen } = await serve(endpoint);
    const credentials = DEFAULT_WORKSPACE_READ_DENY.filter(pattern => !REPOSITORY_INTERNALS_DENY.includes(pattern)).map(createGlobMatcher);
    const layout: ShellSandboxLayout = { project: await createWorkspaceScope(project, DEFAULT_WORKSPACE_READ_DENY.filter(pattern => !REPOSITORY_INTERNALS_DENY.includes(pattern))),
      scratchDir: null, writeFloor: () => false, repositoryWritable: true,
      hardFloor: { roots: [join(project, '.deckent'), global], homeDenied: path => credentials.some(match => match(path)) } };
    const env = { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
    const view = await resolveBubblewrapView(layout, env, {}, { floorReadOnly: true, open: true });
    if (!view.ok) throw new Error(view.reason);
    const sandboxed = await run(launcher!, [...bubblewrapArguments(view.view), '--', process.execPath, '-e', CLIENT, endpoint, String(RUNTIME_SERVICE_SCHEMA_VERSION)], env);
    expect(sandboxed.status, sandboxed.stderr).toBe(0);
    // The directory is an empty tmpfs inside the view: the name does not resolve (ENOENT), so no connection and no request.
    expect(outcome(sandboxed.stdout)).toEqual({ error: 'ENOENT' });
    expect(seen).toEqual([]);
  });

  it.skipIf(!launcher)('(b) a peer in another PID/mount/user namespace that can reach the endpoint is refused at accept, before any frame is dispatched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-sec1-ns-')); owned.push(root);
    const parent = join(root, 'private'); await mkdir(parent, { mode: 0o700 });
    const endpoint = join(parent, 'runtime.sock');
    const { seen } = await serve(endpoint);
    // The host bound read-write at `/` (as the open view does) with every namespace but the network unshared, and no socket mask: the
    // endpoint is reachable, so only the adapter's peer check can stop the frame.
    const sandboxed = await run(launcher!, ['--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
      '--', process.execPath, '-e', CLIENT, endpoint, String(RUNTIME_SERVICE_SCHEMA_VERSION)]);
    expect(sandboxed.status, sandboxed.stderr).toBe(0);
    const result = outcome(sandboxed.stdout);
    expect(result).not.toHaveProperty('response');
    expect(seen).toEqual([]);
  });

  it('(c) a peer in the service\'s own namespaces is still admitted (the CLI and terminal path is unchanged)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-sec1-same-')); owned.push(root);
    const parent = join(root, 'private'); await mkdir(parent, { mode: 0o700 });
    const endpoint = join(parent, 'runtime.sock');
    const { seen } = await serve(endpoint);
    const plain = await run(process.execPath, ['-e', CLIENT, endpoint, String(RUNTIME_SERVICE_SCHEMA_VERSION)]);
    expect(plain.status, plain.stderr).toBe(0);
    expect(outcome(plain.stdout)).toEqual({ response: { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'sandbox-request', ok: true, result: { admitted: true } } });
    expect(seen).toEqual(['describeService']);
  });

  it.skipIf(landlockAbi < 1)('(d) the Landlock realm cannot open a unix socket at all: a reachable endpoint receives nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-sec1-landlock-')); owned.push(root);
    const parent = join(root, 'private'), project = join(root, 'project'), scratch = join(root, 'scratch');
    await Promise.all([mkdir(parent, { mode: 0o700 }), mkdir(project), mkdir(scratch)]);
    const endpoint = join(parent, 'runtime.sock');
    const { seen } = await serve(endpoint);
    const resolution = resolveShellRealm('prefer-sandbox', { platform: 'linux', bubblewrap: 'unavailable', userNamespace: 'available', landlock: { status: 'available', abi: landlockAbi } },
      [landlockShellSandbox({ project: await createWorkspaceScope(project), scratchDir: scratch })]);
    if (!resolution.ok || resolution.realm.kind !== 'landlock') throw new Error('landlock realm expected');
    const ran = await resolution.realm.run({ command: `python3 -c "import socket; s = socket.socket(socket.AF_UNIX); s.connect('${endpoint}'); print('connected')"`,
      cwd: project, environment: { PATH: '/usr/bin:/bin' } });
    // The refusal is the kernel's (seccomp refuses AF_UNIX in this realm), not a missing interpreter.
    expect(ran.output).toMatch(/PermissionError|Operation not permitted|Permission denied/u);
    expect(ran.output).not.toContain('connected');
    expect(seen).toEqual([]);
  });

  it.skipIf(!launcher)('(e) RESTART-HUNT: a listed runtime directory that is already gone is not masked, so bwrap never creates it on the host; a live one stays hidden; the residual window is healed only by the service start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-sec1-gone-')); owned.push(root);
    const project = join(root, 'project'), home = join(root, 'home'), global = join(root, 'global');
    await Promise.all([mkdir(join(project, '.deckent'), { recursive: true }), mkdir(home, { recursive: true }), mkdir(global, { recursive: true })]);
    const live = await prepareRuntimeSocket(resolveProductLayout({ projectRoot: project })); owned.push(dirname(live));
    const { seen } = await serve(live);
    // A stopping service: its socket file and empty directory are removed while its listener is still open, so /proc/net/unix still lists it.
    const goneLayout = resolveProductLayout({ projectRoot: join(root, 'other') }), gone = await prepareRuntimeSocket(goneLayout), goneDir = dirname(gone); owned.push(goneDir);
    const listeners: NetServer[] = [];
    const bind = async () => { const server = createNetServer(); listeners.push(server); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(gone, resolve); }); };
    const stop = async () => { await rm(gone); await rmdir(goneDir); };
    const credentials = DEFAULT_WORKSPACE_READ_DENY.filter(pattern => !REPOSITORY_INTERNALS_DENY.includes(pattern)).map(createGlobMatcher);
    const layout: ShellSandboxLayout = { project: await createWorkspaceScope(project, DEFAULT_WORKSPACE_READ_DENY.filter(pattern => !REPOSITORY_INTERNALS_DENY.includes(pattern))),
      scratchDir: null, writeFloor: () => false, repositoryWritable: true,
      hardFloor: { roots: [join(project, '.deckent'), global], homeDenied: path => credentials.some(match => match(path)) } };
    const env = { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
    const openView = () => resolveBubblewrapView(layout, env, {}, { floorReadOnly: true, open: true });
    try {
      await bind(); await stop();
      expect(await readFile('/proc/net/unix', 'utf8')).toContain(gone);
      const view = await openView(); if (!view.ok) throw new Error(view.reason);
      expect(view.view.maskedDirectories).toContain(dirname(live));
      expect(view.view.maskedDirectories).not.toContain(goneDir);
      const ran = await run(launcher!, [...bubblewrapArguments(view.view), '--', '/bin/true'], env);
      expect(ran.status, ran.stderr).toBe(0);
      await expect(lstat(goneDir)).rejects.toMatchObject({ code: 'ENOENT' });
      // The residual window (listed and present at build, gone before bwrap mounts): bwrap leaves a 0755 directory on the host. A reader
      // still refuses it; only the service start re-creates it owner-only.
      await prepareRuntimeSocket(goneLayout); await bind();
      const racing = await openView(); if (!racing.ok) throw new Error(racing.reason);
      expect(racing.view.maskedDirectories).toContain(goneDir);
      // A failed stat is not evidence of absence: keep that mask and all non-runtime masks, even missing ones.
      procTable.deniedStat = goneDir;
      expect(await recheckRuntimeSocketMasks(racing.view)).toBe(racing.view);
      procTable.deniedStat = '';
      await stop();
      // alpha.57 pre-spawn re-check: the same stale view, checked again right before the spawn, drops the vanished mask (the live one stays),
      // so bwrap creates nothing on the host.
      const rechecked = await recheckRuntimeSocketMasks(racing.view);
      expect(rechecked.maskedDirectories).toContain(dirname(live)); expect(rechecked.maskedDirectories).not.toContain(goneDir);
      expect(rechecked.maskedDirectories).toEqual(racing.view.maskedDirectories.filter(path => path !== goneDir));
      const hidden = await run(launcher!, [...bubblewrapArguments(rechecked), '--', process.execPath, '-e', CLIENT, live, String(RUNTIME_SERVICE_SCHEMA_VERSION)], env);
      expect(hidden.status, hidden.stderr).toBe(0); expect(outcome(hidden.stdout)).toEqual({ error: 'ENOENT' });
      await expect(lstat(goneDir)).rejects.toMatchObject({ code: 'ENOENT' });
      // Exercise the production realm: remove the listed directory during HOME resolution, after the socket mask scan.
      await prepareRuntimeSocket(goneLayout); await bind();
      const usable = bubblewrapShellSandbox(layout).usable(measured); if (!usable.ok) throw new Error(usable.reason);
      procTable.beforeRealpath = { path: home, run: stop };
      const command = [process.execPath, '-e', CLIENT, live, String(RUNTIME_SERVICE_SCHEMA_VERSION)].map(value => `'${value.replace(/'/gu, "'\\''")}'`).join(' ');
      const started = await usable.realm.run({ command, cwd: project, environment: env, open: true, writeFloorReadOnly: true });
      expect(procTable.beforeRealpath).toBeNull(); expect(started.status, started.output).toBe('exited'); expect(started.exitCode).toBe(0);
      expect(outcome(started.output)).toEqual({ error: 'ENOENT' });
      await expect(lstat(goneDir)).rejects.toMatchObject({ code: 'ENOENT' });
      // The MCP launch uses a private /tmp and keeps both live and stopped host endpoints out of its view.
      const serverLaunch = await usable.launch!(env); if (!serverLaunch.ok) throw new Error(serverLaunch.reason);
      const server = await run(serverLaunch.file, [...serverLaunch.args, '--', process.execPath, '-e', CLIENT, live, String(RUNTIME_SERVICE_SCHEMA_VERSION)], env);
      expect(server.status, server.stderr).toBe(0); expect(outcome(server.stdout)).toEqual({ error: 'ENOENT' });
      expect(seen).toEqual([]);
      await expect(lstat(goneDir)).rejects.toMatchObject({ code: 'ENOENT' });
      // Without the re-check (the mount after the directory vanished) bwrap leaves a 0755 directory on the host; the start still heals it.
      expect((await run(launcher!, [...bubblewrapArguments(racing.view), '--', '/bin/true'], env)).status).toBe(0);
      expect((await lstat(goneDir)).mode & 0o777).toBe(0o755);
      await expect(prepareRuntimeSocket(goneLayout, false)).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_ENDPOINT_UNSAFE', reason: 'parent-mode' });
      const healed: string[] = [];
      expect(await prepareRuntimeSocket(goneLayout, true, reason => healed.push(reason))).toBe(gone);
      expect(healed).toEqual(['parent-mode']); expect((await lstat(goneDir)).mode & 0o777).toBe(0o700);
      // An unreadable bound-socket table still refuses the open view.
      procTable.unreadable = true;
      expect(await openView()).toMatchObject({ ok: false, reason: expect.stringContaining('cannot be listed') });
    } finally { procTable.unreadable = false; for (const server of listeners) server.close(); }
  });
});
