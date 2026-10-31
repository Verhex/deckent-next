import type { AgentChatMessage } from './turn-stream.js';

export interface ConversationSessionSummary { readonly sessionId: string; readonly updatedAtMs: number; readonly messages: number; readonly preview: string;
  /** The person's own name for the conversation (`/rename`); the picker shows it in place of the first message. */ readonly title?: string }
/** Conversation snapshots of this scope (T-L5c); the caller binds the scope. Snapshots are context, never authority. */
export interface ConversationSessionPort {
  save(input: { readonly sessionId: string; readonly messages: readonly AgentChatMessage[] }): Promise<void>;
  list(allFolders?: boolean): Promise<readonly ConversationSessionSummary[]>;
  load(sessionId: string): Promise<readonly AgentChatMessage[] | null>;
  /** Names one saved conversation; false when it is not saved (yet). Absent where the store cannot name sessions. */
  rename?(sessionId: string, title: string): Promise<boolean>;
}
/** The executable's scope-explicit session store; `bindSessionScope` makes the workline port of one scope. */
export interface TerminalSessionStoreView {
  save(snapshot: { readonly schemaVersion: 1; readonly sessionId: string; readonly scopeId: string; readonly updatedAtMs: number;
    readonly messages: readonly AgentChatMessage[] }): Promise<void>;
  list(scopeId: string, filter?: Readonly<{ allFolders?: boolean }>): Promise<readonly ConversationSessionSummary[]>;
  load(scopeId: string, sessionId: string): Promise<readonly AgentChatMessage[] | null>;
  rename?(scopeId: string, sessionId: string, title: string): Promise<boolean>;
}
export function bindSessionScope(store: TerminalSessionStoreView, scopeId: string, now: () => number = Date.now): ConversationSessionPort {
  return Object.freeze({ save: (input: { readonly sessionId: string; readonly messages: readonly AgentChatMessage[] }) =>
    store.save({ schemaVersion: 1, sessionId: input.sessionId, scopeId, updatedAtMs: now(), messages: input.messages }),
  list: (allFolders?: boolean) => allFolders ? store.list(scopeId, { allFolders: true }) : store.list(scopeId), load: (sessionId: string) => store.load(scopeId, sessionId),
    ...(store.rename ? { rename: (sessionId: string, title: string) => store.rename!(scopeId, sessionId, title) } : {}) });
}
/** alpha.60 B: the store opened on its first use, after the first frame; one that does not open is an empty one (sessions never block the terminal). */
export function lazySessionStore(open: () => Promise<TerminalSessionStoreView | null>): TerminalSessionStoreView {
  let opened: Promise<TerminalSessionStoreView | null> | undefined; const store = () => opened ??= open().catch(() => null);
  return { save: async snapshot => { await (await store())?.save(snapshot); }, list: async (scopeId, filter) => await (await store())?.list(scopeId, filter) ?? [],
    load: async (scopeId, sessionId) => await (await store())?.load(scopeId, sessionId) ?? null, rename: async (scopeId, sessionId, title) => await (await store())?.rename?.(scopeId, sessionId, title) ?? false };
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
