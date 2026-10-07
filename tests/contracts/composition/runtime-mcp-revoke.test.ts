import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTurnStreamEvent } from '#domain/index.js';
import { runConfiguredMcpCommand } from '#composition/core/agent-turn/index.js';
import { me, runtime } from '../support/chat-turn-harness.js';

// MCP-REVOKE (Astra 2174/2175/2176, common P1): a one-shot approval of a tool call is not the server's trust. While a call waits at its card,
// `reset`, `remove` or a changed definition withdraws that trust; the stale card's allow then sends nothing (the server's own log is the
// evidence), the effect is refused before send in the ledger, and the revoked server's process does not keep serving. Trust granted again
// (new cards) works on a new turn. Real runtime service, socket, approval journal, ledger and a real local MCP server.
const FIXTURE = resolve('tests/fixtures/mcp-stdio-server.mjs');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const echo = { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deckent-mcp-revoke-')); roots.push(root);
  const toolsFile = join(root, 'tools.json'), logFile = join(root, 'log.jsonl');
  writeFileSync(toolsFile, JSON.stringify([echo])); appendFileSync(logFile, '');
  const events = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { event: string; name?: string; pid: number });
  const entry = (extra: string[] = []) => ({ command: process.execPath, args: [FIXTURE, '--mode', 'dual', '--tools', toolsFile, '--log', logFile, ...extra], realm: 'host' });
  return { calls: () => events().filter(event => event.event === 'call'), starts: () => events().filter(event => event.event === 'start').map(event => event.pid), entry,
    setTools: (tools: unknown[]) => writeFileSync(toolsFile, JSON.stringify(tools)) };
}
const grants = [
  { id: 'mcp-tool', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'mcp-server', ids: ['fx'] } },
  { id: 'mcp-op', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: me, resource: { kind: 'operation', ids: ['mcp.tool.call'] } },
  { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'], principals: me, resource: { kind: 'approval', ids: 'all' } }];
const writeRegistry = (project: string, entry: unknown) => {
  mkdirSync(join(project, '.deckent'), { recursive: true }); writeFileSync(join(project, '.deckent', 'mcp.json'), JSON.stringify({ mcpServers: { fx: entry } }));
};
type Harness = Awaited<ReturnType<typeof runtime>>;
const command = (f: Harness, request: Parameters<typeof runConfiguredMcpCommand>[1]) => runConfiguredMcpCommand(f.project, request, { env: f.env }, async () => true);
const approve = (f: Harness) => command(f, { verb: 'approve', name: 'fx', alwaysAsk: [] });

/** One turn calling `mcp__fx__echo`; `meanwhile` runs while its card waits (after the card is shown, before the owner's allow). */
async function turn(f: Harness, turnId: string, meanwhile: () => Promise<unknown> = async () => undefined, decision: 'allow' | 'deny' = 'allow') {
  // The scripted model answers by request index across the service's life: this turn's two steps follow every earlier request.
  f.state.script = [...f.state.requests.map(() => ({ content: 'earlier' })), { toolCall: { name: 'mcp__fx__echo', arguments: JSON.stringify({ text: turnId }) } }, { content: 'Done.' }];
  const client = f.client(), events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
  const result = await client.chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId, sessionId: 'session-m', messages: [{ role: 'user', content: 'use' }] }, event => {
    events.push(event);
    if (event.kind === 'approval.requested') pending.push((async () => {
      await meanwhile();
      await client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability, commandId: `allow-${event.approvalId}`,
        expectedRevision: event.revision, decision, reason: 'stale card' });
    })());
  });
  await Promise.all(pending);
  const tool = events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : []);
  const finished = events.flatMap(event => event.kind === 'tool.finished' ? [[event.name, event.status]] : []);
  return { result, tool, finished, cards: events.filter(event => event.kind === 'approval.requested').length };
}
const effects = (f: Harness) => f.rows("SELECT target_kind, state, json_extract(record, '$.refusal') AS refusal FROM effect_intents ORDER BY rowid");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean, ms = 5_000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 50)); return check(); };

