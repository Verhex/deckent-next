import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as adapters from '#adapters/index.js';
import * as engine from '#engine/index.js';
import * as platform from '#platform/index.js';
import * as modelInvocation from '#composition/core/model-invocation/index.js';
import * as providerCatalog from '#composition/core/provider-catalog/index.js';
import { runPeerConfiguredChatTurn, createRuntimeChatTurnHost } from '#composition/core/agent-turn/index.js';
import { approvalRecordSchema, type AgentTurnStreamEvent } from '#domain/index.js';
import { LocalOsSessionAuthority, openSqliteApprovalStore } from '#adapters/index.js';
import { ApprovalApplication, awaitAgentToolApproval, requestAgentToolApproval, requestTaskApproval } from '#engine/index.js';
import { createHmacIntegrity, MAX_WALL_SKEW_MS, SystemTrustedClock, type TrustedClock } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const integrity = createHmacIntegrity('time-key', randomBytes(32));
// Callable shape also runs against the pre-I40-c waiter, making red evidence behavioral rather than a port TypeError.
const timePort = (clock: TrustedClock) => Object.assign(() => clock.sample().wallMs, { sample: () => clock.sample() });
const requester = { id: 'owner', issuer: 'host', subject: '1000' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-i40c-')); roots.push(root);
  const journal = openSqliteApprovalStore(join(root, 'ledger.db'), { busyTimeoutMs: 2000, journalMode: 'wal', durability: 'full' }, 'allow');
  const record = requestAgentToolApproval(journal.store, integrity, { scopeId: 'scope', requester, policyRevision: 'policy', summary: 'Read file',
    subject: { kind: 'agent-tool-call', turnId: 'turn', round: 1, index: 0, tool: 'read_file', toolVersion: 1,
      resource: 'src/a.ts', argsDigest: 'a'.repeat(64) }, createdAt: 10000, expiresAt: 20000 });
  const command = { schemaVersion: 1, scopeId: 'scope', approvalId: record.request.approvalId,
    commandId: 'decision', expectedRevision: 0, decision: 'allow', reason: 'Reviewed' };
  const application = async (clock: TrustedClock, onPolicy = () => undefined) => {
    const sessions = await LocalOsSessionAuthority.create(['scope'], 60000, clock);
    const { principal } = await sessions.verifySession(undefined);
    const policy = { schemaVersion: 1, revision: 'policy', restrictions: [], grants: [
      { id: 'approval', effect: 'allow', principals: 'all', scopes: ['scope'], actions: 'all', resource: { kind: 'approval', ids: 'all' } }] };
    return new ApprovalApplication(journal.store, { verify: async () => principal }, sessions,
      { load: async () => { onPolicy(); return policy; } }, integrity, clock, 'cli', 20);
  };
  return { journal, record, command, application };
}

