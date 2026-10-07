import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeMcpApproval, describeMcpResult, describeMcpTrustCard, expandMcpEntry, loadMcpRegistry, mcpClientSettings, McpClientPool, mcpEndpointRefusal, mcpTurnTools,
  openMcpAgentTools, resolveMcpRegistry, runMcpCommand, type McpCommandContext, type McpCommandRequest, type McpTrustCard } from '#adapters/index.js';
import { clearConfigCache, loadConfig } from '#platform/index.js';
import { mcpCommand, type CommandContext } from '#surfaces/core/cli/index.js';
// @ts-expect-error -- a plain ESM test fixture (no declaration file)
import { startMcpHttpFixture } from '../../fixtures/mcp-http-server.mjs';

// L1 MCP-CORE item 1 (TUI3 2026-10-07): Streamable HTTP servers (MCP 2026-07-28: stdio and Streamable HTTP are the standard transports, no protocol
// session; SDK @modelcontextprotocol/client 2.2.0 `StreamableHTTPClientTransport`). A `$DECK:` reference in a header resolves only for a personal
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
    const view = await loadMcpRegistry(w.context), settings = mcpClientSettings(view, {})!, pool = new McpClientPool(new AbortController().signal); closers.push(() => pool.close());
    const offered = await openMcpAgentTools(pool, settings, { cwd: w.project, environment: w.env, sandboxes: [] });
    const whoami = [...offered.values()].find(entry => entry.tool === 'whoami')!;
    const answer = await pool.call(whoami.server, 'whoami', whoami.digest, {}, { timeoutMs: 10_000, signal: new AbortController().signal });
    expect(answer).toMatchObject({ outcome: 'answered' });
    const model = describeMcpResult(answer, whoami.display, 4_096, whoami);
    expect(model.text).toContain('called with: Bearer '); expect(model.text).not.toContain(SECRET);
    const preview = mcpTurnTools(offered).preview(whoami.spec.name, {});
    expect(preview).toContain(server.url);
    for (const shown of [JSON.stringify(listed), JSON.stringify(got), JSON.stringify(w.audits), w.cards.map(describeMcpTrustCard).join('\n'), preview!, model.text,
      describeMcpApproval({ ...whoami, args: {} })]) expect(shown).not.toContain(SECRET);
    // The registry file holds the reference, never the value.
    const personal = join(w.home, '.deckent', 'mcp.json');
    expect(existsSync(personal) && readFileSync(personal, 'utf8')).toContain('$DECK:GH'); expect(readFileSync(personal, 'utf8')).not.toContain(SECRET);
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
