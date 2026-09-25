import { createHash } from 'node:crypto';
import type { AgentToolCallStatus, AgentTurnFinish, AgentTurnMessage } from '#domain/index.js';

export type AgentTurnStoreErrorCode = 'AGENT_TURN_IN_PROGRESS' | 'AGENT_TURN_CONFLICT' | 'AGENT_TURN_CORRUPT' | 'AGENT_TURN_UNAVAILABLE';
export class AgentTurnStoreError extends Error {
  constructor(readonly code: AgentTurnStoreErrorCode) { super(code); this.name = 'AgentTurnStoreError'; }
}

/** The durable outcome of a finished turn: what a replay of the same turn id returns without any model call. */
export interface AgentTurnOutcome {
  readonly finish: AgentTurnFinish;
  readonly note: string | null;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly appended: readonly AgentTurnMessage[];
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
  interruptRunning(atMs: number): Promise<number>;
}

export const agentTurnResultDigest = (text: string) => createHash('sha256').update(`agent-tool-result:1\0${text}`).digest('hex');
export const AGENT_TURN_INTERRUPTED_NOTE = 'The turn was interrupted by a runtime service restart; the tool calls it settled are recorded. Send the request again as a new turn.';