describe('I40-c B: only the producer determines tool approval expiry', () => {
  it.each([14999, 15000, 19999])('records a decision at producer wall=%i with the decider 5 seconds ahead', async producerNow => {
    const f = await fixture();
    try {
      const now = producerNow + MAX_WALL_SKEW_MS;
      const app = await f.application(new SystemTrustedClock(() => now));
      const decided = await app.decide(f.command);
      expect(decided).toMatchObject({ status: 'decided', decision: { decision: 'allow', decidedAt: now } });
      expect(f.journal.store.receipt('scope', 'decision')?.record).toEqual(decided);
      const producer: TrustedClock = { sample: () => ({ wallMs: producerNow, monotonicMs: producerNow - 10000 }) };
      expect(await awaitAgentToolApproval(f.journal.store, integrity, f.record, producer, new AbortController().signal, 250,
        { wallMs: 10000, monotonicMs: 0 })).toBe('allow');
      expect(decided.request.expiresAt).toBe(20000);
    } finally { f.journal.close(); }
  });

  it('records a late decision but the producer refuses to consume it, including a receipt replay', async () => {
    const f = await fixture();
    try {
      const app = await f.application(new SystemTrustedClock(() => 25000));
      const decided = await app.decide(f.command);
      expect(decided.decision?.decidedAt).toBe(25000);
      const clock: TrustedClock = { sample: () => ({ wallMs: 20000, monotonicMs: 10000 }) };
      expect(await awaitAgentToolApproval(f.journal.store, integrity, f.record, clock, new AbortController().signal, 250,
        { wallMs: 10000, monotonicMs: 0 })).toBe('expired');
      expect(await app.decide(f.command)).toEqual(decided);
      expect(f.journal.store.load('scope', f.record.request.approvalId)).toEqual(decided);
    } finally { f.journal.close(); }
  });

  it('refuses a request already expired by the producer even when the deciding clock lags', async () => {
    const f = await fixture();
    try {
      const producer: TrustedClock = { sample: () => ({ wallMs: 20000, monotonicMs: 10000 }) };
      expect(await awaitAgentToolApproval(f.journal.store, integrity, f.record, producer, new AbortController().signal)).toBe('expired');
      const app = await f.application(new SystemTrustedClock(() => 15000));
      await expect(app.decide(f.command)).rejects.toThrow('APPROVAL_EXPIRED');
      expect(f.journal.store.receipt('scope', 'decision')).toBeNull();
    } finally { f.journal.close(); }
  });

  it('does not make an expiry decision after asynchronous policy/session work either', async () => {
    const f = await fixture(); let now = 14999, checks = 0;
    try {
      const app = await f.application(new SystemTrustedClock(() => now), () => { if (++checks === 2) now = 20000; });
      await expect(app.decide(f.command)).resolves.toMatchObject({ status: 'decided', decision: { decidedAt: 20000 } });
      expect(checks).toBe(2);
      expect(f.journal.store.receipt('scope', 'decision')).not.toBeNull();
    } finally { f.journal.close(); }
  });

  it.each([19999, 20000, 20001])('leaves the task-approval exact expiry contract unchanged at %i', async now => {
    const f = await fixture();
    try {
      const task = requestTaskApproval(f.journal.store, integrity, { scopeId: 'scope', requester, runId: 'run', taskId: 'task',
        policyRevision: 'policy', summary: 'Task', actionDigest: 'b'.repeat(64), createdAt: 10000, expiresAt: 20000 });
      const app = await f.application(new SystemTrustedClock(() => now));
      const result = app.decide({ ...f.command, approvalId: task.request.approvalId });
      if (now < 20000) await expect(result).resolves.toMatchObject({ status: 'decided' });
      else {
        await expect(result).rejects.toThrow('APPROVAL_EXPIRED');
        expect(f.journal.store.load('scope', task.request.approvalId)?.status).toBe('expired');
        expect(f.journal.store.receipt('scope', f.command.commandId)).toBeNull();
      }
    } finally { f.journal.close(); }
  });

  it('keeps the record expiry bound for task and operation subjects, and the creation bound for tools', async () => {
    const f = await fixture();
    try {
      const app = await f.application(new SystemTrustedClock(() => 19999));
      const decided = await app.decide(f.command);
      const subjects = [
        { kind: 'task', runId: 'run', taskId: 'task' },
        { kind: 'operation', operation: { id: 'post-order', version: 1 }, target: { kind: 'records', id: 'PO-1' },
          commandId: 'operation', inputDigest: 'b'.repeat(64), targetBinding: 'c'.repeat(64), expectedVersion: null, compensates: null },
      ];
      for (const subject of subjects) {
        const request = { ...decided.request, schemaVersion: 2, subject };
        for (const decidedAt of [19999, 20000, 20001]) {
          expect(approvalRecordSchema.safeParse({ ...decided, request, decision: { ...decided.decision, decidedAt } }).success).toBe(decidedAt < 20000);
        }
      }
      expect(approvalRecordSchema.safeParse({ ...decided, decision: { ...decided.decision, decidedAt: 9999 } }).success).toBe(false);
    } finally { f.journal.close(); }
  });

  it.each([19999, 20000, 20001])('consumes a stored allow at wall=%i only while unexpired', async now => {
    const f = await fixture();
    try {
      const app = await f.application(new SystemTrustedClock(() => 14000));
      const decided = await app.decide(f.command);
      expect(await awaitAgentToolApproval(f.journal.store, integrity, f.record, timePort(new SystemTrustedClock(() => now)), new AbortController().signal))
        .toBe(now < 20000 ? 'allow' : 'expired');
      expect(f.journal.store.load('scope', f.record.request.approvalId)).toEqual(decided);
    } finally { f.journal.close(); }
  });

  it.each(['backward', 'forward', 'delayed-start', 'allow-at-deadline'] as const)('bounds waiting from production with a %s clock sequence', async mode => {
    const f = await fixture();
    try {
      // Only timer scheduling is virtual. Wall/monotonic values are supplied through the trusted port; Date.now is untouched.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let rawWall = 10000, monotonicMs = 100;
      const wall = new SystemTrustedClock(() => rawWall);
      const clock: TrustedClock = { sample: () => ({ wallMs: wall.sample().wallMs, monotonicMs }) };
      const started = clock.sample();
      if (mode === 'delayed-start') { rawWall = 5000; monotonicMs = 5100; }
      let finished = false;
      const result = awaitAgentToolApproval(f.journal.store, integrity, f.record, timePort(clock), new AbortController().signal, 250, started);
      void result.then(() => { finished = true; }, () => { finished = true; });
      await vi.advanceTimersByTimeAsync(250);
      expect(finished).toBe(false);
      if (mode === 'allow-at-deadline') {
        const app = await f.application(new SystemTrustedClock(() => 14000));
        await app.decide(f.command);
      }
      rawWall = mode === 'forward' ? 20000 : 5000;
      monotonicMs = mode === 'forward' ? 600 : mode === 'allow-at-deadline' ? 10100 : 10099;
      await vi.advanceTimersByTimeAsync(250);
      if (mode !== 'forward') {
        if (mode !== 'allow-at-deadline') expect(finished).toBe(false);
        monotonicMs = 10100;
        await vi.advanceTimersByTimeAsync(250);
      }
      // Attach assertion before awaiting so a broken clock cannot hang the test until its timeout.
      expect(finished).toBe(true);
      await expect(result).resolves.toBe('expired');
      if (mode !== 'allow-at-deadline') expect(f.journal.store.load('scope', f.record.request.approvalId)?.status).toBe('expired');
    } finally { f.journal.close(); }
  });
});

