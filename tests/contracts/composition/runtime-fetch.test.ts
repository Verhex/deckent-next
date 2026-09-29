import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTurnStreamEvent } from '#domain/index.js';
import { agentToolArgumentsDigest } from '#engine/index.js';
import { scratchSessionKey } from '#adapters/index.js';
import { me, principal, runtime } from '../support/chat-turn-harness.js';
import { startFetchFixture, type FetchFixture } from '../support/fetch-fixture.js';

// FETCH S7 + S10 (owner 2026-09-28): `fetch_url` through the real runtime service, real policy file and ledger, and a real local TLS
// server reached through the test-only transport (the service's public-address check stays in force).
const roots: string[] = [], fixtures: FetchFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function tlsFixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-fetch-turn-')); roots.push(root);
  const started = await startFetchFixture(root); fixtures.push(started); return started;
}
const MiB = 1024 * 1024;
type Effect = 'allow' | 'require-approval' | 'deny';
const fetchGrants = (tool: Effect = 'allow', operation: Effect = 'allow') => [
  { id: 'fetch-tool', effect: tool, actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['fetch_url'] } },
  { id: 'fetch-operation', effect: operation, actions: ['execute'], scopes: ['scope'], principals: me, resource: { kind: 'operation', ids: ['network.fetch'] } },
  { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'], principals: me, resource: { kind: 'approval', ids: 'all' } }];
const fetchSection = (egress: 'none' | 'allowlist' | 'approval', extra: Record<string, unknown> = {}) =>
  ({ schemaVersion: 1, egress, allowedHosts: ['docs.example'], timeoutMs: 5_000, ...extra });
const call = (name: string, args: Record<string, unknown>) => ({ toolCall: { name, arguments: JSON.stringify(args) } });
const turn = (turnId: string, content = 'look it up') => ({ schemaVersion: 1 as const, scopeId: 'scope', turnId, sessionId: 'session-f',
  messages: [{ role: 'user' as const, content }] });
const toolTexts = (events: AgentTurnStreamEvent[]) => events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : []);
const finished = (events: AgentTurnStreamEvent[]) => events.flatMap(event => event.kind === 'tool.finished' ? [[event.name, event.status]] : []);
const requested = (events: AgentTurnStreamEvent[]) => events.filter(event => event.kind === 'approval.requested');
const areaOf = (data: string, turnId: string) => join(data, 'state', 'scratch',
  scratchSessionKey({ scopeId: 'scope', principal: { issuer: principal.issuer, subject: principal.subject }, turnId, sessionId: 'session-f' }));
const systemOf = (request: Record<string, unknown>) => (request['messages'] as { role: string; content: string }[])[0]!.content;
const toolNames = (request: Record<string, unknown>) => ((request['tools'] ?? []) as { function: { name: string } }[]).map(tool => tool.function.name);
type Harness = Awaited<ReturnType<typeof runtime>>;
async function answered(f: Harness, turnId: string, decision: 'allow' | 'deny' | null) {
  const client = f.client(), events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
  const result = await client.chatTurn(turn(turnId), event => {
    events.push(event);
    if (event.kind === 'approval.requested' && decision) pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId,
      commandId: `decide-${event.approvalId}`, expectedRevision: event.revision, decision, reason: 'owner' }));
  });
  await Promise.all(pending);
  return { result, events };
}

