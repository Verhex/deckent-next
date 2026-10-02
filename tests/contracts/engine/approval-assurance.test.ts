import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPROVAL_ASSURANCE, approvalDecisionAssurance, approvalFacts, approvalRequestSchema, firstRunPolicyTemplate, resolvePolicyBindings, type ApprovalRecord } from '#domain/index.js';
import { createHmacIntegrity } from '../../../src/platform/core/integrity/index.js';
import { openSqliteApprovalStore } from '../../../src/adapters/core/approval-store/index.js';
import { LocalOsSessionAuthority } from '../../../src/adapters/core/local-principal/index.js';
import { ApprovalApplication, HARD_FLOOR_APPROVAL_CELLS, agentToolApprovalFacts, createTurnDecisionCapabilities, requestAgentToolApproval, requestTaskApproval,
  requiredApprovalAssurance, sealApproval, verifyApproval, OperationApprovalBroker } from '../../../src/engine/core/approval/index.js';
import { SQLITE_STORAGE_OPTIONS } from '../../../src/platform/core/config-fields/index.js';

// B1 APPROVAL-ASSURANCE (owner 2026-10-01 attested_assurance): every decision carries a service-derived assurance the client cannot claim;
// hard-floor tool-call cards need `turn-bound` (a one-time capability the turn minted for the connection that started it); everything a solo
// owner allows from the CLI today (task, operation, ordinary edit card) stays `peer-session`; policy `approvalAssurance` only tightens.
const approver = { id: 'approval', effect: 'allow', principals: 'all', scopes: ['scope'], actions: 'all', resource: { kind: 'approval', ids: 'all' } };
const policyWith = (approvalAssurance?: unknown[]) => resolvePolicyBindings({ schemaVersion: 2, revision: 'policy', roles: [], restrictions: [], grants: [approver],
  separationOfDuties: [], ...(approvalAssurance ? { approvalAssurance } : {}) }, { schemaVersion: 1, revision: 'b', bindings: [] });
const CHANNELS = new Set(['local-terminal-card', 'local-cli', 'local-sdk', 'mcp']);
const linux = process.platform !== 'linux';

async function fixture(policy: unknown = policyWith(), wallMs = 1000) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-assurance-'));
  const journal = openSqliteApprovalStore(join(root, 'ledger.db'), SQLITE_STORAGE_OPTIONS.parse({ busyTimeoutMs: 2000, journalMode: 'wal', durability: 'full' }), 'allow');
  const clock = { now: wallMs, sample() { return { wallMs: this.now, monotonicMs: 100 }; } };
  const session = await LocalOsSessionAuthority.create(['scope'], 10_000_000, clock);
  const evidence = await session.verifySession(undefined);
  const integrity = createHmacIntegrity('key', randomBytes(32));
  const ring = createTurnDecisionCapabilities();
  const app = (peerPid: number | null = process.pid) => new ApprovalApplication(journal.store, { verify: async () => evidence.principal }, session, { load: async () => policy },
    integrity, clock, 'local-sdk', 20, () => undefined, undefined, { producers: [ring], channels: CHANNELS, peerPid });
  const self = evidence.session.principalRef;
  let calls = 0;
  const toolCall = (cell: string | null, tool = 'write_file') => requestAgentToolApproval(journal.store, integrity, { scopeId: 'scope',
    subject: { kind: 'agent-tool-call', turnId: 'turn', round: 1, index: calls++, tool, toolVersion: 1, resource: 'package.json', argsDigest: 'a'.repeat(64) },
    requester: self, policyRevision: policy === null ? 'p' : 'policy', summary: `${tool} · package.json`, createdAt: 1000, expiresAt: 900_000,
    ...(cell === null ? {} : { facts: agentToolApprovalFacts(policy, 'scope', cell) }) });
  const mint = (record: ApprovalRecord, over: Partial<{ approvalId: string; peerPid: number; principal: { issuer: string; subject: string }; expiresAt: number }> = {}) =>
    ring.mint({ scopeId: 'scope', approvalId: record.request.approvalId, principal: { issuer: self.issuer, subject: self.subject }, peerPid: process.pid,
      expiresAt: record.request.expiresAt, ...over }, clock.now);
  const command = (record: ApprovalRecord, commandId: string, decision: 'allow' | 'deny', extra: Record<string, unknown> = {}) =>
    ({ schemaVersion: 1, scopeId: 'scope', approvalId: record.request.approvalId, commandId, expectedRevision: 0, decision, reason: 'Reviewed', ...extra });
  const status = (record: ApprovalRecord) => journal.store.load('scope', record.request.approvalId)?.status;
  return { app, ring, clock, self, toolCall, mint, command, status, journal, integrity,
    close: async () => { journal.close(); await rm(root, { recursive: true, force: true }); } };
}

