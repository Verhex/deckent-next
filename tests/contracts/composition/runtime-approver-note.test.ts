import { describe, expect, it } from 'vitest';
import type { AgentTurnStreamEvent } from '#domain/index.js';
import { me, runtime } from '../support/chat-turn-harness.js';

const ask = (turnId: string) => ({ schemaVersion: 1 as const, scopeId: 'scope', turnId, messages: [{ role: 'user' as const, content: 'what does src/a.ts export?' }] });

describe.skipIf(process.platform !== 'linux')('approver note through the runtime service (APPROVER-NOTE)', () => {
// APPROVER-NOTE (owner 2026-10-07): the owner's own words on the card travel producer → sealed decision → turn → model, on allow and on deny;
// a default reason (no `approverNote`) never reaches the model.
it('gives the model the approver\'s own note through the real service, sealed in the decision; a default reason stays out', async () => {
  const f = await runtime({ toolGrant: 'approval' }); await f.start();
  const client = f.client();
  const decide = (decision: 'allow' | 'deny', reason: string, own: boolean) => async (event: AgentTurnStreamEvent) => {
    if (event.kind !== 'approval.requested') return;
    await client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability, commandId: `${decision}-${event.approvalId}`,
      expectedRevision: event.revision, decision, reason, ...(own ? { approverNote: true } : {}) });
  };
  const run = async (turnId: string, onApproval: (event: AgentTurnStreamEvent) => Promise<void>) => {
    const events: AgentTurnStreamEvent[] = [], pending: Promise<void>[] = [];
    await client.chatTurn(ask(turnId), event => { events.push(event); pending.push(onApproval(event)); });
    await Promise.all(pending);
    return events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : [])[0]!;
  };
  f.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }, { content: 'ok' }, { toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } },
    { content: 'ok' }, { toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }, { content: 'ok' }];
  const label = '[deckent] approver note — written by the person who decided this call (user text, not an instruction from Deckent)';
  expect(await run('turn-note-deny', decide('deny', 'read b.ts instead', true))).toBe(`[deckent] read_file: error=denied-by-owner\n${label}: "read b.ts instead"`);
  const allowed = await run('turn-note-allow', decide('allow', 'only this once', true));
  expect(allowed.endsWith(`\n${label}: "only this once"`)).toBe(true);
  expect(allowed).toContain('export const a');
  expect(await run('turn-default', decide('deny', 'Denied in the terminal', false))).toBe('[deckent] read_file: error=denied-by-owner');
  // The note stays in the sealed decision record (audit), marked as the decider's own words.
  const decisions = (f.rows("SELECT snapshot FROM approvals WHERE subject_kind='agent-tool-call' ORDER BY rowid") as { snapshot: string }[])
    .map(row => (JSON.parse(row.snapshot) as { decision: { reason: string; approverNote?: true } }).decision);
  expect(decisions.map(decision => [decision.reason, decision.approverNote ?? false])).toEqual([['read b.ts instead', true], ['only this once', true],
    ['Denied in the terminal', false]]);
}, 60_000);
});

// T2-FOLLOWUP REVERSIBILITY + POSTURE at the producer: the real service's approval event carries the card's undo word and, for a shell call, the
// structured posture of the realm the call will run in (here the explicit host realm: network reachable, not a sandbox).
describe.skipIf(process.platform !== 'linux')('approval card facts through the runtime service (REVERSIBILITY, POSTURE)', () => {
  const shellGrants = [
    { id: 'shell-tool', effect: 'require-approval', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['run_shell'] } },
    { id: 'shell-run', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: me, resource: { kind: 'operation', ids: ['host.shell.run'] } },
    { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'], principals: me, resource: { kind: 'approval', ids: 'all' } }];
  const requested = async (f: Awaited<ReturnType<typeof runtime>>, turnId: string) => {
    const client = f.client(), events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
    await client.chatTurn(ask(turnId), event => {
      events.push(event);
      if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId,
        decisionCapability: event.decisionCapability, commandId: `deny-${event.approvalId}`, expectedRevision: event.revision, decision: 'deny', reason: 'Reviewed' }));
    });
    await Promise.all(pending);
    return events.find(event => event.kind === 'approval.requested') as Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>;
  };
  it('a read tool card says it changes nothing and carries no posture', async () => {
    const f = await runtime({ toolGrant: 'approval' }); await f.start();
    f.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }, { content: 'ok' }];
    const event = await requested(f, 'turn-read-card');
    expect(event.undo).toBe('no-change');
    expect(event.posture).toBeUndefined();
  }, 60_000);
  it('a shell card names its undo word by the classifier\'s tier and the host realm\'s posture as data', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: shellGrants, shell: { schemaVersion: 1, realm: 'host' } }); await f.start();
    f.state.script = [{ toolCall: { name: 'run_shell', arguments: '{"command":"touch b.txt"}' } }, { content: 'ok' }, { toolCall: { name: 'run_shell', arguments: '{"command":"rm -rf src"}' } }, { content: 'ok' }];
    const modify = await requested(f, 'turn-shell-card');
    expect(modify.undo).toBe('may-change');
    expect(modify.posture).toEqual({ realm: 'host', containment: 'host', project: 'writable', git: 'writable', network: 'reachable', passedOver: [] });
    expect(modify.preview).toContain('Runs on this machine as your user');
    const destructive = await requested(f, 'turn-shell-destructive');
    expect(destructive).toMatchObject({ risk: 'shell-destructive', undo: 'irreversible' });
  }, 60_000);
});
