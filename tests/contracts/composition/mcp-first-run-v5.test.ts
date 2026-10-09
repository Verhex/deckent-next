import { terminalRequest } from '../support/approval-terminal.js';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { firstRunPolicyTemplate, type AgentTurnStreamEvent } from '#domain/index.js';
import { FIRST_RUN_EDIT_SHELL_TOOL_NAMES, FIRST_RUN_MCP_CALL_OPERATION_ID, FIRST_RUN_POLICY_ADMINISTER_OPERATION_ID, FIRST_RUN_PROPOSE_MCP_TOOL_NAME, FIRST_RUN_READ_TOOL_NAMES, FIRST_RUN_SCRATCH_TOOL_NAMES,
  FIRST_RUN_SCRATCH_WRITE_OPERATION_ID, FIRST_RUN_SHELL_OPERATION_ID, FIRST_RUN_WRITE_OPERATION_ID } from '#engine/index.js';
import { closeModeRuntimes, me, modeRuntime, type Mode } from '../support/agent-turn-modes.js';
import { startMcpHttpFixture } from '../../fixtures/mcp-http-server.mjs';

// Owner MCP decisions 2026-10-07 (Jev 04f75210, 71eeb4ab, d3d1817d; K1 option A, Jev 3e7c5b38) end to end on the first-run v5 template: a stdio and
// an HTTP server, the first-use trust windows answered yes in the turn → the trust writes this person's `mcp-server` grant through the governed
// chain (the template grants `policy.administer` and approval decisions) → the fake model's call really reaches the server. Standart asks every
// call, full-auto runs it without a card after an audited relaxation, full access runs it; a person the template does not name gets no grant.
// The harness adds only its model-invocation, scope and approval-decide grants (and, for the full-access turn, the company's full-access grant).
const FIXTURE = resolve('tests/fixtures/mcp-stdio-server.mjs');
const roots: string[] = [], closers: (() => Promise<void>)[] = [];
afterEach(async () => { await closeModeRuntimes(); for (const close of closers.splice(0)) await close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const echo = { name: 'echo', description: 'Echo the arguments', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
function stdioServer() {
  const root = mkdtempSync(join(tmpdir(), 'deckent-mcp-v5-')); roots.push(root);
  const tools = join(root, 'tools.json'), log = join(root, 'log.jsonl'); writeFileSync(tools, JSON.stringify([echo])); appendFileSync(log, '');
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { event: string; name?: string }).filter(event => event.event === 'call');
  return { calls, entry: { command: process.execPath, args: [FIXTURE, '--mode', 'dual', '--tools', tools, '--log', log], realm: 'host' } };
}
/** The v5 template's own grants for this test's scope and person (the harness adds only its model-invocation, scope and approval grants). */
const templateGrants = (person = me[0]!) => (firstRunPolicyTemplate({ scopeId: 'scope', principal: person, readToolNames: FIRST_RUN_READ_TOOL_NAMES,
  scratchToolNames: FIRST_RUN_SCRATCH_TOOL_NAMES, scratchWriteOperationId: FIRST_RUN_SCRATCH_WRITE_OPERATION_ID, editShellToolNames: FIRST_RUN_EDIT_SHELL_TOOL_NAMES,
  writeOperationId: FIRST_RUN_WRITE_OPERATION_ID, shellOperationId: FIRST_RUN_SHELL_OPERATION_ID, proposeMcpToolName: FIRST_RUN_PROPOSE_MCP_TOOL_NAME,
  mcpCallOperationId: FIRST_RUN_MCP_CALL_OPERATION_ID, policyAdministerOperationId: FIRST_RUN_POLICY_ADMINISTER_OPERATION_ID }).policy as { grants: Record<string, unknown>[] }).grants;
const mcpGrants = (data: string) => (JSON.parse(readFileSync(join(data, 'policy.json'), 'utf8')) as { grants: { id: string; effect: string; modeEligible?: boolean;
  resource: { kind: string; ids: string[] } }[] }).grants.filter(grant => grant.id.startsWith('mcp-'));

/** One turn with one scripted tool call; every card of the turn (trust windows, the call's card) is answered with `decision`, each under its own
 * command id (the shared harness answers one card per turn). */
async function turnOf(f: Awaited<ReturnType<typeof modeRuntime>>, name: string, args: Record<string, unknown>, decision: 'allow' | 'deny', turnId: string, fullAccess = false) {
  f.script(name, args);
  const answer = await terminalRequest(f, 'chatTurn', { schemaVersion: 1, scopeId: 'scope', turnId, messages: [{ role: 'user', content: 'go' }], ...(fullAccess ? { fullAccess: true as const } : {}) }, decision);
  const events = answer.events as AgentTurnStreamEvent[];

  const finished = events.find(event => event.kind === 'tool.finished');
  const cards = events.filter(event => event.kind === 'approval.requested') as Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>[];
  return { events, cards, status: finished?.kind === 'tool.finished' ? finished.status : null, note: String((answer.response.result as { note?: unknown }).note ?? '') };
}
const FULL_ACCESS = { id: 'company-full-access', effect: 'allow', actions: ['set'], scopes: ['scope'], principals: me, resource: { kind: 'permission-mode', ids: ['full-access'] } };
async function v5Project(mode: Mode | null, person = me[0]!, extra: Record<string, unknown>[] = []) {
  const f = await modeRuntime({ grants: [...templateGrants(person), ...extra], mode });
  const stdio = stdioServer(), http = await startMcpHttpFixture() as { url: string; requests: { headers: Record<string, string> }[]; close(): Promise<void> };
  closers.push(() => http.close());
  mkdirSync(join(f.project, '.deckent'), { recursive: true });
  writeFileSync(join(f.project, '.deckent', 'mcp.json'), JSON.stringify({ mcpServers: { files: stdio.entry, web: { type: 'http', url: http.url } } }));
  return { f, stdio, http };
}

describe.skipIf(process.platform !== 'linux')('first-run v5: trust → grant → the model really calls the tool in every mode (owner 2026-10-07)', () => {
  it('standart: the trust windows (yes) write one require-approval, mode-eligible mcp-server grant per server; each call asks on its card and, allowed, reaches the stdio and the HTTP server; a no runs nothing', async () => {
    const { f, stdio, http } = await v5Project(null);
    const first = await turnOf(f, 'mcp__files__echo', { text: 'one' }, 'allow', 't1');
    expect(first.cards.length).toBeGreaterThanOrEqual(5); // launch + tools windows of both servers, then the call's own card
    expect(first.status).toBe('ok');
    expect(first.note).not.toContain('were not allowed');
    expect(stdio.calls().map(call => call.name)).toEqual(['echo']);
    expect(mcpGrants(f.data).map(grant => [grant.resource.kind, grant.resource.ids, grant.effect, grant.modeEligible])).toEqual(expect.arrayContaining([
      ['mcp-server', ['files'], 'require-approval', true], ['mcp-server', ['web'], 'require-approval', true]]));
    expect(f.audit().filter(entry => entry.event.subject['kind'] === 'authority-change').length).toBeGreaterThanOrEqual(2);
    const before = http.requests.length;
    const web = await turnOf(f, 'mcp__web__echo', {}, 'allow', 't2');
    expect(web.cards).toHaveLength(1); expect(web.status).toBe('ok');
    expect(http.requests.length).toBeGreaterThan(before);
    const denied = await turnOf(f, 'mcp__files__echo', { text: 'three' }, 'deny', 't3');
    expect(denied.cards).toHaveLength(1); expect(denied.status).toBe('denied');
    expect(stdio.calls()).toHaveLength(1);
  }, 120_000);

  it('full-auto: after trust the same call runs without a card, after an audited permission-mode relaxation', async () => {
    const { f, stdio } = await v5Project('full-auto');
    await turnOf(f, 'mcp__files__echo', { text: 'trust' }, 'allow', 't1');
    const before = stdio.calls().length;
    const lowered = await turnOf(f, 'mcp__files__echo', { text: 'auto' }, 'deny', 't2');
    expect(lowered.cards).toEqual([]); expect(lowered.status).toBe('ok');
    expect(stdio.calls().length).toBe(before + 1);
    expect(f.audit().some(entry => entry.event.subject['kind'] === 'permission-mode' && entry.event.subject['cell'] === 'mcp-call')).toBe(true);
  }, 120_000);

  it('full access (company grant): after trust the call runs without a card, audited as a full-access call', async () => {
    const { f, stdio } = await v5Project(null, me[0]!, [FULL_ACCESS]);
    await turnOf(f, 'mcp__files__echo', { text: 'trust' }, 'allow', 't1');
    const before = stdio.calls().length;
    const ran = await turnOf(f, 'mcp__files__echo', { text: 'access' }, 'deny', 't2', true);
    expect(ran.cards).toEqual([]); expect(ran.status).toBe('ok');
    expect(stdio.calls().length).toBe(before + 1);
    expect(f.audit().some(entry => entry.event.subject['kind'] === 'full-access-call')).toBe(true);
  }, 120_000);

  it('a person the template does not name: no grant is written and the call never reaches the server (negative)', async () => {
    const { f, stdio } = await v5Project('full-auto', { issuer: 'os', subject: 'someone-else' });
    const result = await turnOf(f, 'mcp__files__echo', { text: 'x' }, 'allow', 't1');
    expect(mcpGrants(f.data)).toEqual([]);
    expect(result.status).not.toBe('ok');
    expect(stdio.calls()).toEqual([]);
  }, 120_000);
});
