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

// B1 APPROVAL-ASSURANCE on the surfaces: MCP offers no approval decision tool; every surface declares its
// channel (a record, never authority); the terminal card forwards the turn's one-time capability with zero extra keys and is the single card
// (binding line first and never clipped, a typed risk line always visible above the preview, nothing-runs on expiry, the required assurance).
const hex = (char: string) => char.repeat(64);
const command = { schemaVersion: 1, scopeId: 's', approvalId: 'a1', commandId: 'c1', expectedRevision: 0, reason: 'Reviewed' };
const CAPABILITY = 'Q'.repeat(43);

describe('MCP approval decisions are unavailable', () => {
  async function connect() {
    const seen: unknown[] = [];
    const applications = { async inspectRun() { return null; }, async inspectInventory() { return null; },
      async listApprovals() { return [{ approvalId: 'a1', status: 'pending' }]; },
      async inspectApproval() { return { approvalId: 'a1', status: 'pending' }; },
      // Even an application object retaining the SDK method must not expose it as an MCP tool.
      async decideApproval(input: unknown) { seen.push(input); return { status: 'decided' }; } };
    const server = createMcpServer(applications, { maxConcurrentCalls: 2, responseMaxBytes: 65_536 }, 'en');
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
    const client = new Client({ name: 'test', version: '1' }); await client.connect(ct);
    return { client, server, seen };
  }
  it('does not offer decide_approval and retains list/inspect observation', async () => {
    const { client, server } = await connect();
    try {
      const names = (await client.listTools()).tools.map(entry => entry.name);
      expect(names).not.toContain('decide_approval');
      expect(names).toEqual(expect.arrayContaining(['list_approvals', 'inspect_approval']));
      expect((await client.callTool({ name: 'list_approvals', arguments: { schemaVersion: 1, scopeId: 's', afterId: null, limit: 10 } })).isError).not.toBe(true);
      expect((await client.callTool({ name: 'inspect_approval', arguments: { schemaVersion: 1, scopeId: 's', approvalId: 'a1' } })).isError).not.toBe(true);
    } finally { await client.close(); await server.close(); }
  });
  it.each(['allow', 'deny'])('returns the ordinary unknown-tool result for %s without invoking a decision', async decision => {
    const { client, server, seen } = await connect();
    try {
      const unknown = await client.callTool({ name: 'nonexistent_tool', arguments: {} });
      expect(unknown.isError).toBe(true);
      expect(JSON.stringify(unknown)).toContain('MCP_TOOL_UNKNOWN');
      for (const extra of [{}, { decisionCapability: CAPABILITY }, { channel: 'local-terminal-card' }]) {
        expect(await client.callTool({ name: 'decide_approval', arguments: { ...command, decision, ...extra } })).toEqual(unknown);
        expect(seen).toEqual([]);
      }
    } finally { await client.close(); await server.close(); }
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
      expect(await main(['approval', 'decide', '--input', '-', '--json'], { root, env: { HOME: root, USERPROFILE: root }, stdin, stdout: { write: (text: string) => out.push(text) },
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

/** The approval window's EN key hint and field texts (T-APPROVAL-WINDOW); the assurance sentences keep the harness's probe tokens. */
const DENY = 'n deny (Enter/Esc too)', NOTHING_RUNS = 'if nobody decides, nothing runs';
/** SLASH-WINDOWS (SW-2): `/approvals` takes no typed reference; the card opens from the picker (`index`: its 0-based row). */
async function pickApproval(view: ReturnType<typeof mountWorkline>, index: number, label: string) {
  for (const char of '/approvals\r') { view.stdin.write(char); await settle(2); }
  await until(() => view.stdout.frame.includes('> A-ITEM 1'), `${label} picker`).catch(error => { throw new Error(`${String(error)}\n${view.stdout.frame}`); }); await settle(40);
  for (let step = 0; step < index; step++) { view.stdin.write('\u001b[B'); await settle(20); }
  view.stdin.write('\r');
  await until(() => view.stdout.frame.includes(DENY), label); await settle(40);
}

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
    await pickApproval(view, 0, 'operation card');
    const frame = view.stdout.frame;
    const at = (text: string) => frame.indexOf(text);
    expect(at(`erp.post@1 · records/PO-1 · ${'d'.repeat(12)}`)).toBeGreaterThan(-1);
    for (const line of description) expect(frame).toContain(line);
    expect(at(`erp.post@1 · records/PO-1`)).toBeLessThan(at('change 00'));
    expect(frame.slice(at('Approval needed'))).not.toContain('…');
    expect(at('Cannot be undone')).toBeGreaterThan(at('change 12')); expect(frame).toContain('No — it cannot be undone');
    expect(frame).toContain(NOTHING_RUNS); expect(frame).toContain('R-PEER');
    view.stdin.write('\u001b');
    await until(() => !view.stdout.frame.includes(DENY), 'closed');
  });

  it('keeps the risk line above a 40-line heredoc preview of a hard-floor shell call, says only this terminal can allow it, and forwards the capability on y', async () => {
    const decided: Record<string, unknown>[] = [];
    let release!: () => void; const answered = new Promise<void>(resolve => { release = resolve; });
    const heredoc = ['$ cat > big.sh <<EOF', ...Array.from({ length: 40 }, (_, i) => `line ${i}`), 'EOF', 'risk: destructive (rm)', 'realm: host'].join('\n');
    const streamTurn = async function* () {
      yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'c1', approvalId: 'appr-h', revision: 0, summary: `run_shell · cat > big.sh · ${'0'.repeat(12)}`,
        preview: heredoc, expiresAt: Date.now() + 600_000, decisionCapability: CAPABILITY, risk: 'shell-destructive', requiredAssurance: 'turn-bound',
        call: { kind: 'shell' as const, command: heredoc.split('\n').slice(0, 42).join('\n').slice(2), tier: 'destructive', reason: 'rm' } };
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
    await until(() => view.stdout.frame.includes(DENY), 'turn card'); await settle(40);
    const frame = view.stdout.frame;
    // A 40-line heredoc keeps the facts on screen: its field shows three rows, the preview below has the whole command.
    expect(frame).toMatch(/Risk: +Deletes \(cannot be undone\)/u); // REVERSIBILITY: a destructive shell card without the producer's word is classified by its cell (never "reversible").
    expect(frame).toMatch(/Undo: +No — it cannot be undone/u);
    expect(frame.indexOf('Deletes (cannot be undone)')).toBeLessThan(frame.indexOf('line 20'));
    expect(frame).toContain('… 39 more lines'); expect(frame).toMatch(/rows 1–\d+ of \d+/u); expect(frame).toContain('R-TURN-HERE'); expect(frame).toContain(NOTHING_RUNS);
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
    await pickApproval(view, 0, 'tool card');
    expect(view.stdout.frame).toContain('R-TURN-ELSEWHERE');
    expect(view.stdout.frame).toMatch(/Risk: +Deletes \(cannot be undone\)/u); expect(view.stdout.frame).toMatch(/Command: +rm -rf src/u);
    view.stdin.write('\u001b');
  });
});

// Sol 2234 REVISE (B1-R1..R3): the card names the real required level, the MCP trust card keeps its facts line, and a typed assurance refusal
// leaves the pending card open (the owner can still deny it); a late answer only touches its own card.
describe('the single approval card after Sol 2234', () => {
  const mounted: Array<{ unmount(): void }> = [];
  afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });
  const baseLedger = { scopeId: 'scope', async listWorkers() { return { schemaVersion: 1, scopeId: 'scope', sources: [] } as never; }, async inspectRun() { return null; } };
  const typed = (code: string) => Object.assign(new Error(code), { code });
  const card = (id: string, patch: Partial<WorklineApproval> = {}) => ({ approvalId: id, runId: '-', taskId: '-', summary: `run_shell · ls · ${'c'.repeat(12)}`, requester: 'svc',
    revision: 0, status: 'pending', decision: null, expiresAt: Date.now() + 600_000, risk: 'shell-read-low', undo: null, ...patch }) as WorklineApproval;
  const open = (view: ReturnType<typeof mountWorkline>, id: string) => pickApproval(view, Number(id.slice(-1)) - 1, `card ${id}`);

  it('R1: names a required level other than peer-session or turn-bound by its id and never says peer-session suffices', async () => {
    const items = [card('idp-1', { requiredAssurance: 'step-up-idp' }), card('peer-1', { requiredAssurance: 'peer-session' })];
    const view = mountWorkline({ pollMs: 10_000, ledger: { ...baseLedger, async listApprovalPage() { return { items, nextAfter: null }; },
      async decideApproval() { throw new Error('unused'); } } as never }, 220);
    mounted.push(view.instance);
    await open(view, 'idp-1');
    expect(view.stdout.frame).toContain('R-OTHER step-up-idp');
    expect(view.stdout.frame).not.toContain('R-PEER');
    // Esc denies; this fixture's decide port throws, so the failure shows in its own window (SW-2), which Esc closes into the one system line.
    view.stdin.write('\u001b'); await until(() => view.stdout.frame.includes('ERR:unused') && !view.stdout.frame.includes(DENY), 'deny failure window'); await settle(40);
    view.stdin.write('\u001b'); await until(() => view.stdout.frame.includes('◆ Deckent system · ERR:unused'), 'closed'); await settle(60);
    await pickApproval(view, 1, 'card peer-1');
    expect(view.stdout.frame).toContain('R-PEER'); expect(view.stdout.frame).not.toContain('R-OTHER');
    view.stdin.write('\u001b');
  });

  it('R2: an MCP trust card with undeclared risk shows "not declared", its turn-bound line, and never renders the capability', async () => {
    let release!: () => void; const answered = new Promise<void>(resolve => { release = resolve; });
    const decided: Record<string, unknown>[] = [];
    const streamTurn = async function* () {
      yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'mcp-trust-fx-launch', approvalId: 'trust-1', revision: 0, summary: 'mcp_trust · mcp:fx · launch',
        preview: 'MCP server fx (project scope)', expiresAt: Date.now() + 600_000, decisionCapability: CAPABILITY, risk: null, requiredAssurance: 'turn-bound' };
      await answered;
      yield { kind: 'approval' as const, phase: 'settled' as const, callId: 'mcp-trust-fx-launch', approvalId: 'trust-1', outcome: 'allow' as const };
      yield { kind: 'text' as const, text: 'Trusted.' }; yield { kind: 'done' as const, finish: 'stop' as const };
    };
    const ledger = { ...baseLedger, async decideApproval(approval: Record<string, unknown>, decision: string) {
      decided.push({ ...approval, decision }); release();
      return { approvalId: 'trust-1', runId: '-', taskId: '-', summary: '', requester: '-', revision: 1, status: 'decided' as const, decision, expiresAt: 0 };
    } };
    const view = mountWorkline({ streamTurn: streamTurn as never, ledger: ledger as never }, 220);
    mounted.push(view.instance);
    await settle(20); for (const char of 'go\r') { view.stdin.write(char); await settle(2); }
    await until(() => view.stdout.frame.includes(DENY), 'trust card'); await settle(40);
    expect(view.stdout.frame).toMatch(/Risk: +not classified by the tool/u); expect(view.stdout.frame).toMatch(/Undo: +not declared by the tool/u);
    expect(view.stdout.frame).toContain('R-TURN-HERE');
    view.stdin.write('y');
    await until(() => view.stdout.frame.includes('Trusted.'), 'turn continues');
    expect(decided).toEqual([expect.objectContaining({ approvalId: 'trust-1', decisionCapability: CAPABILITY, decision: 'allow' })]);
    expect(view.stdout.text).not.toContain(CAPABILITY);
  });

  it('R3: a typed assurance refusal keeps the same pending card open so the owner can still deny it; a transport failure is never shown as decided', async () => {
    const calls: { id: string; decision: string }[] = [];
    const items = [card('floor-1', { requiredAssurance: 'turn-bound' }), card('floor-2', { requiredAssurance: 'turn-bound' })];
    const view = mountWorkline({ pollMs: 10_000, ledger: { ...baseLedger, async listApprovalPage() { return { items, nextAfter: null }; },
      async decideApproval(approval: { approvalId: string }, decision: 'allow' | 'deny') {
        calls.push({ id: approval.approvalId, decision });
        if (approval.approvalId === 'floor-2') throw typed('LOCAL_RUNTIME_TRANSPORT');
        if (decision === 'allow') throw typed('APPROVAL_ASSURANCE_INSUFFICIENT');
        return { ...items[0]!, status: 'decided' as const, revision: 1, decision };
      } } as never }, 220);
    mounted.push(view.instance);
    await open(view, 'floor-1');
    view.stdin.write('y');
    await until(() => view.stdout.text.includes('ERR:APPROVAL_ASSURANCE_INSUFFICIENT'), 'typed refusal shown');
    // SW-2: the refusal is its own window; Esc returns to the same pending card, which the owner can still deny.
    await settle(60); view.stdin.write('\u001b');
    await until(() => view.stdout.frame.includes(DENY) && view.stdout.frame.includes('Approval: floor-1'), 'same card after the refusal');
    expect(view.stdout.text).not.toContain('A-ALLOWED floor-1');
    view.stdin.write('n');
    await until(() => view.stdout.text.includes('A-DENIED floor-1') && !view.stdout.frame.includes(DENY), 'denied after refusal'); await settle(60);
    expect(calls).toEqual([{ id: 'floor-1', decision: 'allow' }, { id: 'floor-1', decision: 'deny' }]);
    await open(view, 'floor-2');
    view.stdin.write('y');
    await until(() => view.stdout.text.includes('ERR:LOCAL_RUNTIME_TRANSPORT') && !view.stdout.frame.includes(DENY), 'uncertain result closes, not decided');
    expect(view.stdout.text).not.toContain('A-ALLOWED floor-2');
  });

  it('R3: an old card\'s late assurance refusal never touches the next card of the turn', async () => {
    let refuseA!: () => void; const aAnswered = new Promise<void>(resolve => { refuseA = resolve; });
    const decided: string[] = [];
    let release!: () => void; const bAnswered = new Promise<void>(resolve => { release = resolve; });
    const streamTurn = async function* () {
      yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'a', approvalId: 'card-a', revision: 0, summary: 'write_file · package.json · aaaaaaaaaaaa',
        preview: 'A', expiresAt: Date.now() + 600_000, decisionCapability: CAPABILITY, risk: 'edit-floor', requiredAssurance: 'turn-bound' };
      await settle(150);
      yield { kind: 'approval' as const, phase: 'settled' as const, callId: 'a', approvalId: 'card-a', outcome: 'expired' as const };
      yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'b', approvalId: 'card-b', revision: 0, summary: 'write_file · Makefile · bbbbbbbbbbbb',
        preview: 'B', expiresAt: Date.now() + 600_000, decisionCapability: 'R'.repeat(43), risk: 'edit-floor', requiredAssurance: 'turn-bound' };
      refuseA();
      await bAnswered;
      yield { kind: 'approval' as const, phase: 'settled' as const, callId: 'b', approvalId: 'card-b', outcome: 'deny' as const };
      yield { kind: 'text' as const, text: 'Done.' }; yield { kind: 'done' as const, finish: 'stop' as const };
    };
    const ledger = { ...baseLedger, async decideApproval(approval: { approvalId: string }, decision: string) {
      decided.push(`${approval.approvalId}:${decision}`);
      if (approval.approvalId === 'card-a') { await aAnswered; await settle(40); throw typed('APPROVAL_ASSURANCE_INSUFFICIENT'); }
      release(); return { approvalId: 'card-b', runId: '-', taskId: '-', summary: '', requester: '-', revision: 1, status: 'decided' as const, decision, expiresAt: 0 };
    } };
    const view = mountWorkline({ streamTurn: streamTurn as never, ledger: ledger as never }, 220);
    mounted.push(view.instance);
    await settle(20); for (const char of 'go\r') { view.stdin.write(char); await settle(2); }
    await until(() => view.stdout.frame.includes('package.json'), 'card A'); await settle(40);
    view.stdin.write('y');
    await until(() => view.stdout.frame.includes('Makefile') && view.stdout.frame.includes(DENY), 'card B open');
    await until(() => view.stdout.text.includes('ERR:APPROVAL_ASSURANCE_INSUFFICIENT'), 'late refusal of A');
    await settle(60);
    expect(view.stdout.frame).toContain('Makefile'); expect(view.stdout.frame).toContain(DENY); expect(view.stdout.frame).not.toContain('package.json');
    view.stdin.write('n');
    await until(() => view.stdout.frame.includes('Done.'), 'turn continues');
    expect(decided).toEqual(['card-a:allow', 'card-b:deny']);
  });
});
