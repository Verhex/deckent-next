import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { redactText } from '#adapters/core/native-connection/index.js';

export interface TerminalHistoryEntry { readonly text: string; readonly pastes: readonly never[] }
export interface TerminalHistoryFile {
  load(): Promise<readonly TerminalHistoryEntry[]>;
  append(entry: { readonly text: string }): Promise<void>;
}
export const TERMINAL_HISTORY_LIMITS = Object.freeze({ maxEntries: 500, maxEntryBytes: 4096 });

/**
 * Private per-project composer history (0600, no-follow, append-only JSONL). Only the visible line is kept: pasted
 * content is never written (the composer shows chips for it) and known secret shapes are redacted before writing.
 * Load reads a bounded tail and compacts the file when it has grown to twice the entry limit. A failure never blocks
 * input; the composer treats history as a convenience.
 */
export function openTerminalHistoryFile(path: string, limits = TERMINAL_HISTORY_LIMITS): TerminalHistoryFile {
  const maxFileBytes = limits.maxEntries * 2 * (limits.maxEntryBytes + 32);
  const parse = (raw: string) => raw.split('\n').flatMap(line => {
    try {
      const value = JSON.parse(line) as { text?: unknown };
      return typeof value.text === 'string' && value.text.length > 0 ? [value.text] : [];
    } catch { return []; }
  });
  return {
    async load() {
      let handle;
      try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch { return []; }
      let texts: string[];
      try {
        const size = (await handle.stat()).size;
        const start = Math.max(0, size - maxFileBytes);
        const buffer = Buffer.alloc(size - start);
        await handle.read(buffer, 0, buffer.length, start);
        texts = parse(buffer.toString('utf8'));
      } finally { await handle.close(); }
      const kept = texts.slice(-limits.maxEntries);
      if (texts.length >= limits.maxEntries * 2) {
        const temporary = `${path}.${process.pid}.tmp`;
        const out = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await out.writeFile(kept.map(text => JSON.stringify({ text })).join('\n') + '\n'); await out.sync(); } finally { await out.close(); }
        await rename(temporary, path);
      }
      return Object.freeze(kept.map(text => Object.freeze({ text, pastes: [] as never[] })));
    },
    async append(entry) {
      const text = redactText(entry.text, [], limits.maxEntryBytes);
      if (!text.trim() || Buffer.byteLength(entry.text) > limits.maxEntryBytes) return;
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      try { await handle.write(JSON.stringify({ text }) + '\n'); } finally { await handle.close(); }
    },
  };
}
