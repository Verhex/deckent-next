import { createHash } from 'node:crypto';
import type { AgentToolCallStatus, AgentTurnFinish, AgentTurnMessage } from '#domain/index.js';

export type AgentTurnStoreErrorCode = 'AGENT_TURN_IN_PROGRESS' | 'AGENT_TURN_CONFLICT' | 'AGENT_TURN_CORRUPT' | 'AGENT_TURN_INVALID' | 'AGENT_TURN_UNAVAILABLE';
export class AgentTurnStoreError extends Error {
  constructor(readonly code: AgentTurnStoreErrorCode) { super(code); this.name = 'AgentTurnStoreError'; }
}

/** Largest final answer a finished turn keeps for replay; a larger one is recorded by size only. */
export const AGENT_TURN_ANSWER_MAX_BYTES = 262_144;
/**
 * The bounded durable outcome of a finished turn: what a replay of the same turn id returns without any model call. It keeps the
 * final answer (when it fits) and a digest of every appended message, never the tool results themselves (Jev 9df04efb): the
 * client received them as turn events; a replay honestly returns the final answer only.
 */
export interface AgentTurnOutcome {
  readonly finish: AgentTurnFinish;
  readonly note: string | null;
  readonly rounds: number;
  readonly toolCalls: number;
  /** Final assistant answer, or null when there is none or it exceeded AGENT_TURN_ANSWER_MAX_BYTES (see answerBytes). */
  readonly answer: string | null;
  readonly answerBytes: number;
  /** Digest of the canonical JSON of all appended messages, or null when the turn appended nothing. */
  readonly appendedDigest: string | null;
}
export interface AgentTurnClaim {
  readonly scopeId: string;
  readonly turnId: string;
  /** Stable principal identity (issuer + subject); a turn id is bound to the principal that started it. */
  readonly principalKey: string;
  /** Canonical digest of the request (messages, tools, model reference) computed by the composition, never by a model. */
  readonly requestDigest: string;
  readonly claimedAtMs: number;
}
/** One settled tool call of a turn: an audit projection (effectful tools will reference their C11 intent here). */
export interface AgentTurnToolCallRecord {
  readonly scopeId: string; readonly turnId: string; readonly round: number; readonly index: number;
  readonly callId: string; readonly tool: string; readonly toolVersion: number; readonly argsDigest: string | null;
  readonly target: string | null; readonly status: AgentToolCallStatus; readonly bytes: number; readonly resultDigest: string; readonly atMs: number;
}

/**
 * Durable turn identity (T-L3, Astra 2074 D3): UNIQUE(scope, turn). A first claim starts the turn; the same request of the same
 * principal after it finished returns the stored outcome (no second billed round); while it runs, a second claim is
 * AGENT_TURN_IN_PROGRESS; a different request or principal under the same id is AGENT_TURN_CONFLICT. Turns left running by a
 * stopped service are closed as interrupted at the next start, never resumed silently.
 */
export interface AgentTurnStore {
  claim(claim: AgentTurnClaim): Promise<{ readonly status: 'new' } | { readonly status: 'finished'; readonly outcome: AgentTurnOutcome }>;
  recordToolCall(record: AgentTurnToolCallRecord): Promise<void>;
  finish(scopeId: string, turnId: string, outcome: AgentTurnOutcome, atMs: number): Promise<void>;
  /** Closes every intact running turn; a damaged row is reported and left as it is, never blocking the others. */
  interruptRunning(atMs: number): Promise<{ readonly interrupted: number; readonly corrupt: readonly { readonly scopeId: string; readonly turnId: string }[] }>;
}

/** Bounded outcome of a loop result: the final answer when it fits, the appended messages by digest only. */
export function agentTurnOutcome(result: { readonly finish: AgentTurnFinish; readonly note: string | null; readonly rounds: number; readonly toolCalls: number;
  readonly appended: readonly AgentTurnMessage[] }): AgentTurnOutcome {
  const last = result.appended.at(-1), text = last?.role === 'assistant' && last.toolCalls.length === 0 && last.content ? last.content : null;
  const answerBytes = text === null ? 0 : Buffer.byteLength(text, 'utf8');
  return Object.freeze({ finish: result.finish, note: result.note, rounds: result.rounds, toolCalls: result.toolCalls,
    answer: answerBytes <= AGENT_TURN_ANSWER_MAX_BYTES ? text : null, answerBytes,
    appendedDigest: result.appended.length ? createHash('sha256').update(`agent-turn-appended:1\0${JSON.stringify(result.appended)}`).digest('hex') : null });
}
export const agentTurnResultDigest = (text: string) => createHash('sha256').update(`agent-tool-result:1\0${text}`).digest('hex');
export const AGENT_TURN_INTERRUPTED_NOTE = 'The turn was interrupted by a runtime service restart; the tool calls it settled are recorded. Send the request again as a new turn.';
