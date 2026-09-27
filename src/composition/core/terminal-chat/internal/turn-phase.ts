import type { AgentTurnMessage } from '#domain/index.js';
import { AGENT_COMPACTION_HIGH_WATER, planAgentCompaction } from '#engine/index.js';

/**
 * What the runtime service admits a terminal turn with (composition/agent-turn `runPeerConfiguredChatTurn`), from the same
 * configuration: the tokens a round keeps free, the service input bound and the room the next request needs. The terminal uses it
 * only to name a phase it cannot see (TL-A, protocol v15 unchanged); the service alone decides and compacts.
 */
export interface TerminalTurnAdmission { readonly reserveTokens: number; readonly requestMaxBytes: number; readonly requestReserveBytes: number }

/** The service's safety reserve (`CHAT_TURN_SAFETY_RESERVE_TOKENS`); that unit imports this one, so the value is mirrored here and
 * held equal by the parity test against the real runtime service (tests/contracts/composition/terminal-turn-phases.test.ts). */
const SAFETY_RESERVE_TOKENS = 2_048;

export function terminalTurnAdmission(maxCompletionTokens: number, inputMaxBytes: number): TerminalTurnAdmission {
  return Object.freeze({ reserveTokens: maxCompletionTokens + SAFETY_RESERVE_TOKENS, requestMaxBytes: inputMaxBytes,
    // The longest answer (a token is at most 4 UTF-8 bytes) and one user message of up to an eighth of the bound, at most 32 KiB.
    requestReserveBytes: maxCompletionTokens * 4 + Math.min(32_768, Math.floor(inputMaxBytes / 8)) });
}

/**
 * Whether the service summarizes older messages right after this measurement: the engine's own rule (high-water mark of the window
 * or of the request bound, room for the next request, something older than the kept tail) applied to the history the terminal holds,
 * which is exactly the history the service measured (the sent messages, every `message` event, a compaction's replacement).
 */
export function terminalCompactionExpected(messages: readonly AgentTurnMessage[], measured: { readonly promptTokens: number; readonly windowTokens: number | null },
  admission: TerminalTurnAdmission): boolean {
  const tokenPressure = measured.windowTokens !== null && measured.promptTokens + admission.reserveTokens > measured.windowTokens * AGENT_COMPACTION_HIGH_WATER;
  const bytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
  const bytePressure = bytes > admission.requestMaxBytes * AGENT_COMPACTION_HIGH_WATER || bytes + admission.requestReserveBytes > admission.requestMaxBytes;
  return (tokenPressure || bytePressure) && planAgentCompaction(messages) !== null;
}
