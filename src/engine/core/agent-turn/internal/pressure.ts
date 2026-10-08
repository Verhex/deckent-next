import { LOCALES, t, type Locale, type Params } from '#platform/index.js';
import type { AgentTurnAdmission } from './admission.js';
import type { AgentTurnMessage } from '#domain/index.js';
import { AGENT_COMPACTION_HIGH_WATER, planAgentCompaction } from './compaction.js';

export type AgentContextFailure = 'AGENT_CONTEXT_CARRY_TOO_LARGE' | 'AGENT_CONTEXT_REQUEST_TOO_LARGE' | 'AGENT_CONTEXT_WINDOW_EXCEEDED' | 'RUNTIME_CHAT_EVENT_TOO_LARGE';
const spendNotes = {
  PROVIDER_SPEND_EXHAUSTED: (locale: Locale) => t('error.PROVIDER_SPEND_EXHAUSTED', {}, locale),
  PROVIDER_SPEND_FROZEN: (locale: Locale) => t('error.PROVIDER_SPEND_FROZEN', {}, locale),
  PROVIDER_SPEND_UNAVAILABLE: (locale: Locale) => t('error.PROVIDER_SPEND_UNAVAILABLE', {}, locale),
  PROVIDER_SPEND_INVALID: (locale: Locale) => t('error.PROVIDER_SPEND_INVALID', {}, locale),
  PROVIDER_SPEND_CONFLICT: (locale: Locale) => t('error.PROVIDER_SPEND_CONFLICT', {}, locale),
  PROVIDER_SPEND_TARIFF_UNVERIFIED: (locale: Locale) => t('error.PROVIDER_SPEND_TARIFF_UNVERIFIED', {}, locale),
  PROVIDER_SPEND_BUDGET_ABSENT: (locale: Locale) => t('agent.spend.budgetAbsent', {}, locale),
  PROVIDER_SPEND_BUDGET_EXISTS: (locale: Locale) => t('error.PROVIDER_SPEND_BUDGET_EXISTS', {}, locale),
  PROVIDER_SPEND_RESULT_LIMIT: (locale: Locale) => t('error.PROVIDER_SPEND_RESULT_LIMIT', {}, locale),
} as const;
export function agentSpendFailureNote(code: string, language: Locale = LOCALES[0]): string | null {
  const note = Object.hasOwn(spendNotes, code) ? spendNotes[code as keyof typeof spendNotes] : null;
  return note ? `[deckent] ${code}: ${note(language)}` : null;
}

/** Existing done.note carrier: a stable code and catalog text, with no change to the wire or stored result shape. */
export function agentContextFailureNote(code: AgentContextFailure, language: Locale = LOCALES[0], params: Params = {}): string {
  const text = code === 'RUNTIME_CHAT_EVENT_TOO_LARGE' ? t('error.RUNTIME_CHAT_EVENT_TOO_LARGE', params, language)
    : code === 'AGENT_CONTEXT_CARRY_TOO_LARGE' ? t('agent.context.AGENT_CONTEXT_CARRY_TOO_LARGE', params, language)
    : code === 'AGENT_CONTEXT_REQUEST_TOO_LARGE' ? t('agent.context.AGENT_CONTEXT_REQUEST_TOO_LARGE', params, language)
    : t('agent.context.AGENT_CONTEXT_WINDOW_EXCEEDED', params, language);
  return `[deckent] ${code}: ${text}`;
}

/** Exact serialized history size; neither UTF-16 length nor a token-to-byte ratio is a capacity proof. */
export const agentHistoryBytes = (messages: readonly AgentTurnMessage[]): number => Buffer.byteLength(JSON.stringify(messages), 'utf8');

/**
 * Turn-local compaction progress. Never summarize only our own summary. If a replacement did not shrink the serialized history,
 * wait until its retained tail has moved out of the next tail before trying again. New content can then be compacted; this is not
 * a turn budget. Object identity is engine/stream owned, never inferred from user text or model-provided provenance.
 */
export function createAgentCompactionGuard() {
  const summaries = new WeakSet<AgentTurnMessage>();
  let stalledTail = new Set<AgentTurnMessage>();
  return {
    plan(messages: readonly AgentTurnMessage[]) {
      const plan = planAgentCompaction(messages);
      if (!plan || plan.older.every(message => summaries.has(message)) || plan.tail.some(message => stalledTail.has(message))) return null;
      return plan;
    },
    applied(before: readonly AgentTurnMessage[], after: readonly AgentTurnMessage[]) {
      const rest = after[0]?.role === 'system' ? after.slice(1) : after;
      const summary = rest[0];
      if (summary) summaries.add(summary);
      // On the client, wire decoding created new objects: keep identities from the replacement, not the previous history.
      stalledTail = new Set(agentHistoryBytes(after) >= agentHistoryBytes(before) ? rest.slice(1) : []);
    },
  };
}

/** Shared pressure predicate for the producer and its terminal phase projection; the service alone admits and compacts. */
export function agentCompactionExpected(messages: readonly AgentTurnMessage[], measured: { readonly promptTokens: number; readonly windowTokens: number | null },
  admission: AgentTurnAdmission): boolean {
  const reserveTokens = admission.outputReserveTokens + admission.safetyReserveTokens;
  const tokenPressure = (measured.windowTokens !== null && measured.promptTokens + reserveTokens > measured.windowTokens * AGENT_COMPACTION_HIGH_WATER)
    || (admission.compactionThresholdTokens !== undefined && measured.promptTokens >= admission.compactionThresholdTokens);
  const bytes = agentHistoryBytes(messages);
  const bytePressure = bytes > admission.requestMaxBytes * AGENT_COMPACTION_HIGH_WATER || bytes + admission.requestReserveBytes > admission.requestMaxBytes;
  return (tokenPressure || bytePressure) && planAgentCompaction(messages) !== null;
}
