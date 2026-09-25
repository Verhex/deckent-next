import { agentTurnResultDigest, type AgentTurnClaim, type AgentTurnOutcome, type AgentTurnStore } from './store.js';
import { runAgentTurn, type AgentTurnInput, type AgentTurnPorts, type AgentTurnResult } from './loop.js';

/**
 * A turn with durable identity (T-L3): claim first; a finished turn of the same request replays its stored outcome (the last
 * answer is re-emitted, no model round is started); a new turn runs the loop, records every settled tool call, and is finished
 * with its outcome even when the loop fails unexpectedly.
 */
export async function runDurableAgentTurn(input: AgentTurnInput & { readonly claim: AgentTurnClaim }, store: AgentTurnStore, ports: AgentTurnPorts):
  Promise<AgentTurnResult & { readonly replayed: boolean }> {
  const { claim } = input;
  const claimed = await store.claim(claim);
  if (claimed.status === 'finished') {
    const last = [...claimed.outcome.appended].reverse().find(message => message.role === 'assistant');
    if (last && last.role === 'assistant' && last.content) input.emit({ kind: 'text', text: last.content });
    input.emit({ kind: 'done', finish: claimed.outcome.finish, note: claimed.outcome.note });
    return Object.freeze({ ...claimed.outcome, replayed: true });
  }
  let outcome: AgentTurnOutcome = { finish: 'error', note: 'The turn failed before it could finish; nothing more ran.', rounds: 0, toolCalls: 0, appended: [] };
  try {
    const result = await runAgentTurn(input, { ...ports, settled: async settled => {
      await ports.settled?.(settled);
      await store.recordToolCall({ scopeId: claim.scopeId, turnId: claim.turnId, round: settled.round, index: settled.index, callId: settled.call.id,
        tool: settled.call.name, toolVersion: settled.tool?.version ?? 0, argsDigest: settled.argsDigest, target: settled.target, status: settled.status,
        bytes: Buffer.byteLength(settled.content, 'utf8'), resultDigest: agentTurnResultDigest(settled.content), atMs: ports.now() });
    } });
    outcome = { finish: result.finish, note: result.note, rounds: result.rounds, toolCalls: result.toolCalls, appended: result.appended };
    return Object.freeze({ ...result, replayed: false });
  } finally {
    await store.finish(claim.scopeId, claim.turnId, outcome, ports.now());
  }
}
