import { describe, expect, it } from 'vitest';
import { runtime } from '../support/chat-turn-harness.js';

const ask = (turnId: string) => ({ schemaVersion: 1 as const, scopeId: 'scope', turnId, messages: [{ role: 'user' as const, content: 'what does src/a.ts export?' }] });

// TERMINAL-GAPS: a client that closes while the owner's answer is awaited writes nothing the service could fail on; the turn still ends
// within a second, the card closes expired and the request never becomes an allow.
describe.skipIf(process.platform !== 'linux')('approval wait and a disconnecting client', () => {
  it('closes a turn waiting on an approval within a second when the client disconnects, and the request never becomes an allow', async () => {
    const f = await runtime({ toolGrant: 'approval' }); await f.start();
    f.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }, { content: 'must not run' }];
    const controller = new AbortController(); let approvalId = '', leftAt = 0;
    const pending = f.client().chatTurn(ask('turn-gone-approval'), event => {
      if (event.kind === 'approval.requested') { approvalId = event.approvalId; leftAt = performance.now(); controller.abort(); }
    }, controller.signal);
    await expect(pending).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_TRANSPORT' });
    const state = () => f.rows("SELECT state FROM agent_turns WHERE turn_id='turn-gone-approval'") as { state: string }[];
    const until = performance.now() + 5_000;
    while (state()[0]?.state !== 'finished' && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    expect(performance.now() - leftAt).toBeLessThan(1_000);
    const turn = JSON.parse((f.rows("SELECT record FROM agent_turns WHERE turn_id='turn-gone-approval'")[0] as { record: string }).record);
    expect(turn.outcome).toMatchObject({ finish: 'cancelled' });
    const card = JSON.parse((f.rows(`SELECT snapshot FROM approvals WHERE approval_id='${approvalId}'`)[0] as { snapshot: string }).snapshot);
    expect(card.status).toBe('expired');
    expect(card.decision ?? null).toBeNull();
    // Negative: the call never ran (one model request only, no tool result) although the client never answered.
    expect(f.state.requests).toHaveLength(1);
  }, 30_000);
});
