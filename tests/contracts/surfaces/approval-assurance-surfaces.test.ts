import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approvalCommandSchema } from '#engine/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { createWorklineLedgerPorts, main } from '#surfaces/core/cli/index.js';
import type { WorklineApproval } from '#surfaces/core/terminal/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';

// B1 APPROVAL-ASSURANCE on the surfaces: MCP never allows (typed refusal at the surface, deny still works); every surface declares its
// channel (a record, never authority); the terminal card forwards the turn's one-time capability with zero extra keys and is the single card
// (binding line first and never clipped, a typed risk line always visible above the preview, nothing-runs on expiry, the required assurance).
const hex = (char: string) => char.repeat(64);
const command = { schemaVersion: 1, scopeId: 's', approvalId: 'a1', commandId: 'c1', expectedRevision: 0, reason: 'Reviewed' };
const CAPABILITY = 'Q'.repeat(43);

describe('MCP decide_approval never allows', () => {
  it('refuses allow with APPROVAL_ATTENDED_REQUIRED before reaching the runtime, sends deny with channel mcp, and advertises no capability or channel field', async () => {
    const seen: unknown[] = [];
    const server = createMcpServer({ async inspectRun() { return null; }, async inspectInventory() { return null; },
      async decideApproval(input: unknown) { seen.push(input); return { status: 'decided' }; } }, { maxConcurrentCalls: 2, responseMaxBytes: 65_536 }, 'en');
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); const client = new Client({ name: 'test', version: '1' }); await client.connect(ct);
    try {
      const tool = (await client.listTools()).tools.find(entry => entry.name === 'decide_approval')!;
      expect(Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)).not.toEqual(expect.arrayContaining(['decisionCapability']));
      expect(Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)).not.toContain('channel');
      const allow = await client.callTool({ name: 'decide_approval', arguments: { ...command, decision: 'allow' } });
      expect(allow.isError).toBe(true);
      expect(JSON.stringify(allow)).toContain('APPROVAL_ATTENDED_REQUIRED');
      expect(seen).toEqual([]);
      // An MCP client cannot smuggle a capability or a channel either.
      expect(JSON.stringify(await client.callTool({ name: 'decide_approval', arguments: { ...command, decision: 'allow', decisionCapability: CAPABILITY } }))).toContain('MCP_INPUT_INVALID');
      expect(JSON.stringify(await client.callTool({ name: 'decide_approval', arguments: { ...command, decision: 'deny', channel: 'local-terminal-card' } }))).toContain('MCP_INPUT_INVALID');
      expect(seen).toEqual([]);
      const deny = await client.callTool({ name: 'decide_approval', arguments: { ...command, decision: 'deny' } });
      expect(deny.isError).not.toBe(true);
      expect(seen).toEqual([{ ...command, decision: 'deny', channel: 'mcp' }]);
      expect(tool.annotations?.destructiveHint).toBe(false);
    } finally { await client.close(); }
  });
});

describe('CLI approval decide declares its channel', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  it('sends the stdin command with channel local-cli (a declared channel is kept as declared: never authority)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-cli-channel-')); roots.push(root);
    const seen: unknown[] = [];
    const run = async (input: Record<string, unknown>) => {
      const stdin = Object.assign(Readable.from([JSON.stringify(input)]), { isTTY: false });
      const out: string[] = [];
      expect(await main(['approval', 'decide', '--input', '-', '--json'], { root, env: { HOME: root }, stdin, stdout: { write: (text: string) => out.push(text) },
        stderr: { write: (text: string) => out.push(text) }, async decideApproval(value: unknown) { seen.push(value); return { status: 'decided' }; } })).toBe(0);
    };
    await run({ ...command, decision: 'allow' });
    await run({ ...command, commandId: 'c2', decision: 'deny', channel: 'local-terminal-card' });
    expect(seen).toEqual([{ ...command, decision: 'allow', channel: 'local-cli' }, { ...command, commandId: 'c2', decision: 'deny', channel: 'local-terminal-card' }]);
    for (const value of seen) expect(() => approvalCommandSchema.parse(value)).not.toThrow();
  });
});

