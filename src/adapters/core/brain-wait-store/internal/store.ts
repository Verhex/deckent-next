import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { brainQuotaWaitRecordSchema, encodeCommandProjection, type BrainQuotaWaitRecord, type BrainQuotaWaitStore } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import limits from './limits.json' with { type: 'json' };

/** Store bounds (data, not code): how many waits are kept, how large one file may be, and how long past its planned end a left-behind record is shown. */
export const brainQuotaWaitStoreLimitsSchema = z.object({ maxEntries: z.number().int().positive().safe(), maxFileBytes: z.number().int().positive().safe(),
  staleAfterMs: z.number().int().nonnegative().safe() }).strict().readonly();
export type BrainQuotaWaitStoreLimits = z.infer<typeof brainQuotaWaitStoreLimitsSchema>;
export const BRAIN_QUOTA_WAIT_STORE_LIMITS: BrainQuotaWaitStoreLimits = brainQuotaWaitStoreLimitsSchema.parse(limits);
const fileSchema = z.object({ schemaVersion: z.literal(1), record: z.unknown(), expiresAtMs: z.number().int().nonnegative().safe(),
  writer: z.object({ pid: z.number().int().positive().safe(), host: z.string().min(1).max(255) }).strict() }).strict();
const RECORD_FILE = /^[a-f0-9]{64}\.json$/u, TEMPORARY_FILE = /^\.[a-f0-9]{64}\.json\.[0-9a-f-]{36}\.tmp$/u;
/** What a reader sees: the live waits (oldest first) and whether the directory held more files than the bound lets it read. */
export type BrainQuotaWaitListing = Readonly<{ records: readonly BrainQuotaWaitRecord[]; truncated: boolean }>;
type Stored = Readonly<{ record: BrainQuotaWaitRecord; expiresAtMs: number; writer: Readonly<{ pid: number; host: string }> }>;

const recordFile = (scopeId: string, commandId: string) => `${sha256(encodeCommandProjection('brain-quota-wait:1', { scopeId, commandId }))}.json`;
/** A writer process on this host that no longer exists left its record behind (a crash); another host's writer cannot be checked here. */
function writerGone(writer: Stored['writer']): boolean {
  if (writer.host !== hostname()) return false;
  try { process.kill(writer.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
/** One record file, read without following a link and never past the bound; anything else (missing, oversized, damaged, foreign) is null. */
async function readRecordFile(path: string, maxBytes: number): Promise<Stored | null> {
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    const buffer = Buffer.alloc(info.size);
    if (info.size) await handle.read(buffer, 0, info.size, 0);
    const file = fileSchema.parse(JSON.parse(buffer.toString('utf8'))), record = brainQuotaWaitRecordSchema.parse(file.record);
    return Object.freeze({ record, expiresAtMs: file.expiresAtMs, writer: file.writer });
  } catch { return null; } finally { await handle.close(); }
}

/**
 * f4 item 1: active Brain quota waits as host state (`state/brain-waits`), outside the ledger — presence, not evidence. One 0600 file per plan
 * command (scope + command id), replaced atomically (temporary file, fsync, rename) and removed when the wait ends. A record is shown only until
 * its planned end plus `staleAfterMs`, and not at all once its writer process on this host is gone, so a crash never leaves a wait on screen.
 * The writer prunes stale, damaged and foreign files before it writes; a reader (the observe-only monitor) creates and deletes nothing.
 * `directory` answers null when the store does not exist yet: nothing waits.
 */
export class FileBrainQuotaWaitStore implements BrainQuotaWaitStore {
  private readonly limits: BrainQuotaWaitStoreLimits;
  constructor(private readonly directory: () => Promise<string | null>, private readonly now: () => number = Date.now,
    limits: BrainQuotaWaitStoreLimits = BRAIN_QUOTA_WAIT_STORE_LIMITS) { this.limits = brainQuotaWaitStoreLimitsSchema.parse(limits); }
  private live(stored: Stored | null, at: number): stored is Stored { return stored !== null && at < stored.expiresAtMs && !writerGone(stored.writer); }
  private async names(root: string): Promise<string[]> {
    try { return (await readdir(root)).filter(name => RECORD_FILE.test(name)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async list(): Promise<BrainQuotaWaitListing> {
    const root = await this.directory();
    if (root === null) return Object.freeze({ records: Object.freeze([]), truncated: false });
    const names = await this.names(root), at = this.now(), records: BrainQuotaWaitRecord[] = [];
    for (const name of names.slice(0, this.limits.maxEntries)) {
      const stored = await readRecordFile(join(root, name), this.limits.maxFileBytes);
      if (this.live(stored, at)) records.push(stored.record);
    }
    return Object.freeze({ records: Object.freeze(records.sort((a, b) => a.sinceMs - b.sinceMs)), truncated: names.length > this.limits.maxEntries });
  }
  async begin(input: BrainQuotaWaitRecord): Promise<void> {
    const record = brainQuotaWaitRecordSchema.parse(input), root = await this.directory();
    if (root === null) throw new Error('BRAIN_QUOTA_WAIT_STORE_UNAVAILABLE');
    const at = this.now(), target = recordFile(record.scopeId, record.commandId);
    let kept = 0;
    for (const name of await this.names(root)) {
      if (name === target) continue;
      if (this.live(await readRecordFile(join(root, name), this.limits.maxFileBytes), at)) kept++;
      else await unlink(join(root, name)).catch(() => undefined);
    }
    // A temporary file a crashed writer left is removed once it is older than the stale bound (a younger one may be another writer's).
    for (const name of (await readdir(root)).filter(entry => TEMPORARY_FILE.test(entry))) {
      const info = await lstat(join(root, name)).catch(() => null);
      if (info && at - info.mtimeMs > this.limits.staleAfterMs) await unlink(join(root, name)).catch(() => undefined);
    }
    if (kept >= this.limits.maxEntries) throw new Error('BRAIN_QUOTA_WAIT_STORE_FULL');
    const text = JSON.stringify({ schemaVersion: 1, record, expiresAtMs: record.untilMs + this.limits.staleAfterMs, writer: { pid: process.pid, host: hostname() } });
    if (Buffer.byteLength(text) > this.limits.maxFileBytes) throw new Error('BRAIN_QUOTA_WAIT_RECORD_LIMIT');
    const temporary = join(root, `.${target}.${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, join(root, target)); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
  async end(scopeId: string, commandId: string): Promise<void> {
    const root = await this.directory();
    if (root === null) return;
    await unlink(join(root, recordFile(scopeId, commandId))).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
