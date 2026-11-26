import { storedToolCalls } from './tool-error.js';
import { agentTurnOutcome, agentTurnResultDigest, agentTurnInterruptedNote, AGENT_TURN_INTERRUPTED_NOTE, type AgentTurnClaim, type AgentTurnStore } from './store.js';
import { runAgentTurn, type AgentTurnInput, type AgentTurnPorts, type AgentTurnResult } from './loop.js';
import { TURN_NOTE_MAX_CHARS } from './metadata.js';
import { LOCALES, t } from '#platform/index.js';
import { modelTextPrefix, type ChatTurnSteerOutcome } from '#domain/index.js';

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
  if (input.nativeSession && input.nativeSession.turnId !== claim.turnId) throw new Error('TOOL_SESSION_TURN_CONFLICT');
  const claimed = await store.claim(claim);
  if (claimed.status === 'finished') {
    const { answer, finish, note: storedNote, rounds, toolCalls, steer = { joined: [], returned: [] } } = claimed.outcome;
    let note = storedNote === AGENT_TURN_INTERRUPTED_NOTE ? agentTurnInterruptedNote(input.language) : storedNote;
    if (storedNote) {
      const corrections = new Set<string>();
      for (const locale of LOCALES) {
        if (storedNote.includes(t('headless.chat.legacyCreditsAdvice', {}, locale)))
          corrections.add(t('error.HEADLESS_CREDITS_REQUIRED', {}, input.language));
        if (toolCalls > 0) {
          const quota = t('headless.chat.quotaFallback', {}, locale);
          const checkEffects = t('headless.chat.quotaAfterTools', {}, locale);
          if (storedNote.includes(quota) && !storedNote.includes(`${checkEffects} ${quota}`))
            corrections.add(`${t('headless.chat.quotaAfterTools', {}, input.language)} ${t('headless.chat.quotaFallback', {}, input.language)}`);
        }
        if (storedNote.includes(t('headless.agent.legacySurfaceStopped', {}, locale)) || storedNote.includes(t('headless.agent.legacyGuardStopped', {}, locale)))
          corrections.add(t('headless.agent.surfaceStopped', {}, input.language));
      }
      if (corrections.size) {
        const display = [t('agent.turn.outcome.replaySavedNote', { note: storedNote }, input.language),
          ...Array.from(corrections, correction => t('agent.turn.outcome.replayCorrection', { correction }, input.language))].join('\n');
        note = display.length <= TURN_NOTE_MAX_CHARS ? display : `${modelTextPrefix(display, TURN_NOTE_MAX_CHARS - 1)}…`;
      }
    }
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
      const privateResult = ports.planning?.privateResult(settled.call.id, settled.content);
      if (!privateResult) await ports.settled?.(settled);
      const record = { scopeId: claim.scopeId, turnId: claim.turnId, round: settled.round, index: settled.index, callId: settled.call.id,
        tool: settled.call.name, toolVersion: settled.tool?.version ?? 0, argsDigest: settled.argsDigest, target: settled.target, status: settled.status,
        bytes: Buffer.byteLength(settled.content, 'utf8'), resultDigest: agentTurnResultDigest(settled.content), atMs: ports.now(),
        ...(settled.diagnostic ? { diagnostic: settled.diagnostic } : {}) };
      await store.recordToolCall(record);
      if (input.nativeSession) storedToolCalls.set(settled, Object.freeze(record));
      if (privateResult) {
        if (!ports.planning?.pin || !input.nativeSession || settled.argsDigest === null || settled.status !== 'ok') throw new Error('TOOL_SETTLEMENT_UNAVAILABLE');
        ports.planning.preparationSettled(ports.planning.pin, { turnId: claim.turnId, generation: input.nativeSession.generation,
          callId: settled.call.id, argsDigest: settled.argsDigest, content: settled.content, bytes: record.bytes, resultDigest: record.resultDigest });
        await ports.settled?.({ ...settled, content: privateResult.publicText });
      }
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
