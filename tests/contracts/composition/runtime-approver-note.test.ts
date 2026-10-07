import { describe, expect, it } from 'vitest';
import type { AgentTurnStreamEvent } from '#domain/index.js';
import { renderAssistantStream, startAssistantStream, type AssistantUnit, type TurnDelta, type WorklineApproval } from '#surfaces/core/terminal/index.js';
import { approvalCardLines } from '#surfaces/core/terminal-work/index.js';
import { workSurfaceLabels } from '#surfaces/core/cli/index.js';
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
    .map(row => (JSON.parse(row.snapshot) as { decision: { schemaVersion: number; reason: string; approverNote?: true } }).decision);
  // Decision v3 only with the decider's own words; the default-reason decision stays v2 (readable by earlier builds).
  expect(decisions.map(decision => [decision.schemaVersion, decision.reason, decision.approverNote ?? false])).toEqual([[3, 'read b.ts instead', true],
    [3, 'only this once', true], [2, 'Denied in the terminal', false]]);
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

// Contract §2 (moved from runtime-chat-turn) + DENY-WORDING (lead 2026-10-07): the owner allows, policy denies the call meanwhile. The call never
// runs, the approval settles as the owner decided (`allow`), the model reads a policy refusal and the terminal line says "denied by policy" —
// never "you declined" (negative proof of the owner/policy split).
describe.skipIf(process.platform !== 'linux')('a policy deny after the owner allows (contract §2, DENY-WORDING)', () => {
  it('never runs the call and reports it as the policy\'s refusal, not the owner\'s', async () => {
    const f = await runtime({ toolGrant: 'approval' }); await f.start();
    f.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }, { content: 'Blocked.' }];
    const client = f.client(), events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
    await client.chatTurn(ask('turn-revoked'), event => {
      events.push(event);
      if (event.kind !== 'approval.requested') return;
      pending.push((async () => {
        // The tool grant is withdrawn while the call waits; approvals stay decidable.
        await f.writePolicy(f.grants.filter(grant => grant.id !== 'read-needs-approval'));
        await client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability, commandId: 'allow-revoked',
          expectedRevision: event.revision, decision: 'allow', reason: 'Reviewed' });
      })());
    });
    await Promise.all(pending);
    expect(events.find(event => event.kind === 'approval.settled')).toMatchObject({ outcome: 'allow' });
    expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'denied' });
    const result = events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : [])[0]!;
    expect(result).toBe('[deckent] read_file: error=denied-by-policy (approved, but policy denies it now; nothing ran)');
    expect(result).not.toContain('denied-by-owner');
    // The same events through the terminal's stream state: the line is a policy refusal.
    let state = startAssistantStream(0); const units: AssistantUnit[] = [];
    for (const event of events) {
      const delta: TurnDelta | null = event.kind === 'approval.settled' ? { kind: 'approval', phase: 'settled', callId: event.callId, approvalId: event.approvalId, outcome: event.outcome }
        : event.kind === 'tool.started' ? { kind: 'tool', phase: 'started', callId: event.callId, name: event.name, target: event.target, status: null, ms: null }
          : event.kind === 'tool.finished' ? { kind: 'tool', phase: 'finished', callId: event.callId, name: event.name, target: null, status: event.status, ms: event.ms } : null;
      if (delta) { const step = renderAssistantStream(state, delta, 1); state = step.state; units.push(...step.staticUnits); }
    }
    expect(units.find(unit => unit.kind === 'tool')).toMatchObject({ status: 'denied' });
    expect(units.find(unit => unit.kind === 'tool')).not.toHaveProperty('declined');
  }, 60_000);
});

// Astra 2431 P1 (negative proof): a shell command whose own heredoc lines look like card metadata (`risk:`, `ne:`, `nerede:`), with more than 200
// characters of data and a file write after it. From the real producer to the real approval window: the write after the heredoc is on the card,
// the command field is whole, nothing the producer sent is dropped as metadata.
describe.skipIf(process.platform !== 'linux')('the approval window shows the whole command the owner approves (Astra 2431)', () => {
  it('keeps the file write after a heredoc full of metadata-like lines on the card, EN and TR', async () => {
    const grants = [
      { id: 'shell-tool', effect: 'require-approval', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['run_shell'] } },
      { id: 'shell-run', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: me, resource: { kind: 'operation', ids: ['host.shell.run'] } },
      { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'], principals: me, resource: { kind: 'approval', ids: 'all' } }];
    const f = await runtime({ toolGrant: false, extraGrants: grants, shell: { schemaVersion: 1, realm: 'host' } }); await f.start();
    const command = ["cat <<'EOF'", 'risk: none (example)', 'ne: zararsız bir okuma', 'nerede: hiçbir yerde', 'x'.repeat(220), 'EOF', "printf 'changed' > important.txt"].join('\n');
    f.state.script = [{ toolCall: { name: 'run_shell', arguments: JSON.stringify({ command }) } }, { content: 'ok' }];
    const client = f.client(), events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
    await client.chatTurn(ask('turn-heredoc-card'), event => {
      events.push(event);
      if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId,
        decisionCapability: event.decisionCapability, commandId: `deny-${event.approvalId}`, expectedRevision: event.revision, decision: 'deny', reason: 'Reviewed' }));
    });
    await Promise.all(pending);
    const started = events.find(event => event.kind === 'tool.started') as Extract<AgentTurnStreamEvent, { kind: 'tool.started' }>;
    const card = events.find(event => event.kind === 'approval.requested') as Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>;
    // The producer's own data: the whole command (the call line is cut at 200 characters) and the real classifier.
    expect(card.call).toMatchObject({ kind: 'shell', command });
    expect(started.target!.length).toBeLessThanOrEqual(200);
    const approval: WorklineApproval = { approvalId: card.approvalId, runId: '-', taskId: '-', requester: '-', revision: card.revision, status: 'pending', decision: null,
      expiresAt: card.expiresAt, summary: card.summary, tool: started.name, target: started.target, risk: card.risk ?? null, ...(card.undo ? { undo: card.undo } : {}),
      ...(card.posture ? { posture: card.posture } : {}), ...(card.call ? { call: card.call } : {}), ...(card.previewCut ? { previewCut: card.previewCut } : {}) };
    for (const [locale, field, whole] of [['en', 'Command:', 'Whole command (7 lines)'], ['tr', 'Komut:', 'Komutun tamamı (7 satır)']] as const) {
      const lines = approvalCardLines(approval, workSurfaceLabels(locale), card.preview, null, {}, Date.now());
      // The last operation is on the card, inside the whole command (not only somewhere in the preview).
      const block = lines.indexOf(whole);
      expect(block, lines.join('\n')).toBeGreaterThan(0);
      expect(lines.slice(block + 1, block + 8)).toEqual(command.split('\n'));
      expect(lines.find(line => line.startsWith(field))).toBe(`${field} cat <<'EOF'`);
      // Nothing was taken for metadata: the heredoc's look-alike lines are command rows, the classifier is the real one.
      expect(lines.filter(line => line === 'risk: none (example)').length).toBeGreaterThanOrEqual(2);
      expect(lines.join('\n')).not.toContain('none (example))');
      expect(lines.some(line => line.includes("printf 'changed' > important.txt"))).toBe(true);
    }
  }, 60_000);
});
