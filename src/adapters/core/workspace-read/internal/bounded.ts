import type { FileHandle } from 'node:fs/promises';

// Ported from the legacy terminal (deckent-dev src/cli/repl/native-read-file.ts, native-grep.ts): every rendered result is
// bounded by construction, long lines are elided behind a marker that names the exact continuation, nothing is silently cut.
// The `[deckent] …` meta lines and markers are model-facing protocol strings, not user-facing text.

/** Longest UTF-8-valid prefix of at most `maxBytes`. */
export function sliceUtf8(buf: Buffer, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (buf.byteLength <= maxBytes) return buf.toString('utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/** CRLF/CR are normalized so line numbers match editors; a trailing newline ends the last line (cat -n semantics). */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface BoundedLine { readonly text: string; readonly elidedBytes: number }

function alignUtf8Start(buf: Buffer, offset: number): number {
  let start = Math.min(Math.max(0, offset), buf.byteLength);
  while (start > 0 && start < buf.byteLength && (buf[start]! & 0xc0) === 0x80) start--;
  return start;
}

/**
 * One line within `maxBytesPerLine`, starting at `byteOffset`. When bytes remain past the window the line carries a marker
 * with the exact arguments that fetch the rest (the legacy re-read loop came from cuts that did not say how to continue).
 */
export function boundLine(line: string, lineNumber: number, byteOffset: number, maxBytesPerLine: number): BoundedLine {
  const buf = Buffer.from(line, 'utf8'), total = buf.byteLength;
  if (byteOffset >= total && total > 0) return { text: `[… line ${lineNumber} has ${total} bytes; lineByteOffset ${byteOffset} is past its end]`, elidedBytes: 0 };
  const start = alignUtf8Start(buf, byteOffset), window = buf.subarray(start);
  const prefix = start > 0 ? `[… ${start} bytes before lineByteOffset] ` : '';
  if (window.byteLength <= maxBytesPerLine) return { text: `${prefix}${window.toString('utf8')}`, elidedBytes: 0 };
  const marker = (elided: number, next: number) => `[… ${elided} bytes elided; re-read {startLine: ${lineNumber}, endLine: ${lineNumber}, lineByteOffset: ${next}}]`;
  const budget = Math.max(1, maxBytesPerLine - Buffer.byteLength(prefix, 'utf8') - Buffer.byteLength(marker(total, total), 'utf8') - 1);
  const head = sliceUtf8(window, budget), next = start + Buffer.byteLength(head, 'utf8');
  return { text: `${prefix}${head} ${marker(total - next, next)}`, elidedBytes: total - next };
}

export type ReadSkipKind = 'binary' | 'too-large' | 'read-error' | 'cancelled';
export type BoundedRead = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly kind: ReadSkipKind; readonly detail: string };

const BINARY_PROBE_BYTES = 8192, READ_CHUNK_BYTES = 1 << 20;
/**
 * Reads an already opened and checked regular file (see scope.open / openWalkedFile): allocation capped at the file size, size
 * and mtime compared before and after (a file changed while reading is reported, not returned), NUL bytes mean binary, the
 * signal is honoured between chunks. The handle is always closed.
 */
export async function readBoundedTextFile(handle: FileHandle, maxFileBytes: number, signal?: AbortSignal): Promise<BoundedRead> {
  try {
    const before = await handle.stat();
    if (before.size > maxFileBytes) return { ok: false, kind: 'too-large', detail: `${before.size} bytes > limit ${maxFileBytes}` };
    const buf = Buffer.alloc(before.size + 1);
    let read = 0;
    while (read < buf.length) {
      if (signal?.aborted) return { ok: false, kind: 'cancelled', detail: 'cancelled' };
      const { bytesRead } = await handle.read(buf, read, Math.min(READ_CHUNK_BYTES, buf.length - read), null);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const after = await handle.stat();
    if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || read !== before.size) {
      return { ok: false, kind: 'read-error', detail: 'file changed during read' };
    }
    const body = buf.subarray(0, read);
    if (body.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { ok: false, kind: 'binary', detail: 'contains NUL byte' };
    return { ok: true, text: body.toString('utf8') };
  } catch { return { ok: false, kind: 'read-error', detail: 'read failed' }; }
  finally { await handle.close().catch(() => undefined); }
}
