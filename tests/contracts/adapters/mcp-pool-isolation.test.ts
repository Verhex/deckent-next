import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpClientPool, mcpToolPinDigest, type McpClientSettings } from '#adapters/index.js';
// @ts-expect-error -- a plain ESM test fixture (no declaration file)
import { startMcpHttpFixture } from '../../fixtures/mcp-http-server.mjs';

// Security (lead 2026-10-07, "MCP pool scope isolation"): the runtime service keeps ONE MCP pool. Its processes used to be named by server id
// only, and the change key did not cover the working directory, the sandbox view or the scope: project B's turn with the same id and command
// reused project A's process, so B's calls ran in A's file-system view. Every turn now reaches the pool through the view of its scope and
// project; no process or HTTP client is shared between views; the service's processes are bounded (`mcp.maxServers`, idle one closed first).
const roots: string[] = [], closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const settings = (servers: McpClientSettings['servers']): McpClientSettings => ({ connectTimeoutMs: 15_000, callTimeoutMs: 15_000, resultMaxBytes: 4_096, maxRestarts: 1,
  inputMaxBytes: 1_048_576, servers });
const where = { name: 'where', description: 'Where am I', inputSchema: { type: 'object', properties: {} } };
// A dependency-free 2025-era stdio server: `where` answers its pid and working directory and appends the call to `<cwd>/calls.log`.
const SERVER = `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'where', version: '1' } } });
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'where', description: 'Where am I', inputSchema: { type: 'object', properties: {} } }] } });
  else if (m.method === 'tools/call') { appendFileSync(process.cwd() + '/calls.log', String(process.pid) + '\\n');
    send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, cwd: process.cwd() }) }] } }); }
  else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'Method not found' } }); });
`;
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'deckent-mcp-pool-')); roots.push(root);
  const script = join(root, 'where.mjs'); writeFileSync(script, SERVER);
  const project = (name: string) => { const dir = join(root, name); mkdirSync(dir); return dir; };
  const server = (id = 'fx') => ({ id, command: process.execPath, args: [script], env: {}, realm: 'host' as const, tools: [{ name: 'where', digest: mcpToolPinDigest(where), alwaysAsk: false }] });
  const pool = (options: { maxServers?: number } = {}) => { const created = new McpClientPool(new AbortController().signal, options); closers.push(() => created.close()); return created; };
  const signal = new AbortController().signal;
  const ask = async (view: ReturnType<McpClientPool['scoped']>, id = 'fx') => {
    const answer = await view.call(id, 'where', mcpToolPinDigest(where), {}, { timeoutMs: 10_000, signal });
    return answer.outcome === 'answered' && 'result' in answer ? JSON.parse((answer.result.content as { text: string }[])[0]!.text) as { pid: number; cwd: string } : answer;
  };
  const log = (dir: string) => existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean) : [];
  return { project, server, pool, ask, log };
}

