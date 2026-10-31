import { agentTurnOutcome, agentTurnResultDigest, agentTurnInterruptedNote, AGENT_TURN_INTERRUPTED_NOTE, type AgentTurnClaim, type AgentTurnStore } from './store.js';
import { runAgentTurn, type AgentTurnInput, type AgentTurnPorts, type AgentTurnResult } from './loop.js';
import { t } from '#platform/index.js';
import type { ChatTurnSteerOutcome } from '#domain/index.js';

/**
 * A turn with durable identity (T-L3): claim first; a finished turn of the same request replays its stored outcome (the final
 * answer, when it was kept, is re-emitted as text and returned; no message is appended again (count 0, the recorded digest); no model round is started); a new turn runs the loop, records every settled tool call, and is finished
 * with its outcome even when the loop fails unexpectedly. When the loop answered but its outcome could not be stored, the answer is
 * still returned with `recorded: false` (the surface already showed it; the turn stays running until the next service start closes
 * it as interrupted); a loop failure is never masked by a store failure.
 */
export async function runDurableAgentTurn(input: AgentTurnInput & { readonly claim: AgentTurnClaim }, store: AgentTurnStore, ports: AgentTurnPorts):
  Promise<AgentTurnResult & { readonly replayed: boolean; readonly recorded: boolean; readonly steer: ChatTurnSteerOutcome }> {
  const { claim } = input;
  const claimed = await store.claim(claim);
  if (claimed.status === 'finished') {
    const { answer, finish, note: storedNote, rounds, toolCalls, steer = { joined: [], returned: [] } } = claimed.outcome;
    const note = storedNote === AGENT_TURN_INTERRUPTED_NOTE ? agentTurnInterruptedNote(input.language) : storedNote;
    if (answer) input.emit({ kind: 'text', text: answer });
    input.emit({ kind: 'done', finish, note });
    return Object.freeze({ finish, note, rounds, toolCalls, answer, appendedCount: 0,
      appendedDigest: claimed.outcome.appendedDigest, replayed: true, recorded: true, steer });
  }
  const failed = agentTurnOutcome({ finish: 'error', note: t('agent.turn.outcome.interrupted', {}, input.language), rounds: 0, toolCalls: 0,
    answer: null, appendedDigest: null });
  let result: AgentTurnResult;
  try {
    result = await runAgentTurn(input, { ...ports, settled: async settled => {
      await ports.settled?.(settled);
      await store.recordToolCall({ scopeId: claim.scopeId, turnId: claim.turnId, round: settled.round, index: settled.index, callId: settled.call.id,
        tool: settled.call.name, toolVersion: settled.tool?.version ?? 0, argsDigest: settled.argsDigest, target: settled.target, status: settled.status,
        bytes: Buffer.byteLength(settled.content, 'utf8'), resultDigest: agentTurnResultDigest(settled.content), atMs: ports.now(),
        ...(settled.diagnostic ? { diagnostic: settled.diagnostic } : {}) });
    } });
  } catch (error) {
    const steer = ports.steer?.close();
    await store.finish(claim.scopeId, claim.turnId, steer ? agentTurnOutcome({ ...failed, steer }) : failed, ports.now()).catch(() => undefined);
    throw error;
  }
  // v30 (Astra 2882): the steered lines' outcome is closed with the loop and stored with the turn, so a replay returns the same ids.
  const steer = ports.steer?.close() ?? { joined: [], returned: [] };
  const recorded = await store.finish(claim.scopeId, claim.turnId, agentTurnOutcome({ ...result, steer }), ports.now()).then(() => true, () => false);
  return Object.freeze({ ...result, replayed: false, recorded, steer });
}
