import { constants } from 'node:fs';
import { open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { agentTurnMessageSchema, type AgentTurnMessage } from '#domain/index.js';
import { redactText } from '#adapters/core/native-connection/index.js';

export const TERMINAL_SESSION_LIMITS = Object.freeze({ maxSessions: 50, maxFileBytes: 16 * 1024 * 1024, previewChars: 120 });
const sessionIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const snapshotSchema = z.object({ schemaVersion: z.literal(1), sessionId: sessionIdSchema, scopeId: z.string().min(1).max(256),
  updatedAtMs: z.number().int().nonnegative().safe(), messages: z.array(agentTurnMessageSchema).max(100_000) }).strict();
export type TerminalSessionSnapshot = z.infer<typeof snapshotSchema>;
export interface TerminalSessionSummary {
  readonly sessionId: string; readonly updatedAtMs: number; readonly messages: number; readonly preview: string;
}
export interface TerminalSessionStore {
  save(snapshot: TerminalSessionSnapshot): Promise<void>;
  /** Newest first, only this scope's sessions. */
  list(scopeId: string): Promise<readonly TerminalSessionSummary[]>;
  load(scopeId: string, sessionId: string): Promise<readonly AgentTurnMessage[] | null>;
}

// Known secret shapes and control characters only; the text is never shortened here (the store bounds the file instead).
const scrub = (text: string) => redactText(text, [], Number.MAX_SAFE_INTEGER);
const redacted = (message: AgentTurnMessage): AgentTurnMessage => message.role === 'assistant'
  ? { ...message, content: scrub(message.content), toolCalls: message.toolCalls.map(call => ({ ...call, argumentsJson: scrub(call.argumentsJson) })) }
  : { ...message, content: scrub(message.content) };

/**
 * Private per-project conversation snapshots (T-L5c, Jev 9ae569b1): one file per session holding the whole current history
 * (system prompt excluded), rewritten atomically after every turn — a compaction simply rewrites it, so a resumed session can
 * never carry pre-compaction messages twice (legacy defect). Owner-only (0600, no-follow), known secret shapes redacted before
 * writing, bounded in count (oldest removed) and size. Snapshots are context for a later turn, never authority.
 */
export function openTerminalSessionStore(directory: string, limits = TERMINAL_SESSION_LIMITS): TerminalSessionStore {
  const pathOf = (sessionId: string) => join(directory, `${sessionIdSchema.parse(sessionId)}.json`);
  const read = async (path: string): Promise<TerminalSessionSnapshot | null> => {
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limits.maxFileBytes) return null;
      const parsed = snapshotSchema.safeParse(JSON.parse(await handle.readFile({ encoding: 'utf8' })));
      return parsed.success ? parsed.data : null;
    } catch { return null; } finally { await handle.close(); }
  };
  const all = async (): Promise<TerminalSessionSnapshot[]> => {
    let names: string[];
    try { names = (await readdir(directory)).filter(name => name.endsWith('.json')); } catch { return []; }
    const snapshots = await Promise.all(names.map(name => read(join(directory, name))));
    return snapshots.filter((value): value is TerminalSessionSnapshot => value !== null).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  };
  const store: TerminalSessionStore = {
    async save(input) {
      // An oversized history is refused before any redaction work (redaction never grows text beyond a small constant).
      if (Buffer.byteLength(JSON.stringify(input.messages), 'utf8') > limits.maxFileBytes) throw new RangeError('TERMINAL_SESSION_TOO_LARGE');
      const snapshot = snapshotSchema.parse({ ...input, messages: input.messages.filter(message => message.role !== 'system').map(redacted) });
      const body = JSON.stringify(snapshot);
      if (Buffer.byteLength(body, 'utf8') > limits.maxFileBytes) throw new RangeError('TERMINAL_SESSION_TOO_LARGE');
      const target = pathOf(snapshot.sessionId), temporary = `${target}.${process.pid}.tmp`;
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
      const kept = await all();
      await Promise.all(kept.slice(limits.maxSessions).map(old => unlink(pathOf(old.sessionId)).catch(() => undefined)));
    },
    async list(scopeId) {
      return Object.freeze((await all()).filter(snapshot => snapshot.scopeId === scopeId).map(snapshot => {
        const first = snapshot.messages.find(message => message.role === 'user');
        return Object.freeze({ sessionId: snapshot.sessionId, updatedAtMs: snapshot.updatedAtMs, messages: snapshot.messages.length,
          preview: (first?.content ?? '').replace(/\s+/g, ' ').slice(0, limits.previewChars) });
      }));
    },
    async load(scopeId, sessionId) {
      if (!sessionIdSchema.safeParse(sessionId).success) return null;
      const snapshot = await read(pathOf(sessionId));
      return snapshot && snapshot.scopeId === scopeId && snapshot.sessionId === sessionId ? Object.freeze(snapshot.messages) : null;
    },
  };
  return Object.freeze(store);
}
