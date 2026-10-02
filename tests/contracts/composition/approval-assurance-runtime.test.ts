import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTurnStreamEvent } from '#domain/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { main } from '#surfaces/core/cli/index.js';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';

// B1 APPROVAL-ASSURANCE end to end on the real runtime service: a turn's hard-floor card (a write to the write floor) is allowed only by the
// terminal that started the turn, with the one-time capability the turn sent on its own stream. The SDK, the stdin JSON CLI, a client that
// claims to be the card and a forged capability are typed refusals; MCP never allows. The owner's own ordinary card still takes one CLI step.
afterEach(closeModeRuntimes);
const HOST = { shell: { schemaVersion: 1, realm: 'host' } };
type Effect = 'allow' | 'deny' | 'require-approval';
const edit = (tool: Effect, op: Effect) => [rule('edit-tools', 'agent-tool', ['edit_file', 'write_file'], tool), rule('file-write', 'operation', ['workspace.file.write'], op)];
type Runtime = Awaited<ReturnType<typeof modeRuntime>>;
type Requested = Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>;

/** `deckent approval decide --input -` in process, over the same runtime client the installed CLI uses; the typed code of a refusal. */
async function cli(f: Runtime, input: Record<string, unknown>): Promise<unknown> {
  const out: string[] = [], err: string[] = [];
  const stdin = Object.assign(Readable.from([JSON.stringify(input)]), { isTTY: false });
  const exit = await main(['approval', 'decide', '--input', '-', '--json'], { root: f.project, env: f.env, stdin, stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) }, decideApproval: value => f.client.decideApproval(value) });
  return exit === 0 ? JSON.parse(out.join('')) : (JSON.parse(err.join('')) as { code: string }).code;
}
async function mcp(f: Runtime, input: Record<string, unknown>): Promise<string> {
  const server = createMcpServer({ async inspectRun() { return null; }, async inspectInventory() { return null; },
    listApprovals: (value, delivery) => f.client.listApprovals(value, delivery),
    inspectApproval: (value, delivery) => f.client.inspectApproval(value, delivery) }, { maxConcurrentCalls: 2, responseMaxBytes: 65_536 }, 'en');
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); const client = new Client({ name: 'agent', version: '1' }); await client.connect(ct);
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).not.toContain('decide_approval');
    expect(names).toEqual(expect.arrayContaining(['list_approvals', 'inspect_approval']));
    const query = { schemaVersion: 1, scopeId: input['scopeId'], approvalId: input['approvalId'] };
    const before = await client.callTool({ name: 'inspect_approval', arguments: query });
    expect(before.isError).not.toBe(true);
    expect(before.structuredContent).toMatchObject({ status: 'pending' });
    const result = await client.callTool({ name: 'decide_approval', arguments: input });
    expect(result.isError).toBe(true);
    expect(await client.callTool({ name: 'inspect_approval', arguments: query })).toEqual(before);
    return JSON.stringify(result);
  } finally { await client.close(); await server.close(); }
}

const code = (promise: Promise<unknown>) => promise.then(value => value, (error: { code?: string }) => error.code ?? String(error));

/** One turn with one `write_file` call; `answer` decides its card from the test's surfaces while the turn waits. */
async function turn(f: Runtime, turnId: string, path: string, answer: (event: Requested, base: Record<string, unknown>) => Promise<void>) {
  const events: AgentTurnStreamEvent[] = [], pending: Promise<void>[] = [];
  f.script('write_file', { path, content: '{}\n' });
  await f.client.chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId, messages: [{ role: 'user', content: 'go' }] }, event => {
    events.push(event);
    if (event.kind === 'approval.requested') pending.push(answer(event, { schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, expectedRevision: event.revision, reason: 'Reviewed' }));
  });
  await Promise.all(pending);
  return events;
}

