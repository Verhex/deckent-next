import type { WorkLedgerEntry } from './work-ledger.js';

/**
 * Ink `Static` prints each item once and tracks progress by array length, so a trimmed-but-constant-length array
 * stops printing. The buffer only appends; after a commit has printed every pending row, the view compacts by
 * starting a new epoch (a fresh `Static`) that holds only rows appended after that commit.
 */
export type LedgerRow = Readonly<{ seq: number; entry: WorkLedgerEntry }>;
export type LedgerBuffer = Readonly<{ epoch: number; nextSeq: number; pending: readonly LedgerRow[]; tail: readonly WorkLedgerEntry[] }>;

export const LEDGER_TAIL_LIMIT = 200;
export const LEDGER_COMPACT_AT = 64;

export const EMPTY_LEDGER: LedgerBuffer = Object.freeze({ epoch: 0, nextSeq: 0, pending: Object.freeze([]), tail: Object.freeze([]) });

export function appendLedger(buffer: LedgerBuffer, entries: readonly WorkLedgerEntry[], tailLimit = LEDGER_TAIL_LIMIT): LedgerBuffer {
  if (entries.length === 0) return buffer;
  const rows = entries.map((entry, index) => Object.freeze({ seq: buffer.nextSeq + index, entry }));
  const tail = [...buffer.tail, ...entries];
  return Object.freeze({ epoch: buffer.epoch, nextSeq: buffer.nextSeq + entries.length, pending: Object.freeze([...buffer.pending, ...rows]),
    tail: Object.freeze(tail.length > tailLimit ? tail.slice(-tailLimit) : tail) });
}

/** `printed` is the pending length observed at a commit; rows appended after that commit stay pending. */
export function compactLedger(buffer: LedgerBuffer, printed: number, compactAt = LEDGER_COMPACT_AT): LedgerBuffer {
  if (printed < compactAt || printed > buffer.pending.length) return buffer;
  return Object.freeze({ ...buffer, epoch: buffer.epoch + 1, pending: Object.freeze(buffer.pending.slice(printed)) });
}

export type ChatTurnMessage = Readonly<{ role: 'system' | 'user' | 'assistant'; content: string }>;

/** Keeps the system instruction and the newest messages; `limit` counts every message including the system one. */
export function boundChatHistory(system: ChatTurnMessage, history: readonly ChatTurnMessage[], limit: number): readonly ChatTurnMessage[] {
  const recent = history.filter(message => message.role !== 'system');
  return Object.freeze([system, ...recent.slice(-Math.max(1, limit - 1))]);
}
