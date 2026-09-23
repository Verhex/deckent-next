import { describe, expect, it } from 'vitest';
import { approvalCommandSchema, approvalListSchema, runCommandSchema } from '#engine/index.js';
import { createWorklineLedgerPorts } from '#surfaces/core/cli/index.js';

const hex = (char: string) => char.repeat(64);
function record(approvalId: string, status: 'pending' | 'decided' = 'pending', decision: 'allow' | 'deny' = 'allow') {
  const request = { schemaVersion: 1, approvalId, scopeId: 's', runId: 'run-1', taskId: 'task-1', requester: { id: 'svc', issuer: 'test', subject: 'svc' },
    actionDigest: hex('a'), policyRevision: 'p', summary: `write ${approvalId}`, createdAt: 1, expiresAt: 4_000_000_000_000 };
  return status === 'pending' ? { request, revision: 0, status, decision: null, keyId: 'k', mac: hex('b') }
    : { request, revision: 1, status, keyId: 'k', mac: hex('c'), decision: { commandId: 'c', decision, actor: { id: 'u', issuer: 'i', subject: 's' }, sessionId: 'x',
      channel: 'local-runtime', reason: 'r', decidedAt: 2, requestDigest: hex('d'), commandDigest: hex('e'), idempotencyKeyHash: hex('f') } };
}
const base = { root: '/project', scopeId: 's', options: {}, async inspectWorkers() { throw new Error('unused'); }, async inspectRun() { throw new Error('unused'); } } as const;

describe('terminal work ports over the CLI handlers', () => {
  it('lists approvals through the runtime list handler with a valid bounded page and a cursor only after a full page', async () => {
    const inputs: unknown[] = [];
    const ports = createWorklineLedgerPorts({ ...base, approvalPageSize: 2, locale: 'en',
      async listApprovals(input) { inputs.push(input); return inputs.length === 1 ? [record('a1'), record('a2', 'decided')] : [record('a3')]; },
      async decideApproval() { throw new Error('unused'); } })!;
    const first = await ports.listApprovalPage!(null);
    expect(first).toMatchObject({ nextAfter: 'a2', items: [{ approvalId: 'a1', status: 'pending', revision: 0, requester: 'svc', summary: 'write a1' },
      { approvalId: 'a2', status: 'decided', decision: 'allow' }] });
    expect(await ports.listApprovalPage!('a2')).toMatchObject({ nextAfter: null });
    for (const input of inputs) expect(() => approvalListSchema.parse(input)).not.toThrow();
    expect(inputs[1]).toEqual({ schemaVersion: 1, scopeId: 's', afterId: 'a2', limit: 2 });
    await expect(createWorklineLedgerPorts({ ...base, async listApprovals() { return [{ request: {} }]; }, async decideApproval() { return null; } })!
      .listApprovalPage!(null)).rejects.toThrow();
  });

  it('sends one explicit, schema-valid decision command per keypress through the same runtime decide handler as `approvals decide`', async () => {
    const commands: Array<Record<string, unknown>> = [];
    const ports = createWorklineLedgerPorts({ ...base, locale: 'tr', async listApprovals() { return []; },
      async decideApproval(input) { commands.push(input as Record<string, unknown>); return record('a1', 'decided', (input as { decision: 'allow' | 'deny' }).decision); } })!;
    expect(await ports.decideApproval!({ approvalId: 'a1', revision: 0 }, 'deny')).toMatchObject({ approvalId: 'a1', status: 'decided', decision: 'deny' });
    await ports.decideApproval!({ approvalId: 'a1', revision: 0 }, 'allow');
    for (const command of commands) expect(approvalCommandSchema.parse(command)).toMatchObject({ scopeId: 's', approvalId: 'a1', expectedRevision: 0 });
    expect(commands.map(command => command['decision'])).toEqual(['deny', 'allow']);
    expect(commands[0]!['reason']).toBe('Operatör Deckent terminalinde reddetti.');
    expect(commands[0]!['commandId']).not.toBe(commands[1]!['commandId']);
  });

  it('renders the transcript with the CLI renderer, keeps unsealed attempts visible and lets policy denial surface as an error', async () => {
    const attempt = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
    const ports = createWorklineLedgerPorts({ ...base, locale: 'en', async inspectWorkerTranscript(_root, identity) {
      if (identity.attemptId === 'denied') throw Object.assign(new Error('POLICY_DENIED'), { code: 'POLICY_DENIED' });
      return { schemaVersion: 1, identity, sealed: null, summary: null, events: [] };
    } })!;
    expect(await ports.inspectTranscript!(attempt)).toBe('No sealed worker events for this attempt.');
    await expect(ports.inspectTranscript!({ ...attempt, attemptId: 'denied' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('requests cancellation with the confirmed revision and renders the typed delivery outcome like `run cancel`', async () => {
    const commands: unknown[] = [];
    const ports = createWorklineLedgerPorts({ ...base, locale: 'en', async deliverRunCancellation(_root, command) {
      commands.push(command);
      return { schemaVersion: 1, layout: {} as never, delivery: { schemaVersion: 2, runId: 'run-7', scopeId: 's', cancellationRequested: true,
        outcomes: [{ taskId: 'task-1', attemptId: 'a-1', status: 'unresolved', delivery: { state: 'queued', attempts: 1, nextEligibleAt: 0 } }] } };
    } })!;
    const text = await ports.cancelRun!('run-7', 3);
    expect(runCommandSchema.parse(commands[0])).toMatchObject({ scopeId: 's', runId: 'run-7', action: 'cancel', expectedRevision: 3 });
    expect(text).toContain('run-7'); expect(text).toContain('task-1');
    expect(text.split('\n').length).toBeGreaterThan(2);
  });

  it('offers no work ports that are not wired', () => {
    const ports = createWorklineLedgerPorts(base)!;
    expect([ports.inspectTranscript, ports.listApprovalPage, ports.decideApproval, ports.cancelRun]).toEqual([undefined, undefined, undefined, undefined]);
  });
});