describe('terminal ports forward the turn capability and the facts', () => {
  const base = { root: '/project', scopeId: 's', options: {}, async inspectWorkers() { throw new Error('unused'); }, async inspectRun() { throw new Error('unused'); } } as const;
  const record = (status: 'pending' | 'decided') => ({ request: { schemaVersion: 3, approvalId: 'a1', scopeId: 's', requester: { id: 'u', issuer: 'i', subject: 's' },
    subject: { kind: 'operation', operation: { id: 'erp.post', version: 1 }, target: { kind: 'records', id: 'PO-1' }, commandId: 'cmd', inputDigest: hex('d'),
      targetBinding: hex('e'), expectedVersion: null, compensates: null },
    actionDigest: hex('a'), policyRevision: 'p', summary: 'erp.post@1 · records/PO-1 · dddddddddddd\nPost the order', createdAt: 1, expiresAt: 4_000_000_000_000,
    facts: { risk: { source: 'effect-class', effectClass: 'write', authority: false }, reversibility: { kind: 'compensation', operation: { id: 'erp.void', version: 2 } },
      onExpiry: 'nothing-runs', requiredAssurance: 'peer-session' } },
  ...(status === 'pending' ? { revision: 0, status, decision: null } : { revision: 1, status, decision: { schemaVersion: 2, commandId: 'c', decision: 'allow',
    actor: { id: 'u', issuer: 'i', subject: 's' }, sessionId: 'x', channel: 'local-terminal-card', reason: 'r', decidedAt: 2, requestDigest: hex('d'), commandDigest: hex('e'),
    idempotencyKeyHash: hex('f'), assurance: 'turn-bound' } }), keyId: 'k', mac: hex('b') });

  it('sends channel local-terminal-card and the capability from the card, and maps the record facts to the card', async () => {
    const commands: Record<string, unknown>[] = [];
    const ports = createWorklineLedgerPorts({ ...base, locale: 'en', async listApprovals() { return [record('pending')]; },
      async decideApproval(input) { commands.push(input as Record<string, unknown>); return record('decided'); } })!;
    const page = await ports.listApprovalPage!(null);
    expect(page.items[0]).toMatchObject({ approvalId: 'a1', risk: 'write', undo: 'erp.void@2', requiredAssurance: 'peer-session' });
    await ports.decideApproval!({ approvalId: 'a1', revision: 0, decisionCapability: CAPABILITY } as never, 'allow');
    await ports.decideApproval!({ approvalId: 'a1', revision: 0 }, 'deny');
    expect(commands[0]).toMatchObject({ channel: 'local-terminal-card', decisionCapability: CAPABILITY, decision: 'allow' });
    expect(commands[1]).toMatchObject({ channel: 'local-terminal-card', decision: 'deny' });
    expect(commands[1]).not.toHaveProperty('decisionCapability');
    for (const value of commands) expect(() => approvalCommandSchema.parse(value)).not.toThrow();
  });
});