// This focused harness exercises the actual composition producer and surface emission. Model/turn dispatch are
// isolated here; runtime-chat-turn.test.ts separately covers the real loop, local transport and tool execution.
it.each(['preview-expiry', 'policy-expiry', 'timely-allow'] as const)('wires trusted request/turn timestamps through the composition surface: %s', async mode => {
  const f = await fixture();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const decisions: Promise<unknown>[] = [];
    const path = join(roots.at(-1)!, 'ledger.db');
    const context = { principal: { ...requester, assurance: 'os-user', scopeIds: ['scope'] },
      config: { storage: { sqlite: { busyTimeoutMs: 2000, journalMode: 'wal', durability: 'full' } },
        approvals: { requestTtlMs: 10000, keyFile: 'unused' }, service: { inputMaxBytes: 262144 } },
      layout: platform.resolveProductLayout({ projectRoot: roots.at(-1)! }), path: async () => path, policy: { load: async () => ({ revision: 'policy' }) } };
    vi.spyOn(modelInvocation, 'loadPeerInvocationContext').mockResolvedValue(context as unknown as Awaited<ReturnType<typeof modelInvocation.loadPeerInvocationContext>>);
    vi.spyOn(platform, 'loadConfig').mockResolvedValue({} as Awaited<ReturnType<typeof platform.loadConfig>>);
    const reference = { providerId: 'local', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
    vi.spyOn(adapters, 'readTerminalChatConfig').mockReturnValue({ schemaVersion: 1, reference, maxCompletionTokens: 128 });
    vi.spyOn(providerCatalog, 'inspectModelBinding').mockResolvedValue({ status: 'declared', catalogRevision: 'catalog',
      binding: { digest: 'a'.repeat(64) }, definition: { model: { protocols: [] } } } as unknown as Awaited<ReturnType<typeof providerCatalog.inspectModelBinding>>);
    vi.spyOn(adapters, 'openLocalIntegrityAuthority').mockResolvedValue(integrity);
    let rawWall = 10000, monotonicMs = 100;
    const source = new SystemTrustedClock(() => rawWall), sample = source.sample.bind(source);
    vi.spyOn(SystemTrustedClock.prototype, 'sample').mockImplementation(() => ({ wallMs: sample().wallMs, monotonicMs }));
    const app = await f.application(new SystemTrustedClock(() => 10000));
    vi.spyOn(engine.AgentToolPolicyAuthorization.prototype, 'decide').mockImplementation(async () => {
      if (mode === 'policy-expiry') monotonicMs = 10100;
      return 'allow';
    });
    const events: AgentTurnStreamEvent[] = [];
    let claimedAt: number | undefined, recordedAt: number | undefined, settlement: string | undefined;
    vi.spyOn(engine, 'runDurableAgentTurn').mockImplementation(async (input, _store, ports) => {
      claimedAt = input.claim.claimedAtMs;
      rawWall = 5000;
      settlement = await ports.requestApproval!({ round: 1, index: 0,
        call: { id: 'call', name: 'read_file', argumentsJson: '{"path":"src/a.ts"}' },
        tool: { name: 'read_file', version: 1, toolClass: 'read', description: 'Read', inputSchema: { type: 'object', properties: {} } },
        args: { path: 'src/a.ts' }, argsDigest: 'b'.repeat(64), target: 'src/a.ts' }, input.signal);
      recordedAt = ports.now();
      return { finish: 'stop', note: null, rounds: 1, toolCalls: 0, answer: null, appendedCount: 0,
        appendedDigest: null, replayed: false, recorded: true };
    });
    const controller = new AbortController();
    // Bound regressions too: raw timestamps or a lost production anchor must fail, never strand a wait.
    watchdog = setTimeout(() => controller.abort(), 5000);
    const host = createRuntimeChatTurnHost({} as Parameters<typeof createRuntimeChatTurnHost>[0], controller.signal);
    await runPeerConfiguredChatTurn('/unused', { schemaVersion: 1, scopeId: 'scope', turnId: 'producer-turn',
      messages: [{ role: 'user', content: 'Read' }] }, {} as Parameters<typeof runPeerConfiguredChatTurn>[2], {},
    { maxResultBytes: 4096 } as Parameters<typeof runPeerConfiguredChatTurn>[4], host, {
      signal: controller.signal, drained: async () => undefined, emit: event => {
        events.push(event);
        // Time spent showing a preview counts against the producer's original budget even if the wall floor stalls.
        if (event.kind === 'approval.requested') {
          if (mode === 'preview-expiry') monotonicMs = 10100;
          else {
            const decision = app.decide({ ...f.command, approvalId: event.approvalId });
            void decision.catch(() => undefined); decisions.push(decision);
          }
        }
      },
    });
    await Promise.all(decisions);
    const requested = events.find(event => event.kind === 'approval.requested');
    expect(requested).toMatchObject({ expiresAt: 20000 });
    expect(claimedAt).toBe(10000); expect(recordedAt).toBe(10000);
    const expected = mode === 'timely-allow' ? 'allow' : 'expired';
    expect(settlement).toBe(expected);
    expect(events.find(event => event.kind === 'approval.settled')).toMatchObject({ outcome: expected });
    if (requested?.kind !== 'approval.requested') throw new Error('APPROVAL_NOT_EMITTED');
    expect(f.journal.store.load('scope', requested.approvalId)).toMatchObject({ status: mode === 'preview-expiry' ? 'expired' : 'decided', request: { createdAt: 10000, expiresAt: 20000 } });
  } finally { clearTimeout(watchdog); f.journal.close(); }
});
