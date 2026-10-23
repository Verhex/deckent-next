import { constants } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { z } from 'zod';
import { encodeCommandProjection, memoryPurgeRecordSchema, type MemoryPurgeRecord } from '#domain/index.js';
import { MemoryJournalError, type MemoryPurgeJournal } from '#engine/index.js';
import { withConfigWriteLock, type IntegrityAuthority } from '#platform/index.js';
import limits from './purge-limits.json' with { type: 'json' };

const SEAL = 'memory-purge-journal:1';
export const memoryPurgeJournalLimitsSchema = z.object({ fileName: z.string().regex(/^[a-z0-9.-]{1,64}$/u), maxLineBytes: z.number().int().positive().safe(),
  maxFileBytes: z.number().int().positive().safe(), maxEntries: z.number().int().positive().safe(), lockTimeoutMs: z.number().int().positive().safe() }).strict().readonly();
export type MemoryPurgeJournalLimits = z.infer<typeof memoryPurgeJournalLimitsSchema>;
export const MEMORY_PURGE_JOURNAL_LIMITS: MemoryPurgeJournalLimits = memoryPurgeJournalLimitsSchema.parse(limits);
const lineSchema = z.object({ record: z.unknown(), keyId: z.string().min(1), mac: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const unreadable = () => new MemoryJournalError('MEMORY_PURGE_REPLAY_HELD');

/**
 * S4B-4 (§6.6 restore safety): the sealed memory purge journal — append-only JSONL under the product state directory (`state/memory-purges`, not
 * a backup resource, so a backup restore leaves it in place), each line sealed with the installation integrity key, keyed digests and ids only.
 * Unlike a shadow store it never drops or skips a line: any unreadable, altered or oversized line (other than a torn final line, which is an
 * append that never returned) makes `list` throw, so the caller holds instead of un-purging. Bounds are data; past them an append is refused.
 * Mode 0600, no link followed; `directory` null: no journal exists yet (nothing purged), and a reader creates nothing.
 */
export class FileMemoryPurgeJournal implements MemoryPurgeJournal {
  private readonly limits: MemoryPurgeJournalLimits;
  constructor(private readonly directory: () => Promise<string | null>, private readonly integrity: () => Promise<IntegrityAuthority>,
    limits: MemoryPurgeJournalLimits = MEMORY_PURGE_JOURNAL_LIMITS) { this.limits = memoryPurgeJournalLimitsSchema.parse(limits); }
  private async read(path: string): Promise<{ records: MemoryPurgeRecord[]; torn: boolean }> {
    let handle: FileHandle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], torn: false }; throw unreadable(); }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > this.limits.maxFileBytes + this.limits.maxLineBytes) throw unreadable();
      const buffer = Buffer.alloc(info.size);
      if (info.size) await handle.read(buffer, 0, info.size, 0);
      const text = buffer.toString('utf8'), lines = text.split('\n'), torn = text !== '' && !text.endsWith('\n');
      const complete = torn ? lines.slice(0, -1) : lines, records: MemoryPurgeRecord[] = [], integrity = complete.some(Boolean) ? await this.integrity() : null;
      for (const line of complete) {
        if (!line) continue;
        if (Buffer.byteLength(line) > this.limits.maxLineBytes) throw unreadable();
        let row;
        try { row = lineSchema.parse(JSON.parse(line)); } catch { throw unreadable(); }
        const record = memoryPurgeRecordSchema.safeParse(row.record);
        if (!record.success || !integrity!.verify(encodeCommandProjection(SEAL, record.data), row.mac, row.keyId)) throw unreadable();
        records.push(record.data);
      }
      return { records, torn };
    } finally { await handle.close(); }
  }
  async list(): Promise<readonly MemoryPurgeRecord[]> {
    const root = await this.directory();
    return root === null ? [] : Object.freeze((await this.read(join(root, this.limits.fileName))).records);
  }
  async append(input: MemoryPurgeRecord): Promise<{ readonly replayed: boolean }> {
    const record = memoryPurgeRecordSchema.parse(input), root = await this.directory();
    if (root === null) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
    const integrity = await this.integrity();
    const line = `${JSON.stringify({ record, keyId: integrity.keyId, mac: integrity.sign(encodeCommandProjection(SEAL, record)) })}\n`;
    if (Buffer.byteLength(line) > this.limits.maxLineBytes) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = join(root, this.limits.fileName);
    return withConfigWriteLock(path, async () => {
      const current = await this.read(path), prior = current.records.find(row => row.purgeId === record.purgeId && row.scopeId === record.scopeId);
      if (prior) { if (!isDeepStrictEqual(prior, record)) throw new MemoryJournalError('MEMORY_COMMAND_CONFLICT'); return { replayed: true }; }
      if (current.records.length >= this.limits.maxEntries) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
      const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size + Buffer.byteLength(line) > this.limits.maxFileBytes) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
        await handle.chmod(0o600);
        // A torn tail (an append that never returned) is closed first so the new line stays whole; the torn bytes are never a record.
        await handle.writeFile(current.torn ? `\n${line}` : line);
        await handle.sync();
      } finally { await handle.close(); }
      return { replayed: false };
    }, this.limits.lockTimeoutMs, { onWarning() { /* a person's purge card prints its own outcome */ } });
  }
}
