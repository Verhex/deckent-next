import { createHash } from 'node:crypto';
import { modelTextPrefix, type AgentToolCall, type AgentToolCallStatus, type AgentToolCleanup, type AgentTurnMessage } from '#domain/index.js';

/** TC-1 first slice: service-owned, turn-local context. Neither a persisted record nor an authority receipt. */
export const AGENT_CONTEXT_CARRY_VERSION = 1;
export const AGENT_CONTEXT_RENDER_VERSION = 1;

export interface AgentContextUserRecord {
  readonly source: 'request';
  readonly messageIndex: number;
  /** Opaque legacy input; never parse attachment labels or previous summaries into provenance. */
  readonly content: string;
}
export interface AgentContextCallRecord {
  readonly source: 'request' | 'execution';
  /** Request message position, or model round; provider ids alone are not unique. */
  readonly position: number;
  readonly index: number;
  readonly callId: string;
  readonly name: string;
  readonly argumentsExcerpt: string;
  readonly argumentsDigest: string;
  readonly execution: 'unknown' | 'invoked' | 'not-invoked';
  readonly status: AgentToolCallStatus | null;
  readonly cleanup: AgentToolCleanup | null;
}
export interface AgentContextCarry {
  readonly schemaVersion: typeof AGENT_CONTEXT_CARRY_VERSION;
  readonly users: readonly AgentContextUserRecord[];
  readonly calls: readonly AgentContextCallRecord[];
}

export function agentContextExcerpt(text: string, limit: number): string {
  return text.length <= limit ? text : `${modelTextPrefix(text, limit)} …[cut: ${text.length} characters, sha256 ${createHash('sha256').update(text).digest('hex').slice(0, 16)}]`;
}
const callRecord = (call: AgentToolCall, source: AgentContextCallRecord['source'], position: number, index: number,
  execution: AgentContextCallRecord['execution'], status: AgentToolCallStatus | null, cleanup: AgentToolCleanup | null): AgentContextCallRecord => Object.freeze({
  source, position, index, callId: call.id, name: call.name, argumentsExcerpt: agentContextExcerpt(call.argumentsJson, 200),
  argumentsDigest: createHash('sha256').update(`agent-context-arguments:1\0${call.argumentsJson}`).digest('hex'), execution, status, cleanup,
});

/**
 * Identity custody belongs to this loop invocation. Only original request objects and observed result objects can contribute;
 * a rendered projection, model summary, model-written provenance claim or engine note can never become a canonical user record.
 * Weak maps retain no old tool payloads. Folded records use the existing admission request byte bound when configured (production).
 */
export function createAgentContextCarry(messages: readonly AgentTurnMessage[]) {
  const users = new WeakMap<AgentTurnMessage, AgentContextUserRecord>();
  const calls = new WeakMap<AgentTurnMessage, readonly AgentContextCallRecord[]>();
  messages.forEach((message, messageIndex) => {
    if (message.role === 'user') users.set(message, Object.freeze({ source: 'request', messageIndex, content: message.content }));
    if (message.role === 'assistant') calls.set(message, Object.freeze(message.toolCalls.map((call, index) =>
      callRecord(call, 'request', messageIndex, index, 'unknown', null, null))));
  });
  let carry: AgentContextCarry = Object.freeze({ schemaVersion: AGENT_CONTEXT_CARRY_VERSION, users: Object.freeze([]), calls: Object.freeze([]) });
  return {
    /** Called only from the loop's actual result path, never inferred from tool text or a model answer. */
    observed(message: AgentTurnMessage, call: AgentToolCall, round: number, index: number, invoked: boolean,
      status: AgentToolCallStatus, cleanup: AgentToolCleanup | undefined) {
      calls.set(message, Object.freeze([callRecord(call, 'execution', round, index, invoked ? 'invoked' : 'not-invoked', status, cleanup ?? null)]));
    },
    /** Null is an explicit capacity refusal; no record is silently dropped and the prior carry stays intact. */
    fold(older: readonly AgentTurnMessage[], maxBytes?: number): AgentContextCarry | null {
      const next: AgentContextCarry = Object.freeze({ schemaVersion: AGENT_CONTEXT_CARRY_VERSION,
        users: Object.freeze([...carry.users, ...older.flatMap(message => users.has(message) ? [users.get(message)!] : [])]),
        calls: Object.freeze([...carry.calls, ...older.flatMap(message => calls.get(message) ?? [])]) });
      if (maxBytes !== undefined && Buffer.byteLength(JSON.stringify(next), 'utf8') > maxBytes) return null;
      for (const message of older) { users.delete(message); calls.delete(message); }
      carry = next;
      return carry;
    },
  };
}
