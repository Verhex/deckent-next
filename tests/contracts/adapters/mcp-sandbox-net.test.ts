import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bubblewrapArguments } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { bubblewrapShellSandbox, createWorkspaceScope, isWriteApprovalFloored, McpClientPool, mcpDefinitionDigest, mcpToolPinDigest, type McpClientSettings } from '#adapters/index.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

// L1 MCP-CORE K4 (Jev 68a10d1a, TUI3 2026-10-07): the default MCP realm `sandbox-net` — a bubblewrap sandbox with the host network and the
// server's own private, persistent HOME (npx/uvx caches), the project read-only, the user's HOME (`~/.ssh`, the Deckent secret store) and the
// project's secrets (`.env`) hidden. No sandbox → no start (never a host fallback). Real bubblewrap (the locked 0.13 build) where the host has it.
const roots: string[] = [], pools: McpClientPool[] = [], listeners: Server[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.close();
  for (const server of listeners.splice(0)) await new Promise<void>(done => server.close(() => done()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const settings = (servers: McpClientSettings['servers']): McpClientSettings => ({ connectTimeoutMs: 30_000, callTimeoutMs: 20_000, resultMaxBytes: 16_384, maxRestarts: 1,
  inputMaxBytes: 1_048_576, servers });
const probeTool = { name: 'probe', description: 'What can I reach', inputSchema: { type: 'object', properties: {} } };
// A dependency-free 2025-era stdio server whose one tool reports what it can read, write and reach (paths and a loopback port from argv).
const PROBE = `import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { connect } from 'node:net';
const [envFile, sshKey, store, projectFile, port] = process.argv.slice(2);
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const read = path => { try { return readFileSync(path, 'utf8'); } catch (error) { return error.code; } };
const write = path => { try { writeFileSync(path, 'x'); return 'written'; } catch (error) { return error.code; } };
const reach = () => new Promise(done => { const socket = connect(Number(port), '127.0.0.1'); socket.once('connect', () => { socket.destroy(); done('reached'); });
  socket.once('error', error => done(error.code)); });
createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } } });
  else if (message.method === 'tools/list') send({ id: message.id, result: { tools: [{ name: 'probe', description: 'What can I reach', inputSchema: { type: 'object', properties: {} } }] } });
  else if (message.method === 'tools/call') {
    const cache = process.env.HOME + '/.cache/probe'; let before = read(cache + '/marker');
    try { mkdirSync(cache, { recursive: true }); writeFileSync(cache + '/marker', 'kept'); } catch {}
    send({ id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ env: read(envFile), ssh: read(sshKey), store: read(store), projectWrite: write(projectFile),
      cacheBefore: before, network: await reach() }) }] } });
  } else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
});
`;

describe('sandbox-net arguments (pure)', () => {
  it('keeps the network and binds the server\'s own HOME at HOME; the closed view keeps neither', () => {
    const view = { projectRoot: '/p', projectReadOnly: true, scratchDir: null, home: '/home/u', systemPaths: [], toolchainPaths: [], readOnlyPaths: [], maskedDirectories: [], maskedFiles: [] };
    const closed = bubblewrapArguments(view), net = bubblewrapArguments({ ...view, network: true, homeBind: '/state/mcp-home/fx' });
    expect(closed).not.toContain('--share-net'); expect(closed.join(' ')).toContain('--tmpfs /home/u');
    expect(net.slice(0, 2)).toEqual(['--unshare-all', '--share-net']);
    expect(net.join(' ')).toContain('--bind /state/mcp-home/fx /home/u'); expect(net.join(' ')).not.toContain('--tmpfs /home/u');
    expect(net.join(' ')).toContain('--ro-bind /p /p');
  });
  it('trust binds the effective realm: an entry without a realm changes its digest with the default; one that names its realm does not', () => {
    expect(mcpDefinitionDigest('fx', { command: 'x' })).toBe(mcpDefinitionDigest('fx', { command: 'x', realm: 'sandbox-net' }));
    expect(mcpDefinitionDigest('fx', { command: 'x' })).not.toBe(mcpDefinitionDigest('fx', { command: 'x', realm: 'prefer-sandbox' }));
  });
});

const capabilities = await measureTestShellHost();
describe.skipIf(capabilities.bubblewrap.status !== 'available')('sandbox-net in the real bubblewrap realm', () => {
  async function setup() {
    const root = mkdtempSync(join(tmpdir(), 'deckent-mcp-net-')); roots.push(root);
    const home = join(root, 'home'), project = join(root, 'project'), homes = join(root, 'state', 'mcp-home');
    for (const dir of [join(home, '.ssh'), join(home, '.deckent'), join(project, 'tools')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'SSH-PRIVATE-KEY\n'); writeFileSync(join(home, '.deckent', 'secrets.json'), '{"secrets":"STORE"}\n');
    writeFileSync(join(project, '.env'), 'API_KEY=PROJECT-SECRET\n'); writeFileSync(join(project, 'tools', 'probe.mjs'), PROBE); writeFileSync(join(project, 'README.md'), 'readme\n');
    const listener = createServer(socket => socket.destroy()); listeners.push(listener);
    await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
    const scope = await createWorkspaceScope(project), sandboxes = [bubblewrapShellSandbox({ project: scope, scratchDir: null, writeFloor: isWriteApprovalFloored })];
    const environment = { HOME: home, USERPROFILE: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
    const server = (realm: 'sandbox-net' | 'require-sandbox' | 'host', id = realm.replace('-', '')) => ({ id, command: process.execPath, realm, env: {},
      args: [join(project, 'tools', 'probe.mjs'), join(project, '.env'), join(home, '.ssh', 'id_rsa'), join(home, '.deckent', 'secrets.json'), join(project, 'README.md'),
        String((listener.address() as { port: number }).port)], tools: [{ name: 'probe', digest: mcpToolPinDigest(probeTool), alwaysAsk: false }] });
    const probe = async (spec: ReturnType<typeof server>, pool = new McpClientPool(new AbortController().signal)) => {
      pools.push(pool);
      const opened = await pool.open(spec, settings([spec]), { cwd: project, environment, sandboxes, homeRoot: homes });
      expect(opened).toMatchObject({ ok: true, sandboxed: spec.realm !== 'host' });
      const answer = await pool.call(spec.id, 'probe', mcpToolPinDigest(probeTool), {}, { timeoutMs: 20_000, signal: new AbortController().signal });
      return { opened, result: JSON.parse((answer as { result: { content: { text: string }[] } }).result.content[0]!.text) as Record<string, string> };
    };
    return { project, home, homes, server, probe };
  }

  it('network on and its own persistent HOME; the project read-only; .env, ~/.ssh and the Deckent secret store unreadable (the host reaches all of them)', async () => {
    const f = await setup();
    const host = await f.probe(f.server('host'));
    expect(host.result).toMatchObject({ env: 'API_KEY=PROJECT-SECRET\n', ssh: 'SSH-PRIVATE-KEY\n', store: '{"secrets":"STORE"}\n', projectWrite: 'written', network: 'reached' });
    writeFileSync(join(f.project, 'README.md'), 'readme\n');
    const net = await f.probe(f.server('sandbox-net'));
    expect(net.opened.ok && net.opened.posture).toMatch(/its own private HOME \(a persistent cache\) is writable and the network is on/u);
    expect(net.result['network']).toBe('reached');
    expect(net.result['env']).not.toContain('PROJECT-SECRET'); expect(net.result['ssh']).toBe('ENOENT'); expect(net.result['store']).toBe('ENOENT');
    expect(net.result['projectWrite']).toMatch(/^(EROFS|EACCES)$/u);
    expect(readFileSync(join(f.project, 'README.md'), 'utf8')).toBe('readme\n');
    // The cache is the server's own directory under Deckent's state, private, and it survives a restart of the server.
    expect(statSync(join(f.homes, 'sandboxnet')).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(f.homes, 'sandboxnet', '.cache', 'probe', 'marker'), 'utf8')).toBe('kept');
    expect((await f.probe(f.server('sandbox-net'))).result['cacheBefore']).toBe('kept');
    // The closed sandbox (require-sandbox) keeps no network and no HOME.
    const closed = await f.probe(f.server('require-sandbox'));
    expect(closed.result['network']).not.toBe('reached'); expect(closed.result['cacheBefore']).toBe('ENOENT');
  }, 120_000);

  it('a real npx server starts in sandbox-net from a packed package (its npm cache in the server\'s own HOME; the project stays read-only)', async () => {
    const f = await setup(), pkg = join(f.project, 'tools', 'probe-pkg');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'deckent-probe-mcp', version: '1.0.0', type: 'module', bin: { 'deckent-probe-mcp': 'bin/probe.mjs' } }));
    writeFileSync(join(pkg, 'bin', 'probe.mjs'), `#!/usr/bin/env node\n${PROBE}`, { mode: 0o755 });
    // A packed tarball (as a registry serves it): npx extracts it into its cache in the server's HOME; a local folder would be linked into the read-only project.
    execFileSync(join(dirname(process.execPath), 'npm'), ['pack', '--pack-destination', join(f.project, 'tools')], { cwd: pkg, env: { ...process.env, HOME: f.home }, stdio: 'ignore' });
    const tarball = join(f.project, 'tools', 'deckent-probe-mcp-1.0.0.tgz');
    const spec = { ...f.server('sandbox-net', 'npxprobe'), command: join(dirname(process.execPath), 'npx'), args: ['--yes', '--offline', '--package', tarball, 'deckent-probe-mcp', ...f.server('sandbox-net').args.slice(1)] };
    const started = await f.probe(spec);
    expect(started.result['network']).toBe('reached'); expect(started.result['ssh']).toBe('ENOENT');
    expect(statSync(join(f.homes, 'npxprobe', '.npm')).isDirectory()).toBe(true);
  }, 180_000);

  it('without a usable sandbox the default realm does not start (never on the host); without a HOME root it is refused before anything runs', async () => {
    const f = await setup(), pool = new McpClientPool(new AbortController().signal); pools.push(pool);
    const spec = f.server('sandbox-net');
    expect(await pool.open(spec, settings([spec]), { cwd: f.project, environment: { HOME: f.home, PATH: '/usr/bin:/bin' }, sandboxes: [] }))
      .toMatchObject({ ok: false, reason: 'sandbox-unavailable', detail: 'no private HOME directory for this server' });
    expect(await pool.open(spec, settings([spec]), { cwd: f.project, environment: { HOME: f.home, PATH: '/usr/bin:/bin' }, sandboxes: [], homeRoot: f.homes }))
      .toMatchObject({ ok: false, reason: 'sandbox-unavailable' });
  }, 60_000);
});
