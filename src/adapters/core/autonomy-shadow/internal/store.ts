import { constants } from 'node:fs';
import { open, rename, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { autonomyShadowDigest, autonomyShadowRecordSchema, type AutonomyShadowRecord, type AutonomyShadowStore } from '#engine/index.js';
import { withConfigWriteLock } from '#platform/index.js';
import limits from './limits.json' with { type: 'json' };

/** Store bounds (data, not code): one active file plus one rotated predecessor, so the store never exceeds two files of `maxFileBytes`. */
export const autonomyShadowStoreLimitsSchema = z.object({ fileName: z.string().regex(/^[a-z0-9.-]{1,64}$/u), maxLineBytes: z.number().int().positive().safe(),
  maxFileBytes: z.number().int().positive().safe(), maxFileEntries: z.number().int().positive().safe(), lockTimeoutMs: z.number().int().positive().safe() }).strict().readonly();
export type AutonomyShadowStoreLimits = z.infer<typeof autonomyShadowStoreLimitsSchema>;
export const AUTONOMY_SHADOW_STORE_LIMITS: AutonomyShadowStoreLimits = autonomyShadowStoreLimitsSchema.parse(limits);
const lineSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u), record: z.unknown() }).strict();

type Read = { records: AutonomyShadowRecord[]; entries: number; bytes: number; endsWithNewline: boolean };
/** Reads one store file without following a link; bytes past the bound and every line whose digest or schema fails are skipped, never trusted. */
async function readStoreFile(path: string, bound: number): Promise<Read> {
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], entries: 0, bytes: 0, endsWithNewline: true }; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('AUTONOMY_SHADOW_UNSAFE');
    const size = Math.min(info.size, bound), buffer = Buffer.alloc(size);
    if (size) await handle.read(buffer, 0, size, 0);
    const text = buffer.toString('utf8'), lines = text.split('\n'), records: AutonomyShadowRecord[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const row = lineSchema.parse(JSON.parse(line)), record = autonomyShadowRecordSchema.parse(row.record);
        if (autonomyShadowDigest(record) === row.sha256) records.push(record);
      } catch { /* damaged or altered line: not a record */ }
    }
    return { records, entries: lines.filter(Boolean).length, bytes: info.size, endsWithNewline: text === '' || text.endsWith('\n') };
  } finally { await handle.close(); }
}

/**
 * Bounded append-only JSONL store of autonomy shadow records (OTONOM-TESLIM, alpha.53 law-audit fold 1), under the product state directory and
 * outside the audit chain. One writer turn at a time (file lock); idempotent by record id within the retained files; mode 0600; no link followed.
 * `directory` answers null when the store does not exist yet: a reader then sees no record and creates nothing.
 */
export class FileAutonomyShadowStore implements AutonomyShadowStore {
  private readonly limits: AutonomyShadowStoreLimits;
  constructor(private readonly directory: () => Promise<string | null>, limits: AutonomyShadowStoreLimits = AUTONOMY_SHADOW_STORE_LIMITS) {
    this.limits = autonomyShadowStoreLimitsSchema.parse(limits);
  }
  private files(root: string) { const active = join(root, this.limits.fileName); return { active, previous: `${active}.1` }; }
  private bound() { return this.limits.maxFileBytes + this.limits.maxLineBytes; }
  async latest(scopeId: string, commandId: string): Promise<AutonomyShadowRecord | null> {
    const root = await this.directory();
    if (root === null) return null;
    const { active, previous } = this.files(root);
    let best: AutonomyShadowRecord | null = null;
    for (const path of [previous, active]) for (const record of (await readStoreFile(path, this.bound())).records)
      if (record.scopeId === scopeId && record.commandId === commandId && (!best || record.revision >= best.revision)) best = record;
    return best;
  }
  async append(input: AutonomyShadowRecord): Promise<'written' | 'exists'> {
    const record = autonomyShadowRecordSchema.parse(input), line = `${JSON.stringify({ sha256: autonomyShadowDigest(record), record })}\n`;
    if (Buffer.byteLength(line) > this.limits.maxLineBytes) throw new Error('AUTONOMY_SHADOW_LINE_LIMIT');
    const root = await this.directory();
    if (root === null) throw new Error('AUTONOMY_SHADOW_UNAVAILABLE');
    const { active, previous } = this.files(root);
    return withConfigWriteLock(active, async () => {
      const older = await readStoreFile(previous, this.bound()), current = await readStoreFile(active, this.bound());
      if ([...older.records, ...current.records].some(row => row.id === record.id)) return 'exists' as const;
      const rotate = current.entries > 0 && (current.bytes + Buffer.byteLength(line) > this.limits.maxFileBytes || current.entries >= this.limits.maxFileEntries);
      if (rotate) await rename(active, previous);
      const handle = await open(active, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        if (!(await handle.stat()).isFile()) throw new Error('AUTONOMY_SHADOW_UNSAFE');
        await handle.chmod(0o600);
        // A torn tail (crash mid-line) is closed first so the new line stays whole; the torn bytes stay unreadable as a record.
        await handle.writeFile(!rotate && !current.endsWithNewline ? `\n${line}` : line);
        await handle.sync();
      } finally { await handle.close(); }
      return 'written' as const;
    }, this.limits.lockTimeoutMs, { onWarning() { /* the queue service turn never prints a lock warning */ } });
  }
}