describe.skipIf(process.platform === 'win32')('the MCP pool never shares a process between scopes or projects', () => {
  it('the same id and command in two projects are two processes in two working directories; A\'s server never receives B\'s call; reuse holds within one view', async () => {
    const f = setup(), pool = f.pool(), a = f.project('a'), b = f.project('b');
    const viewA = pool.scoped({ scopeId: 'scope', cwd: a }), viewB = pool.scoped({ scopeId: 'scope', cwd: b }), server = f.server();
    expect(await viewA.open(server, settings([server]), { cwd: a, environment: { PATH: process.env['PATH'] }, sandboxes: [] })).toMatchObject({ ok: true });
    expect(await viewB.open(server, settings([server]), { cwd: b, environment: { PATH: process.env['PATH'] }, sandboxes: [] })).toMatchObject({ ok: true });
    const fromA = await f.ask(viewA), fromB = await f.ask(viewB) as { pid: number; cwd: string };
    expect(fromA).toMatchObject({ cwd: a }); expect(fromB).toMatchObject({ cwd: b }); expect(fromB.pid).not.toBe((fromA as { pid: number }).pid);
    expect(f.log(a)).toEqual([String((fromA as { pid: number }).pid)]); expect(f.log(b)).toEqual([String(fromB.pid)]);
    // Within one view the process is reused (a second open lists again on the same process).
    await viewA.open(server, settings([server]), { cwd: a, environment: { PATH: process.env['PATH'] }, sandboxes: [] });
    expect(await f.ask(viewA)).toMatchObject({ pid: (fromA as { pid: number }).pid });
    // A server id known in one view is unknown in another: nothing is sent.
    const other = pool.scoped({ scopeId: 'other-scope', cwd: a });
    expect(await f.ask(other)).toEqual({ outcome: 'refused', reason: 'not-connected' });
    expect(f.log(a)).toHaveLength(2);
    // Retaining a view's trusted servers touches no other view.
    viewB.retain(new Set());
    expect(await f.ask(viewB)).toEqual({ outcome: 'refused', reason: 'not-connected' });
    expect(await f.ask(viewA)).toMatchObject({ cwd: a });
  }, 60_000);

  it('the same project in two scopes is two processes too', async () => {
    const f = setup(), pool = f.pool(), a = f.project('a'), server = f.server();
    const one = pool.scoped({ scopeId: 's1', cwd: a }), two = pool.scoped({ scopeId: 's2', cwd: a });
    await one.open(server, settings([server]), { cwd: a, environment: { PATH: process.env['PATH'] }, sandboxes: [] });
    await two.open(server, settings([server]), { cwd: a, environment: { PATH: process.env['PATH'] }, sandboxes: [] });
    expect((await f.ask(one) as { pid: number }).pid).not.toBe((await f.ask(two) as { pid: number }).pid);
  }, 60_000);

  it('bounded: over mcp.maxServers the idle one longest unused is closed; the newest views keep theirs', async () => {
    const f = setup(), pool = f.pool({ maxServers: 2 }), dirs = ['a', 'b', 'c'].map(f.project), server = f.server();
    const views = dirs.map(cwd => pool.scoped({ scopeId: 'scope', cwd }));
    for (const [index, view] of views.entries()) expect(await view.open(server, settings([server]), { cwd: dirs[index]!, environment: { PATH: process.env['PATH'] }, sandboxes: [] }))
      .toMatchObject({ ok: true });
    expect(await f.ask(views[0]!)).toEqual({ outcome: 'refused', reason: 'not-connected' });
    expect(await f.ask(views[1]!)).toMatchObject({ cwd: dirs[1] }); expect(await f.ask(views[2]!)).toMatchObject({ cwd: dirs[2] });
  }, 60_000);

  it('HTTP: the same URL in two views is two clients, each sending only its own headers', async () => {
    const http = await startMcpHttpFixture() as { url: string; requests: { headers: Record<string, string> }[]; close(): Promise<void> }; closers.push(() => http.close());
    const f = setup(), pool = f.pool(), a = f.project('a'), b = f.project('b'), echo = { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } };
    const server = (token: string) => ({ id: 'web', transport: 'http' as const, url: http.url, headers: { Authorization: `Bearer ${token}` }, command: '', args: [], env: {}, realm: 'host' as const,
      tools: [{ name: 'echo', digest: mcpToolPinDigest(echo), alwaysAsk: false }] });
    const viewA = pool.scoped({ scopeId: 'scope', cwd: a }), viewB = pool.scoped({ scopeId: 'scope', cwd: b });
    await viewA.open(server('token-a'), settings([server('token-a')]), { cwd: a, environment: {}, sandboxes: [] });
    const before = http.requests.length;
    await viewB.open(server('token-b'), settings([server('token-b')]), { cwd: b, environment: {}, sandboxes: [] });
    await viewB.call('web', 'echo', mcpToolPinDigest(echo), {}, { timeoutMs: 10_000, signal: new AbortController().signal });
    expect(http.requests.slice(before).every(request => request.headers['authorization'] === 'Bearer token-b')).toBe(true);
    const fromA = http.requests.length;
    await viewA.call('web', 'echo', mcpToolPinDigest(echo), {}, { timeoutMs: 10_000, signal: new AbortController().signal });
    expect(http.requests.slice(fromA).every(request => request.headers['authorization'] === 'Bearer token-a')).toBe(true);
  }, 60_000);
});