describe.skipIf(process.platform !== 'linux')('fetch_url through the runtime service (FETCH S7)', () => {
  it('an allowlisted host runs without a card: one real HTTPS GET, the body lands in the scratch area, the model gets a redacted head', async () => {
    const t = await tlsFixture();
    t.routes.set('/guide', (_request, response) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end('<h1>Guide</h1>\napi_key=abcdef0123456789\nend'));
    const f = await runtime({ extraGrants: fetchGrants(), fetch: fetchSection('approval'), fetchTransport: t.transport }); await f.start();
    f.state.script = [call('fetch_url', { url: 'https://docs.example/guide' }), { content: 'Read it.' }];
    const { result, events } = await answered(f, 'turn-listed', null);
    expect(result).toMatchObject({ finish: 'stop', toolCalls: 1 });
    expect(requested(events)).toHaveLength(0);
    expect(finished(events)).toEqual([['fetch_url', 'ok']]);
    expect(t.seen).toMatchObject([{ host: 'docs.example', sni: 'docs.example', path: '/guide' }]);
    const body = '<h1>Guide</h1>\napi_key=abcdef0123456789\nend', name = `${createHash('sha256').update(body).digest('hex')}.html`;
    const stored = join(areaOf(f.data, 'turn-listed'), 'fetch', name);
    expect(await readFile(stored, 'utf8')).toBe(body);
    expect((await stat(stored)).mode & 0o777).toBe(0o600);
    const [text] = toolTexts(events);
    expect(text).toContain('status=200'); expect(text).toContain('content-type=text/html; charset=utf-8'); expect(text).toContain(`bytes=${body.length}`);
    expect(text).toContain(stored); expect(text).toContain(`fetch/${name}`);
    expect(text).toContain('<h1>Guide</h1>'); expect(text).not.toContain('abcdef0123456789'); expect(text).toContain('[REDACTED]');
    // One C11 effect of the Core network operation, settled; the model learned the tool from the system prompt v3.
    expect(f.rows('SELECT target_kind, state FROM effect_intents')).toEqual([{ target_kind: 'network-fetch', state: 'settled' }]);
    const system = systemOf(f.state.requests[0]!);
    expect(system.startsWith('[Deckent runtime instructions v5]')).toBe(true);
    expect(system).toContain('fetch_url'); expect(system).toContain('docs.example');
    expect(toolNames(f.state.requests[0]!)).toContain('fetch_url');
  }, 60_000);

  it('a host outside the allowlist asks the owner (full URL, digest-bound); deny sends nothing, allow sends exactly that URL once', async () => {
    const t = await tlsFixture();
    const long = `https://other.example/${'segment/'.repeat(30)}end?q=1`;
    t.routes.set(new URL(long).pathname + new URL(long).search, (_request, response) => response.writeHead(200, { 'content-type': 'text/plain' }).end('other'));
    const f = await runtime({ extraGrants: fetchGrants(), fetch: fetchSection('approval'), fetchTransport: t.transport }); await f.start();
    f.state.script = [call('fetch_url', { url: long }), { content: 'Denied.' }, call('fetch_url', { url: long }), { content: 'Fetched.' }];
    const denied = await answered(f, 'turn-deny', 'deny');
    expect(finished(denied.events)).toEqual([['fetch_url', 'denied']]);
    expect(t.dialed).toEqual([]); expect(t.resolved).toEqual([]);
    const [card] = requested(denied.events);
    expect(card?.kind === 'approval.requested' && card.preview).toContain(long);
    const digest = agentToolArgumentsDigest('fetch_url', { url: long });
    expect(card?.kind === 'approval.requested' && card.summary).toBe(`fetch_url · ${long.slice(0, 199)}… · ${digest.slice(0, 12)}`);
    // The stored approval names the URL (cut at 200 characters) and binds the whole call through the arguments digest.
    const subjects = f.rows(`SELECT snapshot FROM approvals WHERE subject_kind = 'agent-tool-call'`)
      .map(row => (JSON.parse(String((row as { snapshot: string }).snapshot)) as { request: { subject: Record<string, unknown> } }).request.subject);
    expect(subjects).toEqual([expect.objectContaining({ tool: 'fetch_url', resource: `${long.slice(0, 199)}…`, argsDigest: digest })]);

    const allowed = await answered(f, 'turn-allow', 'allow');
    expect(finished(allowed.events)).toEqual([['fetch_url', 'ok']]);
    expect(t.seen.map(row => `${row.host}${row.path}`)).toEqual([`other.example${new URL(long).pathname}${new URL(long).search}`]);
    expect(f.rows('SELECT state FROM effect_intents')).toEqual([{ state: 'settled' }]);
  }, 60_000);

  it('allowlist egress refuses a host outside the list before any card or lookup; http: is refused the same way', async () => {
    const t = await tlsFixture();
    const f = await runtime({ extraGrants: fetchGrants(), fetch: fetchSection('allowlist'), fetchTransport: t.transport }); await f.start();
    f.state.script = [call('fetch_url', { url: 'https://other.example/x' }), call('fetch_url', { url: 'http://docs.example/x' }), { content: 'No.' }];
    const { events } = await answered(f, 'turn-allowlist', 'allow');
    expect(requested(events)).toHaveLength(0);
    const [outside, plain] = toolTexts(events);
    expect(outside).toContain('error=host-not-allowed'); expect(plain).toContain('error=not-https');
    expect(t.resolved).toEqual([]); expect(t.dialed).toEqual([]);
    expect(f.rows('SELECT state FROM effect_intents')).toEqual([]);
  }, 60_000);

  it('a private answer is refused by the service (nothing dialed, effect refused); a 5 MiB body is kept cut at 4 MiB', async () => {
    const t = await tlsFixture();
    t.answers.set('mirror.example', ['10.0.0.7']);
    t.routes.set('/big', (_request, response) => { response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(Buffer.alloc(5 * MiB, 0x62)); });
    const f = await runtime({ extraGrants: fetchGrants(), fetch: fetchSection('approval', { allowedHosts: ['docs.example', 'mirror.example'] }),
      fetchTransport: t.transport }); await f.start();
    f.state.script = [call('fetch_url', { url: 'https://mirror.example/x' }), call('fetch_url', { url: 'https://docs.example/big' }), { content: 'Done.' }];
    const { events } = await answered(f, 'turn-private', null);
    const [privateText, bigText] = toolTexts(events);
    expect(privateText).toContain('error=address-not-public'); expect(privateText).toContain('nothing was sent');
    expect(t.dialed).toEqual(['93.184.215.14']);
    expect(bigText).toContain(`bytes=${4 * MiB}`); expect(bigText).toContain('truncated=true'); expect(bigText).toContain('binary content is not shown');
    const files = await readdir(join(areaOf(f.data, 'turn-private'), 'fetch'));
    expect(files).toHaveLength(1); expect(files[0]).toMatch(/^[0-9a-f]{64}\.bin$/u);
    expect((await stat(join(areaOf(f.data, 'turn-private'), 'fetch', files[0]!))).size).toBe(4 * MiB);
    expect(f.rows('SELECT state FROM effect_intents ORDER BY rowid')).toEqual([{ state: 'refused' }, { state: 'settled' }]);
  }, 60_000);

  it('a redirect outside the allowlist stops the fetch; a timeout is unknown and replaying the turn sends nothing again', async () => {
    const t = await tlsFixture();
    t.routes.set('docs.example/moved', (_request, response) => response.writeHead(302, { location: 'https://other.example/elsewhere' }).end());
    t.routes.set('docs.example/slow', (_request, response) => { response.writeHead(200, { 'content-type': 'text/plain' }); response.write('partial'); });
    const f = await runtime({ extraGrants: fetchGrants(), fetch: fetchSection('approval', { timeoutMs: 1_000 }), fetchTransport: t.transport }); await f.start();
    f.state.script = [call('fetch_url', { url: 'https://docs.example/moved' }), call('fetch_url', { url: 'https://docs.example/slow' }), { content: 'Hm.' }];
    const { events } = await answered(f, 'turn-edge', null);
    const [moved, slow] = toolTexts(events);
    expect(moved).toContain('error=redirect-refused'); expect(moved).toContain('https://other.example/elsewhere');
    expect(slow).toContain('error=timed-out'); expect(slow).toContain('unknown');
    expect(t.resolved).not.toContain('other.example');
    expect(f.rows('SELECT state FROM effect_intents ORDER BY rowid')).toEqual([{ state: 'settled' }, { state: 'unknown' }]);
    const connections = t.connections();
    const replay = await f.client().chatTurn(turn('turn-edge'), () => undefined);
    expect(replay.replayed).toBe(true);
    expect(t.connections()).toBe(connections);
  }, 60_000);

  it('egress none (the default): no fetch tool is declared, the prompt says there is no network access, and a call is an unknown tool', async () => {
    const t = await tlsFixture();
    const f = await runtime({ extraGrants: fetchGrants(), fetchTransport: t.transport }); await f.start();
    f.state.script = [call('fetch_url', { url: 'https://docs.example/x' }), { content: 'Offline.' }];
    const { events, result } = await answered(f, 'turn-none', null);
    expect(toolNames(f.state.requests[0]!)).not.toContain('fetch_url');
    expect(systemOf(f.state.requests[0]!)).toContain('Network access: none');
    // The provider adapter refuses a call to an undeclared tool: the round ends, nothing runs.
    expect(result).toMatchObject({ finish: 'error', toolCalls: 0 }); expect(result.note).toContain('no tool call ran');
    expect(finished(events)).toEqual([]);
    expect(t.resolved).toEqual([]); expect(t.dialed).toEqual([]);
  }, 60_000);
});