describe.skipIf(process.platform !== 'linux')('B1 attested assurance through the runtime service', () => {
  it('allows a hard-floor card only with the capability of the turn that asked; SDK, CLI, a lying channel, a forged capability and MCP are typed refusals', async () => {
    const f = await modeRuntime({ ...HOST, grants: edit('allow', 'allow'), mode: null });
    const seen: Record<string, unknown> = {};
    // Every surface without the capability is refused while the card waits; the card's own answer then allows it.
    const events = await turn(f, 'turn-surfaces', 'Makefile', async (event, base) => {
      seen['sdk'] = await code(f.client.decideApproval({ ...base, commandId: 'sdk', decision: 'allow' }));
      seen['cli'] = await cli(f, { ...base, commandId: 'cli', decision: 'allow' });
      seen['lying'] = await code(f.client.decideApproval({ ...base, commandId: 'lying', decision: 'allow', channel: 'local-terminal-card' }));
      seen['forged'] = await code(f.client.decideApproval({ ...base, commandId: 'forged', decision: 'allow', decisionCapability: 'A'.repeat(43) }));
      seen['mcp'] = await mcp(f, { ...base, commandId: 'mcp', decision: 'allow' });
      seen['pending'] = (await f.client.inspectApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId }) as { status: string }).status;
      seen['card'] = await code(f.client.decideApproval({ ...base, commandId: 'card', decision: 'allow', channel: 'local-terminal-card', decisionCapability: event.decisionCapability }));
    });
    expect(seen['sdk']).toBe('APPROVAL_ASSURANCE_INSUFFICIENT');
    expect(seen['cli']).toBe('APPROVAL_ASSURANCE_INSUFFICIENT');
    expect(seen['lying']).toBe('APPROVAL_ASSURANCE_INSUFFICIENT');
    expect(seen['forged']).toBe('APPROVAL_ASSURANCE_INSUFFICIENT');
    expect(seen['mcp']).toContain('MCP_TOOL_UNKNOWN');
    expect(seen['pending']).toBe('pending');
    expect(seen['card']).toMatchObject({ status: 'decided', decision: { decision: 'allow', channel: 'local-terminal-card', assurance: 'turn-bound' } });
    expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'ok' });
    expect(await readFile(join(f.project, 'Makefile'), 'utf8')).toBe('{}\n');
    // The harness answers as the terminal card of the turn it started (it forwards the capability): turn-bound, its own channel default.
    const result = await f.call('write_file', { path: 'package.json', content: '{}\n' }, 'allow');
    expect(result).toMatchObject({ card: true, status: 'ok' });
    const card = result.events.find(event => event.kind === 'approval.requested') as Requested;
    expect(card.decisionCapability).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(card).toMatchObject({ risk: 'edit-floor', requiredAssurance: 'turn-bound' });
    expect(await f.client.inspectApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: card.approvalId })).toMatchObject({ status: 'decided',
      request: { schemaVersion: 3, facts: { risk: { source: 'cell', cell: 'edit-floor' }, onExpiry: 'nothing-runs', requiredAssurance: 'turn-bound' } },
      decision: { schemaVersion: 2, decision: 'allow', assurance: 'turn-bound', channel: 'local-sdk' } });
  }, 60_000);

  it('keeps the solo owner\'s ordinary card one CLI step (peer-session), keeps SDK/CLI deny while MCP cannot change the pending record', async () => {
    const f = await modeRuntime({ ...HOST, grants: edit('require-approval', 'allow'), mode: null });
    const decided: Record<string, unknown> = {};
    await turn(f, 'turn-cli', 'src/b.ts', async (_event, base) => { decided['cli'] = await cli(f, { ...base, commandId: 'cli-allow', decision: 'allow' }); });
    expect(decided['cli']).toMatchObject({ status: 'decided', decision: { decision: 'allow', channel: 'local-cli', assurance: 'peer-session' } });
    expect(await readFile(join(f.project, 'src', 'b.ts'), 'utf8')).toBe('{}\n');
    await f.writeAuthority(edit('allow', 'allow'), null, 'r2');
    const denied: Record<string, unknown> = {};
    await turn(f, 'turn-deny-sdk', 'package.json', async (_e, base) => { denied['sdk'] = await f.client.decideApproval({ ...base, commandId: 'sdk-deny', decision: 'deny' }); });
    await turn(f, 'turn-deny-cli', 'package.json', async (_e, base) => { denied['cli'] = await cli(f, { ...base, commandId: 'cli-deny', decision: 'deny' }); });
    await turn(f, 'turn-deny-mcp', 'package.json', async (event, base) => {
      denied['mcp'] = await mcp(f, { ...base, commandId: 'mcp-deny', decision: 'deny' });
      denied['mcp-record'] = await f.client.inspectApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId });
      // Settle through the authorized SDK so the waiting turn completes after the negative proof.
      await f.client.decideApproval({ ...base, commandId: 'sdk-after-mcp', decision: 'deny' });
    });
    for (const [surface, channel] of [['sdk', 'local-sdk'], ['cli', 'local-cli']] as const) {
      expect(denied[surface]).toMatchObject({ status: 'decided', decision: { decision: 'deny', channel, assurance: 'peer-session' } });
    }
    expect(denied['mcp']).toContain('MCP_TOOL_UNKNOWN');
    expect(denied['mcp-record']).toMatchObject({ status: 'pending' });
    await expect(readFile(join(f.project, 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);
});
