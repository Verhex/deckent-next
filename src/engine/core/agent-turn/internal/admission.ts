/** Tokens kept free beyond the completion limit (legacy default): chat template and tokenizer differences never overflow a round. */
const SAFETY_RESERVE_TOKENS = 2_048;

/**
 * What a chat turn is admitted with, from the terminal chat configuration and the service input bound: the tokens a round keeps free in
 * the window (completion limit and safety margin), the bound of the client's next request and the room that request needs. The runtime
 * service admits the turn with it (`runDurableAgentTurn` `admission`); the terminal applies it only to name the summarizing phase it
 * cannot see (TL-A, protocol v15). One formula for both sides (COMPOSITION-BUDGET): no mirrored copy can drift.
 */
export interface AgentTurnAdmission {
  readonly outputReserveTokens: number;
  readonly safetyReserveTokens: number;
  readonly requestMaxBytes: number;
  readonly requestReserveBytes: number;
  /** The completion limit every round requests: a round that reaches it is truncated and its tool calls never run (TRUNCATED-TOOLCALL). */
  readonly completionLimitTokens: number;
  readonly compactionThresholdTokens?: number;
}

export function agentTurnAdmission(maxCompletionTokens: number, inputMaxBytes: number, compactionThresholdTokens?: number): AgentTurnAdmission {
  return Object.freeze({ outputReserveTokens: maxCompletionTokens, safetyReserveTokens: SAFETY_RESERVE_TOKENS, requestMaxBytes: inputMaxBytes,
    // Compaction headroom heuristic, not a token-to-byte guarantee. Exact JSON byte guards still admit each request.
    // Reserve an estimated answer and one user message of up to an eighth of the bound, at most 32 KiB.
    requestReserveBytes: maxCompletionTokens * 4 + Math.min(32_768, Math.floor(inputMaxBytes / 8)), completionLimitTokens: maxCompletionTokens,
    ...(compactionThresholdTokens === undefined ? {} : { compactionThresholdTokens }) });
}