describe.skipIf(process.platform !== 'linux')('a stale MCP tool card after the server\'s trust is withdrawn (MCP-REVOKE)', () => {
  it('positive control: a trusted server\'s call allowed at its card is sent once and settles', async () => {
    const m = fixture(), f = await runtime({ extraGrants: grants }); await f.start();
    writeRegistry(f.project, m.entry()); await approve(f);
    const run = await turn(f, 'plain');
    expect(m.calls()).toHaveLength(1);
    expect(run.finished).toEqual([['mcp__fx__echo', 'ok']]);
    expect(effects(f)).toEqual([{ target_kind: 'mcp-tool', state: 'settled', refusal: null }]);
  }, 60_000);

  it('reset while the card waits: nothing is sent, the effect is refused before send, the process stops; trust granted again works on a new turn', async () => {
    const m = fixture(), f = await runtime({ extraGrants: grants }); await f.start();
    writeRegistry(f.project, m.entry()); await approve(f);
    const before = m.starts().length;
    let status: unknown;
    const stale = await turn(f, 'reset', async () => { await command(f, { verb: 'reset', name: 'fx' }); status = await command(f, { verb: 'get', name: 'fx' }); });
    expect(status).toMatchObject({ server: { status: 'pending-approval', trust: null, pinnedTools: 0 } });
    expect(m.calls()).toEqual([]);
    expect(stale.finished).toEqual([['mcp__fx__echo', 'error']]);
    expect(stale.tool.join('\n')).toContain('error=trust-revoked; nothing was sent');
    expect(effects(f)).toEqual([{ target_kind: 'mcp-tool', state: 'refused', refusal: 'EFFECT_REJECTED' }]);
    // The service's process of the revoked server (the one started for this turn) does not keep running.
    // (A stdio start may add the SDK's short-lived version probe: every process started for this turn is checked.)
    const served = m.starts().slice(before);
    expect(served.length).toBeGreaterThan(0);
    expect(await until(() => served.every(pid => !alive(pid)))).toBe(true);
    // Trust granted again (new cards) → a new turn's call is sent once, on a freshly started process.
    await approve(f);
    const again = await turn(f, 'regranted');
    expect(again.finished).toEqual([['mcp__fx__echo', 'ok']]);
    expect(m.calls()).toHaveLength(1);
    expect(served).not.toContain(m.calls()[0]!.pid);
    expect(effects(f).map(row => (row as { state: string }).state)).toEqual(['refused', 'settled']);
  }, 60_000);

  it('reset with no call waiting: the next turn stops the service\'s process of the untrusted server before its cards; a no starts nothing', async () => {
    const m = fixture(), f = await runtime({ extraGrants: grants }); await f.start();
    writeRegistry(f.project, m.entry()); await approve(f);
    const before = m.starts().length;
    expect((await turn(f, 'first')).finished).toEqual([['mcp__fx__echo', 'ok']]);
    const served = m.starts().slice(before);
    await command(f, { verb: 'reset', name: 'fx' });
    const next = m.starts().length;
    const declined = await turn(f, 'declined', async () => undefined, 'deny');
    expect(declined.cards).toBe(1);
    expect(m.starts().length).toBe(next);
    expect(await until(() => served.every(pid => !alive(pid)))).toBe(true);
    expect(m.calls()).toHaveLength(1);
  }, 60_000);

  it('remove while the card waits: nothing is sent and the effect is refused before send', async () => {
    const m = fixture(), f = await runtime({ extraGrants: grants }); await f.start();
    writeRegistry(f.project, m.entry()); await approve(f);
    const stale = await turn(f, 'remove', () => command(f, { verb: 'remove', name: 'fx' }));
    expect(m.calls()).toEqual([]);
    expect(stale.tool.join('\n')).toContain('error=trust-revoked; nothing was sent');
    expect(effects(f)).toEqual([{ target_kind: 'mcp-tool', state: 'refused', refusal: 'EFFECT_REJECTED' }]);
  }, 60_000);

  it('a user-scope server (trust in the global root) reset while the card waits: nothing is sent', async () => {
    const m = fixture(), f = await runtime({ extraGrants: grants }); await f.start();
    expect(await command(f, { verb: 'add', scope: 'user', name: 'fx', entry: m.entry() })).toMatchObject({ trust: 'trusted' });
    let status: unknown;
    const stale = await turn(f, 'user-reset', async () => { await command(f, { verb: 'reset', name: 'fx' }); status = await command(f, { verb: 'get', name: 'fx' }); });
    expect(status).toMatchObject({ server: { scope: 'user', status: 'pending-approval', trust: null } });
    expect(m.calls()).toEqual([]);
    expect(stale.tool.join('\n')).toContain('error=trust-revoked; nothing was sent');
    expect(effects(f)).toEqual([{ target_kind: 'mcp-tool', state: 'refused', refusal: 'EFFECT_REJECTED' }]);
  }, 60_000);

  it('the tool pinned again to another digest while the card waits (same definition, still trusted): nothing is sent (pin-revoked)', async () => {
    const m = fixture(), f = await runtime({ extraGrants: grants }); await f.start();
    writeRegistry(f.project, m.entry()); await approve(f);
    // The running process keeps its listing (the old digest still matches the call); the trust record now pins the tool's new definition.
    const repinned = await turn(f, 'repinned', async () => { m.setTools([{ ...echo, description: 'Echo, changed' }]); await approve(f); });
    expect(m.calls()).toEqual([]);
    expect(repinned.tool.join('\n')).toContain('error=pin-revoked; nothing was sent');
    expect(effects(f)).toEqual([{ target_kind: 'mcp-tool', state: 'refused', refusal: 'EFFECT_REJECTED' }]);
  }, 60_000);

  it('a changed definition (arguments edited) while the card waits: nothing is sent; re-approving the new definition does not revive the stale card', async () => {
    const m = fixture(), f = await runtime({ extraGrants: grants }); await f.start();
    writeRegistry(f.project, m.entry()); await approve(f);
    const edited = await turn(f, 'edited', async () => { writeRegistry(f.project, m.entry(['--token', 'changed'])); });
    expect(m.calls()).toEqual([]);
    expect(edited.tool.join('\n')).toContain('error=definition-changed; nothing was sent');
    // The owner trusts the new definition (same tool pin) while an old-definition card waits: that card is still refused.
    writeRegistry(f.project, m.entry()); await approve(f);
    const reapproved = await turn(f, 'reapproved', async () => { writeRegistry(f.project, m.entry(['--token', 'next'])); await approve(f); });
    expect(m.calls()).toEqual([]);
    expect(reapproved.tool.join('\n')).toContain('error=definition-changed; nothing was sent');
    expect(effects(f).map(row => (row as { state: string }).state)).toEqual(['refused', 'refused']);
  }, 60_000);
});