describe('the single approval card', () => {
  const mounted: Array<{ unmount(): void }> = [];
  afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });
  const baseLedger = { scopeId: 'scope', async listWorkers() { return { schemaVersion: 1, scopeId: 'scope', sources: [] } as never; }, async inspectRun() { return null; } };

  it('shows a long multi-line operation summary whole with the binding line first, the typed risk line, nothing-runs and the required assurance', async () => {
    const description = Array.from({ length: 13 }, (_, line) => `change ${String(line).padStart(2, '0')} ${'x'.repeat(130)}`);
    const summary = [`erp.post@1 · records/PO-1 · ${'d'.repeat(12)}`, ...description].join('\n');
    expect(summary.length).toBeGreaterThan(1_800);
    const item: WorklineApproval = { approvalId: 'op-1', runId: '-', taskId: '-', summary, requester: 'svc', revision: 0, status: 'pending', decision: null,
      expiresAt: Date.now() + 600_000, risk: 'irreversible', undo: 'irreversible', requiredAssurance: 'peer-session' } as WorklineApproval;
    const hardFloor: WorklineApproval = { ...item, approvalId: 'tool-1', summary: `write_file · package.json · ${'a'.repeat(12)}`, risk: 'edit-floor', undo: null,
      requiredAssurance: 'turn-bound' } as WorklineApproval;
    const view = mountWorkline({ pollMs: 10_000, ledger: { ...baseLedger, async listApprovalPage() { return { items: [item, hardFloor], nextAfter: null }; },
      async decideApproval() { throw new Error('unused'); } } as never }, 220);
    mounted.push(view.instance);
    for (const char of '/approvals op-1\r') { view.stdin.write(char); await settle(2); }
    await until(() => view.stdout.frame.includes('A-PROMPT'), 'operation card');
    const frame = view.stdout.frame;
    const at = (text: string) => frame.indexOf(text);
    expect(at(`erp.post@1 · records/PO-1 · ${'d'.repeat(12)}`)).toBeGreaterThan(-1);
    for (const line of description) expect(frame).toContain(line);
    expect(at(`erp.post@1 · records/PO-1`)).toBeLessThan(at('change 00'));
    expect(frame.slice(at('A-TITLE'))).not.toContain('…');
    expect(at('R-RISK irreversible irreversible')).toBeGreaterThan(at('change 12'));
    expect(frame).toContain('R-NOTHING-RUNS'); expect(frame).toContain('R-PEER');
    view.stdin.write('\u001b');
    await until(() => !view.stdout.frame.includes('A-PROMPT'), 'closed');
  });

  it('keeps the risk line above a 40-line heredoc preview of a hard-floor shell call, says only this terminal can allow it, and forwards the capability on y', async () => {
    const decided: Record<string, unknown>[] = [];
    let release!: () => void; const answered = new Promise<void>(resolve => { release = resolve; });
    const heredoc = ['$ cat > big.sh <<EOF', ...Array.from({ length: 40 }, (_, i) => `line ${i}`), 'EOF', 'risk: destructive (rm)', 'realm: host'].join('\n');
    const streamTurn = async function* () {
      yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'c1', approvalId: 'appr-h', revision: 0, summary: `run_shell · cat > big.sh · ${'0'.repeat(12)}`,
        preview: heredoc, expiresAt: Date.now() + 600_000, decisionCapability: CAPABILITY, risk: 'shell-destructive', requiredAssurance: 'turn-bound' };
      await answered;
      yield { kind: 'approval' as const, phase: 'settled' as const, callId: 'c1', approvalId: 'appr-h', outcome: 'allow' as const };
      yield { kind: 'text' as const, text: 'Ran.' }; yield { kind: 'done' as const, finish: 'stop' as const };
    };
    const ledger = { ...baseLedger, async decideApproval(approval: Record<string, unknown>, decision: string) {
      decided.push({ ...approval, decision }); release();
      return { approvalId: 'appr-h', runId: '-', taskId: '-', summary: '', requester: '-', revision: 1, status: 'decided' as const, decision, expiresAt: 0 };
    } };
    const view = mountWorkline({ streamTurn: streamTurn as never, ledger: ledger as never }, 220);
    mounted.push(view.instance);
    await settle(20); for (const char of 'go\r') { view.stdin.write(char); await settle(2); }
    await until(() => view.stdout.frame.includes('A-PROMPT'), 'turn card'); await settle(40);
    const frame = view.stdout.frame;
    expect(frame).toContain('R-RISK shell-destructive R-UNDECLARED');
    expect(frame.indexOf('R-RISK')).toBeLessThan(frame.indexOf('$ cat > big.sh'));
    expect(frame).toContain('A-PREVIEW-MORE'); expect(frame).toContain('R-TURN-HERE'); expect(frame).toContain('R-NOTHING-RUNS');
    view.stdin.write('y');
    await until(() => view.stdout.frame.includes('Ran.'), 'turn continues');
    expect(decided).toEqual([expect.objectContaining({ approvalId: 'appr-h', revision: 0, decisionCapability: CAPABILITY, decision: 'allow' })]);
  });

  it('tells the owner a hard-floor card seen outside its turn can only be denied there', async () => {
    const item = { approvalId: 'tool-2', runId: '-', taskId: '-', summary: `run_shell · rm -rf src · ${'b'.repeat(12)}`, requester: 'svc', revision: 0, status: 'pending', decision: null,
      expiresAt: Date.now() + 600_000, risk: 'shell-destructive', undo: null, requiredAssurance: 'turn-bound' } as WorklineApproval;
    const view = mountWorkline({ pollMs: 10_000, ledger: { ...baseLedger, async listApprovalPage() { return { items: [item], nextAfter: null }; },
      async decideApproval() { throw new Error('unused'); } } as never }, 220);
    mounted.push(view.instance);
    for (const char of '/approvals tool-2\r') { view.stdin.write(char); await settle(2); }
    await until(() => view.stdout.frame.includes('A-PROMPT'), 'tool card');
    expect(view.stdout.frame).toContain('R-TURN-ELSEWHERE');
    expect(view.stdout.frame).toContain('R-RISK shell-destructive R-UNDECLARED');
    view.stdin.write('\u001b');
  });
});
