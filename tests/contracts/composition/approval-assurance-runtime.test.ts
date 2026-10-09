import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { readFile } from 'node:fs/promises';
import { terminalRequest } from '../support/approval-terminal.js';
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

describe.skipIf(process.platform !== 'linux')('service-attested interactive human approval', () => {
  it('refuses SDK, piped CLI, forged channel and a valid turn capability without interactive input/output; records stay pending', async () => {
    const f = await modeRuntime({ ...HOST, grants: edit('require-approval', 'allow'), mode: null });
    await turn(f, 'ordinary', 'src/b.ts', async (event, base) => {
      for (const decision of ['allow', 'deny']) {
        expect(await code(f.client.decideApproval({ ...base, commandId: `sdk-${decision}`, decision }))).toBe('APPROVAL_INTERACTIVE_REQUIRED');
        expect(await cli(f, { ...base, commandId: `cli-${decision}`, decision })).toBe('APPROVAL_INTERACTIVE_REQUIRED');
      }
      expect(await code(f.client.decideApproval({ ...base, commandId: 'lying', decision: 'allow', channel: 'local-terminal-card',
        decisionCapability: event.decisionCapability }))).toBe('APPROVAL_INTERACTIVE_REQUIRED');
      for (const mode of ['piped-input', 'redirected-output']) {
        const refused = await terminalRequest(f, 'decideApproval', { ...base, commandId: mode, decision: 'allow' }, undefined, mode);
        expect(refused.response).toMatchObject({ ok: false, error: { code: 'APPROVAL_INTERACTIVE_REQUIRED' } });
      }
      expect(await mcp(f, { ...base, commandId: 'mcp', decision: 'allow' })).toContain('MCP_TOOL_UNKNOWN');
      expect(await f.client.inspectApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId })).toMatchObject({ status: 'pending' });
      const accepted = await terminalRequest(f, 'decideApproval', { ...base, commandId: 'human', decision: 'allow', channel: 'local-cli' });
      expect(accepted.response).toMatchObject({ ok: true, result: { status: 'decided', decision: { decision: 'allow', channel: 'local-cli', assurance: 'peer-session' } } });
    });
    expect(await readFile(join(f.project, 'src/b.ts'), 'utf8')).toBe('{}\n');
  }, 60_000);

  it('requires both a real terminal and the initiating process capability on hard-floor cards; another terminal cannot allow them', async () => {
    const f = await modeRuntime({ ...HOST, grants: edit('allow', 'allow'), mode: null });
    await turn(f, 'foreign-terminal', 'Makefile', async (event, base) => {
      for (const extra of [{}, { decisionCapability: 'A'.repeat(43) }, { decisionCapability: event.decisionCapability }]) {
        const refused = await terminalRequest(f, 'decideApproval', { ...base, ...extra, commandId: `foreign-${Object.keys(extra).length}-${String(extra.decisionCapability).slice(0, 4)}`,
          decision: 'allow', channel: 'local-terminal-card' });
        expect(refused.response).toMatchObject({ ok: false, error: { code: 'APPROVAL_ASSURANCE_INSUFFICIENT' } });
      }
      const denied = await terminalRequest(f, 'decideApproval', { ...base, commandId: 'human-deny', decision: 'deny' });
      expect(denied.response).toMatchObject({ ok: true, result: { status: 'decided', decision: { decision: 'deny' } } });
    });
    await expect(readFile(join(f.project, 'Makefile'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    f.script('write_file', { path: 'package.json', content: '{}\n' });
    const accepted = await terminalRequest(f, 'chatTurn', { schemaVersion: 1, scopeId: 'scope', turnId: 'own-terminal', messages: [{ role: 'user', content: 'go' }] }, 'allow');
    expect(accepted.response.ok).toBe(true);
    expect(accepted.decisions).toEqual([expect.objectContaining({ ok: true, result: expect.objectContaining({ status: 'decided',
      decision: expect.objectContaining({ assurance: 'turn-bound', channel: 'local-terminal-card' }) }) })]);
    expect(await readFile(join(f.project, 'package.json'), 'utf8')).toBe('{}\n');
  }, 60_000);
});