describe.skipIf(process.platform !== 'linux')('company policy narrows the agent workspace (FETCH S10)', () => {
  it('a company deny on fetch_url or on network.fetch answers POLICY_DENIED and never reaches the network, even for an allowlisted host', async () => {
    const t = await tlsFixture();
    for (const [tool, operation] of [['deny', 'allow'], ['allow', 'deny']] as const) {
      const f = await runtime({ extraGrants: fetchGrants(tool, operation), fetch: fetchSection('approval'), fetchTransport: t.transport }); await f.start();
      f.state.script = [call('fetch_url', { url: 'https://docs.example/x' }), { content: 'Denied.' }];
      const { events } = await answered(f, `turn-deny-${tool}`, 'allow');
      expect(finished(events)).toEqual([['fetch_url', 'denied']]);
      expect(toolTexts(events)[0]).toContain('error=denied-by-policy');
      expect(requested(events)).toHaveLength(0);
    }
    expect(t.resolved).toEqual([]); expect(t.dialed).toEqual([]);
  }, 60_000);

  it('require-approval on fetch_url asks even for an allowlisted host (no permission mode lowers a fetch)', async () => {
    const t = await tlsFixture();
    t.routes.set('/x', (_request, response) => response.writeHead(200, { 'content-type': 'text/plain' }).end('ok'));
    const f = await runtime({ extraGrants: fetchGrants('require-approval'), fetch: fetchSection('approval'), fetchTransport: t.transport }); await f.start();
    f.state.script = [call('fetch_url', { url: 'https://docs.example/x' }), { content: 'Asked.' }];
    const { events } = await answered(f, 'turn-ask', 'allow');
    expect(requested(events)).toHaveLength(1);
    expect(finished(events)).toEqual([['fetch_url', 'ok']]);
  }, 60_000);

  it('scratch_write under company require-approval asks; under deny it is refused', async () => {
    const scratchGrants = (effect: Effect) => [{ id: 'scratch-tools', effect, actions: ['invoke'], scopes: ['scope'], principals: me,
      resource: { kind: 'agent-tool', ids: ['scratch_write'] } }, { id: 'scratch-op', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: me,
      resource: { kind: 'operation', ids: ['workspace.scratch.write'] } }, { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'],
      principals: me, resource: { kind: 'approval', ids: 'all' } }];
    const asked = await runtime({ extraGrants: scratchGrants('require-approval') }); await asked.start();
    asked.state.script = [call('scratch_write', { path: 'n.md', content: 'n\n' }), { content: 'Ok.' }];
    const first = await answered(asked, 'turn-scratch-ask', 'allow');
    expect(requested(first.events)).toHaveLength(1); expect(finished(first.events)).toEqual([['scratch_write', 'ok']]);
    const denied = await runtime({ extraGrants: scratchGrants('deny') }); await denied.start();
    denied.state.script = [call('scratch_write', { path: 'n.md', content: 'n\n' }), { content: 'No.' }];
    const second = await answered(denied, 'turn-scratch-deny', 'allow');
    expect(requested(second.events)).toHaveLength(0); expect(finished(second.events)).toEqual([['scratch_write', 'denied']]);
  }, 60_000);

  it('an air-gapped configuration (egress none, sandbox required, scratch local) offers no network and no shell run, and says so', async () => {
    const t = await tlsFixture();
    const shellGrants = [{ id: 'shell-tool', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['run_shell'] } },
      { id: 'shell-op', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: me, resource: { kind: 'operation', ids: ['host.shell.run'] } }];
    const f = await runtime({ extraGrants: [...fetchGrants(), ...shellGrants], fetch: fetchSection('none'), shell: { schemaVersion: 1, realm: 'require-sandbox' }, sandboxes: () => [],
      scratch: { schemaVersion: 1, retentionDays: 1 }, fetchTransport: t.transport }); await f.start();
    f.state.script = [call('run_shell', { command: 'curl https://docs.example/x' }), { content: 'Offline.' }, call('fetch_url', { url: 'https://docs.example/x' })];
    const shell = await answered(f, 'turn-airgap', 'allow');
    expect(toolNames(f.state.requests[0]!)).not.toContain('fetch_url');
    expect(systemOf(f.state.requests[0]!)).toContain('Network access: none');
    expect(requested(shell.events)).toHaveLength(0);
    expect(toolTexts(shell.events)[0]).toContain('SHELL_SANDBOX_UNAVAILABLE');
    const fetched = await answered(f, 'turn-airgap-fetch', 'allow');
    expect(fetched.result).toMatchObject({ finish: 'error', toolCalls: 0 });
    expect(t.resolved).toEqual([]); expect(t.dialed).toEqual([]);
  }, 60_000);
});
