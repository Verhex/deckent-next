import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeMcpApproval, describeMcpResult, describeMcpTrustCard, expandMcpEntry, loadMcpRegistry, mcpClientSettings, MCP_CLIENT_IDENTITY, McpClientPool, mcpEndpointRefusal, mcpTurnTools,
  openMcpAgentTools, openTurnMcp, resolveMcpRegistry, runMcpCommand, type McpCommandContext, type McpCommandRequest, type McpTrustCard } from '#adapters/index.js';
import { clearConfigCache, loadConfig, productResourcePath } from '#platform/index.js';
import { agentToolApprovalFacts } from '#engine/index.js';
import { mcpCommand, type CommandContext } from '#surfaces/core/cli/index.js';
import { renderMcpStartNotice } from '#composition/core/agent-turn/index.js';
// @ts-expect-error -- a plain ESM test fixture (no declaration file)
import { startMcpHttpFixture } from '../../fixtures/mcp-http-server.mjs';

// L1 MCP-CORE item 1 (TUI3 2026-10-07): Streamable HTTP servers (MCP 2026-07-28: stdio and Streamable HTTP are the standard transports, no protocol
// session; SDK @modelcontextprotocol/client 2.3.1 `StreamableHTTPClientTransport`). A `$DECK:` reference in a header resolves only for a personal
// scope and its value never reaches an output, the audit, a card, the approval preview or the model. SSE is not a transport of this client.
interface HttpFixture { readonly url: string; readonly requests: { method: string; headers: Record<string, string> }[]; close(): Promise<void> }
const SECRET = 'ghp_SECRETvalue0123456789abcdefXYZ';
const roots: string[] = [], closers: (() => Promise<void>)[] = [];
afterEach(async () => { clearConfigCache(); for (const close of closers.splice(0)) await close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => { const started = await startMcpHttpFixture() as HttpFixture; closers.push(() => started.close()); return started; };

describe('MCP HTTP entries (pure)', () => {
  it('the registry takes `type: http` with url and headers; SSE, WebSocket and the streamable-http alias are named as unsupported transports', () => {
    const resolved = resolveMcpRegistry([{ scope: 'user', file: 'u', servers: {
      web: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer $DECK:GH' } },
      old: { type: 'sse', url: 'https://mcp.example.com/sse' }, ws: { type: 'ws', url: 'wss://x' }, alias: { type: 'streamable-http', url: 'https://x' },
      mixed: { type: 'http', url: 'https://x', command: 'node' }, crlf: { type: 'http', url: 'https://x', headers: { 'X-A': 'a\r\nX-Injected: 1' } } } }], null);
    expect(resolved.servers.map(server => server.name)).toEqual(['web']);
    expect(Object.fromEntries(resolved.problems.map(problem => [problem.name, problem.reason]))).toEqual({ old: 'transport-unsupported', ws: 'transport-unsupported',
      alias: 'transport-unsupported', mixed: 'invalid-entry', crlf: 'invalid-entry' });
  });
  it('the endpoint rule: https anywhere, plain http only on loopback, no other scheme and no credentials in the URL', () => {
    expect(mcpEndpointRefusal('https://mcp.example.com/mcp')).toBeNull();
    expect(mcpEndpointRefusal('http://127.0.0.1:8080/mcp')).toBeNull(); expect(mcpEndpointRefusal('http://localhost/mcp')).toBeNull(); expect(mcpEndpointRefusal('http://[::1]:9/mcp')).toBeNull();
    expect(mcpEndpointRefusal('http://mcp.example.com/mcp')).toBe('url-insecure-remote');
    expect(mcpEndpointRefusal('file:///etc/passwd')).toBe('url-scheme-refused'); expect(mcpEndpointRefusal('javascript:alert(1)')).toBe('url-scheme-refused');
    expect(mcpEndpointRefusal('https://user:pw@mcp.example.com/')).toBe('url-credentials'); expect(mcpEndpointRefusal('not a url')).toBe('url-invalid');
  });
  it('a header secret reference resolves only in a personal scope; a project file may not use one; ${VAR} follows the project credential rule', async () => {
    const secret = async (name: string) => name === 'GH' ? SECRET : undefined, entry = { type: 'http' as const, url: 'https://${HOST:-mcp.example.com}/mcp',
      headers: { Authorization: 'Bearer $DECK:GH', 'X-Region': '${REGION:-eu}' } };
    expect(await expandMcpEntry(entry, 'local', {}, secret)).toEqual({ ok: true, url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${SECRET}`, 'X-Region': 'eu' },
      secrets: [SECRET] });
    expect(await expandMcpEntry(entry, 'project', {}, secret)).toEqual({ ok: false, reason: 'secret-reference-in-project-file' });
    expect(await expandMcpEntry({ type: 'http', url: 'https://x/mcp', headers: { 'X-Token': '${API_TOKEN}' } }, 'project', { API_TOKEN: 'leak' }, secret))
      .toMatchObject({ ok: true, headers: { 'X-Token': '' } });
    expect(await expandMcpEntry({ type: 'http', url: 'https://x/mcp', headers: { A: '$DECK:NOPE' } }, 'user', {}, secret)).toEqual({ ok: false, reason: 'secret-unresolved:NOPE' });
    expect(await expandMcpEntry({ type: 'http', url: 'http://${HOST}/mcp' }, 'user', { HOST: 'mcp.example.com' }, secret)).toEqual({ ok: false, reason: 'url-insecure-remote' });
  });
});

async function workspace() {
  const base = mkdtempSync(join(tmpdir(), 'deckent-mcp-http-')); roots.push(base);
  const project = join(base, 'project'), home = join(base, 'home');
  mkdirSync(join(project, '.deckent'), { recursive: true }); mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(project, '.deckent', 'config.json'), '{}\n');
  const env = { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  const layout = (await loadConfig(project, { env })).productLayout;
  const audits: unknown[] = [], cards: McpTrustCard[] = [];
  const context: McpCommandContext = { projectRoot: project, layout, environment: env, secret: async name => name === 'GH' ? SECRET : undefined, sandboxes: [],
    principal: { issuer: 'test', subject: 'owner' }, describeNotice: notice => JSON.stringify(notice),
    ask: async card => { cards.push(card); return true; }, audit: async change => { audits.push(change); } };
  const run = (request: McpCommandRequest) => runMcpCommand(request, context);
  return { project, home, env, layout, context, run, audits, cards };
}

describe.skipIf(process.platform !== 'linux')('MCP HTTP servers end to end (a real Streamable HTTP SDK server on loopback)', () => {
  it('add, trust, list and call over Streamable HTTP: the header reaches the server on every request; its value is in no output, card, audit, preview or model text', async () => {
    const server = await fixture(), w = await workspace();
    const added = await w.run({ verb: 'add', scope: 'local', name: 'web-docs', entry: { type: 'http', url: server.url, headers: { Authorization: 'Bearer $DECK:GH' } } });
    expect(added).toMatchObject({ trust: 'trusted', pinnedTools: 2 });
    // The cards named the endpoint and the header NAME; nothing started before the launch card's yes.
    expect(w.cards.map(card => [card.phase, card.transport, card.command, card.headerNames, card.realm])).toEqual([['launch', 'http', server.url, ['Authorization'], 'none'],
      ['tools', 'http', server.url, ['Authorization'], 'none']]);
    expect(server.requests.length).toBeGreaterThan(0);
    expect(server.requests.every(request => request.headers['authorization'] === `Bearer ${SECRET}`)).toBe(true);
    // No protocol session in 2026-07-28: the client never sends one.
    expect(server.requests.some(request => 'mcp-session-id' in request.headers)).toBe(false);
    const listed = await w.run({ verb: 'list' }), got = await w.run({ verb: 'get', name: 'web-docs' });
    expect(listed).toMatchObject({ servers: [{ name: 'web-docs', transport: 'http', realm: null, status: 'trusted', health: 'connected', headerNames: ['Authorization'] }] });
    expect(got).toMatchObject({ server: { entry: { type: 'http', headers: { Authorization: 'Bearer $DECK:GH' } } } });
    // The model's view: the offered tools and their result. A server that echoes its credential hands the model a redaction, never the value.
    const view = await loadMcpRegistry(w.context), settings = mcpClientSettings(view, { inputMaxBytes: 65_536 })!, pool = new McpClientPool(new AbortController().signal); closers.push(() => pool.close());
    const offered = await openMcpAgentTools(pool, settings, { cwd: w.project, environment: w.env, sandboxes: [] });
    const whoami = [...offered.values()].find(entry => entry.tool === 'whoami')!;
    const answer = await pool.call(whoami.server, 'whoami', whoami.digest, {}, { timeoutMs: 10_000, signal: new AbortController().signal });
    expect(answer).toMatchObject({ outcome: 'answered' });
    const model = describeMcpResult(answer, whoami.display, 4_096, whoami);
    expect(model.text).toContain('called with: Bearer '); expect(model.text).not.toContain(SECRET);
    const preview = mcpTurnTools(offered).preview(whoami.spec.name, {});
    expect(preview).toContain(server.url);
    const echo = [...offered.values()].find(entry => entry.tool === 'echo')!, sentBefore = server.requests.length;
    expect(await pool.call(echo.server, 'echo', echo.digest, { payload: 'x'.repeat(100_000) }, { timeoutMs: 10_000, signal: new AbortController().signal }))
      .toMatchObject({ outcome: 'unknown', reason: 'failed' });
    expect(server.requests.length - sentBefore).toBe(1); // An oversized answer can follow an effect; never replay it.
    await w.run({ verb: 'add', scope: 'local', name: 'web-two', entry: { type: 'http', url: server.url } });
    let active = 0, peak = 0;
    const probe = vi.spyOn(McpClientPool.prototype, 'open').mockImplementation(async () => {
      peak = Math.max(peak, ++active); await new Promise(resolve => setImmediate(resolve)); active--;
      return { ok: false, reason: 'start-failed', detail: 'probe' };
    });
    try {
      const listed = await runMcpCommand({ verb: 'list' }, { ...w.context, limits: { maxServers: 1 } }) as { servers: { name: string }[] };
      expect(listed.servers.map(item => item.name)).toEqual(['web-docs', 'web-two']); expect(peak).toBe(1); expect(probe).toHaveBeenCalledTimes(2);
      const controller = new AbortController(); probe.mockClear().mockImplementation(async () => { controller.abort(); return { ok: false, reason: 'start-failed' }; });
      await expect(runMcpCommand({ verb: 'list' }, { ...w.context, signal: controller.signal, limits: { maxServers: 1 } })).rejects.toMatchObject({ name: 'AbortError' });
      expect(probe).toHaveBeenCalledTimes(1);
      probe.mockClear();
      await expect(runMcpCommand({ verb: 'list' }, { ...w.context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(probe).not.toHaveBeenCalled();
    } finally { probe.mockRestore(); }
    const cancelled = new AbortController(); let requests = 0;
    const slowHttp = createServer(() => { requests++; cancelled.abort(); });
    await new Promise<void>(resolve => slowHttp.listen(0, '127.0.0.1', resolve));
    const abortPool = new McpClientPool(cancelled.signal); closers.push(() => abortPool.close());
    try {
      const address = slowHttp.address() as { port: number }, stalled = { ...settings.servers[0]!, url: `http://127.0.0.1:${address.port}/mcp` };
      const opened = abortPool.open(stalled, settings, { cwd: w.project, environment: w.env, sandboxes: [] });
      const deadline = AbortSignal.timeout(3_000);
      expect(await Promise.race([opened, new Promise(resolve => deadline.addEventListener('abort', () => resolve('cancellation did not stop the HTTP probe'), { once: true }))]))
        .toMatchObject({ ok: false, reason: 'start-failed', detail: 'cancelled' });
      expect(requests).toBe(1);
    } finally { slowHttp.closeAllConnections(); await new Promise<void>(resolve => slowHttp.close(() => resolve())); }

    for (const shown of [JSON.stringify(listed), JSON.stringify(got), JSON.stringify(w.audits), w.cards.map(card => describeMcpTrustCard(card)).join('\n'), preview!, model.text,
      describeMcpApproval({ ...whoami, args: {} })]) expect(shown).not.toContain(SECRET);
    // The registry file holds the reference, never the value.
    const personal = join(w.home, '.deckent', 'mcp.json');
    expect(existsSync(personal) && readFileSync(personal, 'utf8')).toContain('$DECK:GH'); expect(readFileSync(personal, 'utf8')).not.toContain(SECRET);
    // Raw replies bypass the fixture server's codec: an invalid wide union must fail at the client's gate, never its result codec.
    let rewrite: { method: string; result: unknown } | null = null;
    const hostile = await startMcpHttpFixture(async (message: { id: number; method: string }, response: Response) => {
      if (!rewrite || message?.method !== rewrite.method) return response;
      await response.body?.cancel();
      return Response.json({ jsonrpc: '2.0', id: message.id, result: { resultType: 'complete', ...rewrite.result as Record<string, unknown> } });
    }) as HttpFixture;
    closers.push(() => hostile.close());
    const live = settings.servers[0]!, nested = (depth: number) => { let value: unknown = false; for (let i = 2; i < depth; i++) value = { child: value }; return value; };
    for (const [method, result, accepted] of [
      ['tools/list', { tools: [], ttlMs: 0, cacheScope: 'private', padding: Array(4_086).fill(false) }, true], // 9 nodes with modern resultType/cache fields + 4086 = 4095.
      ['tools/list', { tools: [], ttlMs: 0, cacheScope: 'private', padding: Array(4_087).fill(false) }, false],
      ['tools/call', { content: [{ type: 'text', text: 'bounded' }], padding: Array(4_085).fill(false) }, true], // 10 + 4085 = 4095.
      ['tools/call', { content: [{ type: 'text', text: 'bounded' }], padding: Array(4_086).fill(false) }, false],
      ['tools/call', { content: Array(4_096).fill({ type: 'invalid', text: false }) }, false],
      ['tools/call', { content: [], padding: nested(32) }, true],
      ['tools/call', { content: [], padding: nested(33) }, false],
      ['server/discover', { padding: Array(4_096).fill(false) }, false],
    ] as const) {
      rewrite = method === 'server/discover' ? { method, result } : null;
      const guarded = new McpClientPool(new AbortController().signal); closers.push(() => guarded.close());
      const target = { ...live, url: hostile.url }, cfg = { ...settings, servers: [target] };
      const opened = await guarded.open(target, cfg, { cwd: w.project, environment: w.env, sandboxes: [] });
      if (method === 'server/discover') { expect(opened).toMatchObject({ ok: false, reason: 'start-failed', detail: 'MCP_INPUT_LIMIT' }); continue; }
      expect(opened).toMatchObject({ ok: true }); rewrite = { method, result };
      const before = hostile.requests.length;
      if (method === 'tools/list') expect(await guarded.open(target, cfg, { cwd: w.project, environment: w.env, sandboxes: [] }), JSON.stringify({ method, accepted }))
        .toMatchObject(accepted ? { ok: true } : { ok: false, reason: 'list-failed', detail: 'MCP_INPUT_LIMIT' });
      else expect(await guarded.call(target.id, 'whoami', whoami.digest, {}, { timeoutMs: 3_000, signal: new AbortController().signal }))
        .toMatchObject(accepted ? { outcome: 'answered' } : { outcome: 'unknown' });
      expect(hostile.requests.length - before).toBe(1); await guarded.close();
    }
  }, 60_000);

  // KER-17 (owner GO 2026-10-28, LAW-AUDIT-KER17): a personal-file `$DECK:` key resolves under the project's grant. A trusted server whose key loses
  // the grant (RED) is retired before its next call, offers nothing and says which key and command; granted again (GREEN) it starts.
  it('NEGATIVE: a revoked $DECK grant retires the running server before its next call and names the key; a grant brings it back', async () => {
    const server = await fixture(), w = await workspace(); let granted: boolean | 'missing' = true, pending = false, missingKey = 'GH';
    const context: McpCommandContext = { ...w.context, secret: async name => { if (granted === 'missing' && name === missingKey) return undefined; if (!granted) throw Object.assign(new Error('refused'), { code: 'SECRET_GRANT_REQUIRED' }); return name === 'GH' ? SECRET : 'auxiliary-fixture'; } };
    await runMcpCommand({ verb: 'add', scope: 'local', name: 'web-docs', entry: { type: 'http', url: server.url, headers: { Authorization: 'Bearer $DECK:GH', 'X-Aux': '$DECK:AUX' } } }, context);
    const pool = new McpClientPool(new AbortController().signal); closers.push(() => pool.close());
    const view = pool.scoped({ scopeId: 'scope', cwd: w.project }), signal = new AbortController().signal;
    const open = () => openTurnMcp({ registry: context, pool: view, cwd: w.project, sandboxes: [], principal: { id: 'p', issuer: 'test', subject: 'owner' }, sqlite: {} as never, keyFile: '',
      requestTtlMs: 1_000, inputMaxBytes: 65_536, resultMaxBytes: 65_536, scopeId: 'scope', turnId: 'turn', sessionId: 'http-notice-session', signal, emit: () => undefined, ledgerPath: async () => '',
      requestPolicy: async () => { if (pending) return { revision: 'p', trustFacts: agentToolApprovalFacts(null, 'scope', null) }; throw new Error('no card expected'); }, describeNotice: notice => notice.kind === 'not-decided' ? renderMcpStartNotice(notice, 'en') : JSON.stringify(notice) });
    const before = await open(), whoami = [...before.offered.values()].find(entry => entry.tool === 'whoami')!;
    expect(await view.call(whoami.server, 'whoami', whoami.digest, {}, { timeoutMs: 10_000, signal })).toMatchObject({ outcome: 'answered' });
    granted = false;
    const after = await open();
    expect(after.offered.size).toBe(0); expect(after.notices).toEqual([JSON.stringify({ kind: 'secret-refused', name: 'web-docs', code: 'SECRET_GRANT_REQUIRED', key: 'GH', scope: 'scope' })]);
    expect(await view.call(whoami.server, 'whoami', whoami.digest, {}, { timeoutMs: 10_000, signal })).toMatchObject({ outcome: 'refused', reason: 'not-connected' });
    expect(await runMcpCommand({ verb: 'list' }, context)).toMatchObject({ servers: [{ name: 'web-docs', status: 'invalid-launch', reason: 'secret-refused:SECRET_GRANT_REQUIRED:GH' }] });
    expect((await open()).notices).toEqual([]); // Same refusal, even in a later turn, says nothing twice.
    granted = true;
    expect((await open()).offered.size).toBe(2);
    granted = 'missing';
    const missing = await open(); expect(missing.offered.size).toBe(0); expect(missing.notices.join('')).toContain('deckent secret set GH --main');
    expect((await runMcpCommand({ verb: 'get', name: 'web-docs' }, { ...context, describeNotice: notice => renderMcpStartNotice(notice, 'en') }) as { server: { lastStart: { text: string } } }).server.lastStart.text).toContain('deckent secret set GH --main');
    expect((await open()).notices).toEqual([]);
    // Same server definition and code: changing only the unresolved key (detail) must notify, including a change back.
    for (const key of ['AUX', 'GH']) {
      missingKey = key;
      expect((await open()).notices).toEqual([renderMcpStartNotice({ kind: 'not-decided', name: 'web-docs', code: 'secret-unresolved', detail: key }, 'en')]);
      expect((await open()).notices).toEqual([]);
    }
    const path = join(productResourcePath(w.layout, 'integrations'), 'mcp-start-failures.json'), stored = JSON.parse(readFileSync(path, 'utf8'));
    expect(stored.failures[0].clientIdentity).toBe(MCP_CLIENT_IDENTITY);
    stored.failures[0].clientIdentity = '0'.repeat(64); writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
    expect((await open()).notices).toHaveLength(1); expect((await open()).notices).toEqual([]);
    granted = true; expect((await open()).offered.size).toBe(2);
    pending = true;
    writeFileSync(join(w.project, '.deckent', 'mcp.json'), JSON.stringify({ mcpServers: { invalid: { command: '${MISSING_COMMAND}' } } }));
    const undecided = await open(); expect(undecided.notices.join('')).toContain('MCP_SERVER_ENTRY_INVALID');
    expect((await open()).notices).toEqual([]);
    const failures = JSON.parse(readFileSync(path, 'utf8')).failures;
    expect(failures).toContainEqual(expect.objectContaining({ name: 'invalid', phase: 'decision', code: 'MCP_SERVER_ENTRY_INVALID' }));
  }, 60_000);

  it('a project file cannot carry a secret reference to an HTTP server; plain http to a remote host is refused at add; a literal header value is masked in get', async () => {
    const server = await fixture(), w = await workspace();
    await w.run({ verb: 'add', scope: 'project', name: 'shared', entry: { type: 'http', url: server.url, headers: { Authorization: 'Bearer $DECK:GH' } } });
    expect(await w.run({ verb: 'list', health: false })).toMatchObject({ servers: [{ name: 'shared', status: 'pending-approval' }] });
    await expect(w.run({ verb: 'approve', name: 'shared', alwaysAsk: [] })).rejects.toMatchObject({ code: 'MCP_SERVER_ENTRY_INVALID' });
    expect(server.requests).toEqual([]);
    await expect(w.run({ verb: 'add', scope: 'local', name: 'plain', entry: { type: 'http', url: 'http://mcp.example.com/mcp' } }))
      .rejects.toMatchObject({ code: 'MCP_SERVER_ENTRY_INVALID' });
    await w.run({ verb: 'add', scope: 'local', name: 'literal', approve: false, entry: { type: 'http', url: server.url, headers: { 'X-Api-Key': 'literal-key-value', 'X-Ref': '${REF}' } } });
    const got = JSON.stringify(await w.run({ verb: 'get', name: 'literal' }));
    expect(got).not.toContain('literal-key-value'); expect(got).toContain('"X-Api-Key":"<set>"'); expect(got).toContain('"X-Ref":"${REF}"');
  }, 60_000);

  it('the CLI adds an HTTP server from a URL with --header (Claude Code syntax); --transport sse is a usage error', async () => {
    const w = await workspace(), seen: unknown[] = [];
    const context = { root: w.project, env: w.env, stdout: { write: () => true }, runMcpCommand: async (_root: string, request: unknown) => { seen.push(request); return {}; } } as unknown as CommandContext;
    await mcpCommand(['mcp', 'add', '--transport', 'http', '--no-approve', '--header', 'Authorization: Bearer $DECK:GH', '-H', 'X-Region:eu', 'web', 'https://mcp.example.com/mcp'], context);
    await mcpCommand(['mcp', 'add', '--no-approve', 'web2', 'https://mcp.example.com/mcp'], context);
    expect(seen).toEqual([{ verb: 'add', scope: 'local', name: 'web', approve: false, entry: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer $DECK:GH', 'X-Region': 'eu' } } },
      { verb: 'add', scope: 'local', name: 'web2', approve: false, entry: { type: 'http', url: 'https://mcp.example.com/mcp' } }]);
    await expect(mcpCommand(['mcp', 'add', '--transport', 'sse', 'web', 'https://x'], context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
    await expect(mcpCommand(['mcp', 'add', '--header', 'A: b', 'web', '--', 'node', 'srv.js'], context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  });
});

it('Astra D11-R1: every project-vault refusal keeps its own kind through stdio env and HTTP headers (never collapsed into "not granted")', async () => {
  for (const code of ['SECRET_GRANT_REQUIRED', 'SECRET_PROJECT_MISSING', 'DECK_DECLARATION_REQUIRED', 'SECRET_PROJECT_IDENTITY_REQUIRED']) {
    const secret = async () => { throw Object.assign(new Error('refused'), { code }); };
    const stdio = await expandMcpEntry({ command: 'server', env: { TOKEN: '$DECK:KEY' } } as never, 'user', {}, secret);
    const http = await expandMcpEntry({ type: 'http', url: 'https://mcp.example/v1', headers: { authorization: 'Bearer $DECK:KEY' } } as never, 'user', {}, secret);
    expect([stdio, http]).toEqual([{ ok: false, reason: `secret-refused:${code}:KEY` }, { ok: false, reason: `secret-refused:${code}:KEY` }]);
  }
  expect(await expandMcpEntry({ command: 'server', env: { TOKEN: '$DECK:KEY' } } as never, 'user', {}, async () => undefined)).toEqual({ ok: false, reason: 'secret-unresolved:KEY' });
});