describe('B1 attested assurance on the one approval decision path', () => {
  it.skipIf(linux)('[requires Linux live OS session /proc identity] a hard-floor tool-call card is allowed only with the turn\'s capability (turn-bound); without it the allow is a typed refusal and the card stays pending', async () => {
    const f = await fixture();
    try {
      const card = f.toolCall('edit-floor');
      expect(card.request.schemaVersion).toBe(3);
      expect(approvalFacts(card.request)).toMatchObject({ risk: { source: 'cell', cell: 'edit-floor' }, onExpiry: 'nothing-runs', requiredAssurance: 'turn-bound' });
      // The CLI, the SDK or a second socket connection have no capability: refused, still pending, no receipt.
      await expect(f.app().decide(f.command(card, 'cli-allow', 'allow', { channel: 'local-cli' }))).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
      expect(f.status(card)).toBe('pending');
      expect(f.journal.store.receipt('scope', 'cli-allow')).toBeNull();
      // A declared channel is a record, never authority: claiming to be the terminal card does not raise the assurance.
      await expect(f.app().decide(f.command(card, 'lying-allow', 'allow', { channel: 'local-terminal-card' }))).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
      const capability = f.mint(card);
      const decided = await f.app().decide(f.command(card, 'card-allow', 'allow', { channel: 'local-terminal-card', decisionCapability: capability }));
      expect(decided).toMatchObject({ status: 'decided', decision: { schemaVersion: 2, decision: 'allow', channel: 'local-terminal-card', assurance: 'turn-bound' } });
      expect(approvalDecisionAssurance(decided.decision!)).toBe(APPROVAL_ASSURANCE.turnBound);
      // The deny path stays open to every surface: withdrawing grants nothing.
      const other = f.toolCall('shell-destructive', 'run_shell');
      expect((await f.app().decide(f.command(other, 'mcp-deny', 'deny', { channel: 'mcp' }))).decision).toMatchObject({ decision: 'deny', channel: 'mcp', assurance: 'peer-session' });
    } finally { await f.close(); }
  });

  it.skipIf(linux)('[requires Linux live OS session /proc identity] the capability is single-use and bound to its approval, principal, peer process and expiry; a revoked one is refused', async () => {
    const f = await fixture();
    try {
      const a = f.toolCall('shell-always-ask', 'run_shell'), b = f.toolCall('mcp-call', 'mcp__fx__echo');
      const forA = f.mint(a);
      // Another approval's capability, another principal's, another process's, an expired one: none attests.
      await expect(f.app().decide(f.command(b, 'b-other', 'allow', { decisionCapability: forA }))).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
      const stranger = f.mint(b, { principal: { issuer: f.self.issuer, subject: 'someone-else' } });
      await expect(f.app().decide(f.command(b, 'b-stranger', 'allow', { decisionCapability: stranger }))).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
      const forB = f.mint(b);
      await expect(f.app(process.pid + 1).decide(f.command(b, 'b-process', 'allow', { decisionCapability: forB }))).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
      await expect(f.app(null).decide(f.command(b, 'b-sdk', 'allow', { decisionCapability: forB }))).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
      const short = f.mint(b, { expiresAt: 1500 });
      f.clock.now = 1600;
      await expect(f.app().decide(f.command(b, 'b-expired', 'allow', { decisionCapability: short }))).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
      // A refused allow never burns the owner's capability: the right one still works once.
      expect((await f.app().decide(f.command(a, 'a-allow', 'allow', { decisionCapability: forA }))).decision?.assurance).toBe('turn-bound');
      expect(f.ring.attests({ scopeId: 'scope', approvalId: a.request.approvalId, decider: f.self, peerPid: process.pid, capability: forA, nowMs: f.clock.now })).toBe(false);
      // Revoked (the turn settled the card or ended): refused.
      f.ring.revoke('scope', b.request.approvalId);
      await expect(f.app().decide(f.command(b, 'b-revoked', 'allow', { decisionCapability: forB }))).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
      expect(f.status(b)).toBe('pending');
    } finally { await f.close(); }
  });

  it.skipIf(linux)('[requires Linux live OS session /proc identity] the client cannot claim an assurance or an unregistered channel; a capability string of the wrong shape is invalid input', async () => {
    const f = await fixture();
    try {
      const card = f.toolCall('edit');
      await expect(f.app().decide(f.command(card, 'claim', 'allow', { assurance: 'turn-bound' }))).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      await expect(f.app().decide(f.command(card, 'unknown-channel', 'deny', { channel: 'telegram' }))).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      await expect(f.app().decide(f.command(card, 'bad-capability', 'allow', { decisionCapability: 'x' }))).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      expect(f.status(card)).toBe('pending');
    } finally { await f.close(); }
  });

  it.skipIf(linux)('[requires Linux live OS session /proc identity] the solo owner keeps peer-session approvals with zero extra steps: an ordinary edit card, a task and an irreversible operation from the CLI', async () => {
    const f = await fixture();
    try {
      const edit = f.toolCall('edit');
      expect(approvalFacts(edit.request)?.requiredAssurance).toBe('peer-session');
      expect((await f.app().decide(f.command(edit, 'edit-allow', 'allow', { channel: 'local-cli' }))).decision).toMatchObject({ decision: 'allow', channel: 'local-cli', assurance: 'peer-session' });
      const task = requestTaskApproval(f.journal.store, f.integrity, { scopeId: 'scope', runId: 'run', taskId: 'task', requester: f.self, actionDigest: 'c'.repeat(64),
        policyRevision: 'policy', summary: 'task', createdAt: 1000, expiresAt: 900_000 });
      // No declared channel: the service's default (the SDK) is recorded.
      expect((await f.app().decide(f.command(task, 'task-allow', 'allow'))).decision).toMatchObject({ channel: 'local-sdk', assurance: 'peer-session' });
      const broker = new OperationApprovalBroker(f.journal.store, f.integrity, { load: async () => policyWith() }, f.clock, { requestTtlMs: 600_000, defaultAdmitWithinMs: 60_000 });
      const descriptor = { schemaVersion: 1 as const, operation: { id: 'erp.post', version: 1 }, targetKind: 'records', effectClass: 'irreversible' as const, approval: 'required' as const,
        precondition: 'none' as const, compensation: null, inputMaxBytes: 1024 };
      const command = { schemaVersion: 1 as const, commandId: 'cmd-1', scopeId: 'scope', operation: descriptor.operation, target: { kind: 'records', id: 'PO-1' },
        idempotencyKey: 'k', input: {}, expectedVersion: null };
      const pending = await broker.admit(descriptor, 'require-approval', command, { ...f.self, assurance: 'os-user', scopeIds: ['scope'] } as never,
        { record: null, inputDigest: 'd'.repeat(64), targetBinding: 'e'.repeat(64) } as never) as { pending: { approvalId: string; summary: string } };
      const opened = f.journal.store.load('scope', pending.pending.approvalId)!;
      // The binding line (operation · target · digest) is the summary's first line; the facts carry the descriptor's class and undo.
      expect(pending.pending.summary.split('\n')[0]).toBe(`erp.post@1 · records/PO-1 · ${'d'.repeat(12)}`);
      expect(approvalFacts(opened.request)).toEqual({ risk: { source: 'effect-class', effectClass: 'irreversible', authority: false }, reversibility: { kind: 'irreversible' },
        onExpiry: 'nothing-runs', requiredAssurance: 'peer-session' });
      expect((await f.app().decide(f.command(opened, 'op-allow', 'allow', { channel: 'local-cli' }))).decision?.assurance).toBe('peer-session');
    } finally { await f.close(); }
  });

  it.skipIf(linux)('[requires Linux live OS session /proc identity] policy approvalAssurance only tightens: a looser rule never lowers a hard-floor card, a stricter one raises an ordinary card, an unknown level is unsatisfiable', async () => {
    const loose = policyWith([{ id: 'loose', scopes: ['scope'], subject: 'agent-tool-call', cells: ['edit-floor'], minimum: 'peer-session' }]);
    const f = await fixture(loose);
    try {
      expect(requiredApprovalAssurance(loose, f.toolCall('edit-floor').request)).toBe('turn-bound');
      await expect(f.app().decide(f.command(f.toolCall('edit-floor'), 'loose', 'allow'))).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
    } finally { await f.close(); }
    const strict = policyWith([{ id: 'strict', scopes: ['scope'], subject: 'agent-tool-call', cells: ['edit'], minimum: 'turn-bound' },
      { id: 'tasks', scopes: 'all', subject: 'task', minimum: 'step-up-idp' }]);
    const g = await fixture(strict);
    try {
      const edit = g.toolCall('edit');
      expect(approvalFacts(edit.request)?.requiredAssurance).toBe('turn-bound');
      await expect(g.app().decide(g.command(edit, 'strict', 'allow'))).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
      expect((await g.app().decide(g.command(edit, 'strict-card', 'allow', { decisionCapability: g.mint(edit) }))).decision?.assurance).toBe('turn-bound');
      const task = requestTaskApproval(g.journal.store, g.integrity, { scopeId: 'scope', runId: 'run', taskId: 'task', requester: g.self, actionDigest: 'f'.repeat(64),
        policyRevision: 'policy', summary: 'task', createdAt: 1000, expiresAt: 900_000 });
      await expect(g.app().decide(g.command(task, 'idp', 'allow'))).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
    } finally { await g.close(); }
    // Sol 2234 B1-R1: a v3 tool card whose policy minimum is a level no producer here attests carries that real id in its facts (the card shows
    // it, never "peer-session"); allow stays refused even with the turn's own capability, the card stays pending, no receipt is written.
    const stepUp = policyWith([{ id: 'idp-cards', scopes: ['scope'], subject: 'agent-tool-call', cells: ['shell-read-low'], minimum: 'step-up-idp' }]);
    const h = await fixture(stepUp);
    try {
      const shell = h.toolCall('shell-read-low', 'run_shell');
      expect(approvalFacts(shell.request)?.requiredAssurance).toBe('step-up-idp');
      for (const [commandId, extra] of [['idp-sdk', {}], ['idp-card', { decisionCapability: h.mint(shell) }]] as const) {
        await expect(h.app().decide(h.command(shell, commandId, 'allow', extra))).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
        expect(h.journal.store.receipt('scope', commandId)).toBeNull();
      }
      expect(h.status(shell)).toBe('pending');
      expect((await h.app().decide(h.command(shell, 'idp-deny', 'deny'))).decision?.decision).toBe('deny');
    } finally { await h.close(); }
  });

  it.skipIf(linux)('[requires Linux live OS session /proc identity] a tool-call request without facts (an MCP trust card, a released v2 record) needs turn-bound: unknown risk fails closed', async () => {
    const f = await fixture();
    try {
      const trust = f.toolCall(null, 'mcp_trust');
      expect(approvalFacts(trust.request)).toMatchObject({ risk: null, requiredAssurance: 'turn-bound' });
      await expect(f.app().decide(f.command(trust, 'trust', 'allow'))).rejects.toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
      const v2 = sealApproval({ request: approvalRequestSchema.parse({ schemaVersion: 2, approvalId: 'released', scopeId: 'scope', requester: f.self,
        subject: { kind: 'agent-tool-call', turnId: 't', round: 1, index: 9, tool: 'edit_file', toolVersion: 1, resource: 'src/a.ts', argsDigest: 'b'.repeat(64) },
        actionDigest: 'b'.repeat(64), policyRevision: 'policy', summary: 'edit_file · src/a.ts', createdAt: 1000, expiresAt: 900_000 }), revision: 0, status: 'pending', decision: null }, f.integrity);
      expect(approvalFacts(v2.request)).toBeNull();
      expect(requiredApprovalAssurance(policyWith(), v2.request)).toBe('turn-bound');
    } finally { await f.close(); }
  });

  it('reads a sealed decision written before B1 (no version, no assurance) as peer-session, byte for byte', () => {
    const integrity = createHmacIntegrity('key', randomBytes(32));
    const self = { id: 'owner', issuer: 'host', subject: '1000' };
    const request = approvalRequestSchema.parse({ schemaVersion: 1, approvalId: 'old', scopeId: 'scope', runId: 'run', taskId: 'task', requester: self,
      actionDigest: 'a'.repeat(64), policyRevision: 'p', summary: 'task', createdAt: 1, expiresAt: 10 });
    const legacy = sealApproval({ request, revision: 1, status: 'decided', decision: { commandId: 'c', decision: 'allow', actor: self, sessionId: 's', channel: 'local-runtime',
      reason: 'r', decidedAt: 2, requestDigest: 'b'.repeat(64), commandDigest: 'c'.repeat(64), idempotencyKeyHash: 'd'.repeat(64) } } as never, integrity);
    const read = verifyApproval(JSON.parse(JSON.stringify(legacy)), integrity);
    expect(read.decision).not.toHaveProperty('assurance');
    expect(approvalDecisionAssurance(read.decision!)).toBe('peer-session');
  });

  it('the first-run template v3 carries the Core hard-floor minimum as visible policy data (the same cells the Core default uses)', () => {
    const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: { issuer: 'host', subject: '1000' }, readToolNames: ['read_file'], scratchToolNames: ['scratch_read'],
      scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['write_file'], writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run' });
    expect(template.version).toBe(4); // v4 (CONFIG-SURFACE) keeps the v3 (B1) assurance rule below unchanged
    const rules = (template.policy as { approvalAssurance?: { subject: string; cells?: string[]; minimum: string }[] }).approvalAssurance ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ subject: 'agent-tool-call', minimum: 'turn-bound' });
    expect([...rules[0]!.cells!].sort()).toEqual([...HARD_FLOOR_APPROVAL_CELLS].sort());
  });
});
