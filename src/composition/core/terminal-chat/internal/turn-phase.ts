import type { AgentTurnMessage } from '#domain/index.js';
import { AGENT_COMPACTION_HIGH_WATER, planAgentCompaction, type AgentTurnAdmission } from '#engine/index.js';

/**
 * Whether the service summarizes older messages right after this measurement: the engine's own rule (high-water mark of the window
 * or of the request bound, room for the next request, something older than the kept tail) applied to the history the terminal holds,
 * which is exactly the history the service measured (the sent messages, every `message` event, a compaction's replacement). The
 * admission is the service's own (engine `agentTurnAdmission` from the same configuration); the service alone decides and compacts.
 */
export function terminalCompactionExpected(messages: readonly AgentTurnMessage[], measured: { readonly promptTokens: number; readonly windowTokens: number | null },
  admission: AgentTurnAdmission): boolean {
  const reserveTokens = admission.outputReserveTokens + admission.safetyReserveTokens;
  const tokenPressure = measured.windowTokens !== null && measured.promptTokens + reserveTokens > measured.windowTokens * AGENT_COMPACTION_HIGH_WATER;
  const bytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
  const bytePressure = bytes > admission.requestMaxBytes * AGENT_COMPACTION_HIGH_WATER || bytes + admission.requestReserveBytes > admission.requestMaxBytes;
  return (tokenPressure || bytePressure) && planAgentCompaction(messages) !== null;
}
