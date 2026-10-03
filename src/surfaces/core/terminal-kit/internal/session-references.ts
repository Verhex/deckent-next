import type { AgentChatMessage } from './turn-stream.js';

export interface ConversationSessionSummary { readonly sessionId: string; readonly updatedAtMs: number; readonly messages: number; readonly preview: string }
/** Conversation snapshots of this scope (T-L5c); the caller binds the scope. Snapshots are context, never authority. */
export interface ConversationSessionPort {
  save(input: { readonly sessionId: string; readonly messages: readonly AgentChatMessage[] }): Promise<void>;
  list(): Promise<readonly ConversationSessionSummary[]>;
  load(sessionId: string): Promise<readonly AgentChatMessage[] | null>;
}
/** The executable's scope-explicit session store; `bindSessionScope` makes the workline port of one scope. */
export interface TerminalSessionStoreView {
  save(snapshot: { readonly schemaVersion: 1; readonly sessionId: string; readonly scopeId: string; readonly updatedAtMs: number;
    readonly messages: readonly AgentChatMessage[] }): Promise<void>;
  list(scopeId: string): Promise<readonly ConversationSessionSummary[]>;
  load(scopeId: string, sessionId: string): Promise<readonly AgentChatMessage[] | null>;
}
export function bindSessionScope(store: TerminalSessionStoreView, scopeId: string, now: () => number = Date.now): ConversationSessionPort {
  return Object.freeze({ save: (input: { readonly sessionId: string; readonly messages: readonly AgentChatMessage[] }) =>
    store.save({ schemaVersion: 1, sessionId: input.sessionId, scopeId, updatedAtMs: now(), messages: input.messages }),
  list: () => store.list(scopeId), load: (sessionId: string) => store.load(scopeId, sessionId) });
}
export type SessionRefusal = 'SESSION_REFERENCE_EXACT_REQUIRED' | 'SESSION_LIST_STALE' | 'SESSION_NOT_FOUND';
type SessionReference = Readonly<{ target: string } | { refusal: Exclude<SessionRefusal, 'SESSION_NOT_FOUND'> }>;
const EXACT_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Pure reference resolution; the session hook owns fresh queries, loading and context replacement. */
export function resolveSessionReference(ref: string, shown: readonly ConversationSessionSummary[], fresh: readonly ConversationSessionSummary[]): SessionReference {
  if (!/^\d+$/.test(ref)) return EXACT_SESSION_ID.test(ref) ? { target: ref } : { refusal: 'SESSION_REFERENCE_EXACT_REQUIRED' };
  const index = Number(ref), row = /^[1-9]\d*$/.test(ref) && Number.isSafeInteger(index) ? shown[index - 1] : undefined;
  const unchanged = shown.length === fresh.length && shown.every((before, i) => {
    const after = fresh[i]!;
    return before.sessionId === after.sessionId && before.updatedAtMs === after.updatedAtMs && before.messages === after.messages && before.preview === after.preview;
  });
  return row && unchanged ? { target: row.sessionId } : { refusal: 'SESSION_LIST_STALE' };
}
