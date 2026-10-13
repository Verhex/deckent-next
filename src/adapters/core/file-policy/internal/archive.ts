import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, opendir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Authority revision archive (POLICY-ADMIN P2, file-based, no schema bump): one record per authority write with the effective revision
 * and the full policy/bindings documents before and after — the material a revert re-applies as a new change. `prepared` is written
 * before the first rename, `committed` after the last; a keyed record (the C11 wire key) is the target's idempotency evidence.
 * It lives under the installation's registered `audit` resource (never opened to the agent tools). Not tamper-evident and without
 * retention: a sealed append-only archive (ledger) is the recorded next option.
 */
const side = z.object({ revision: z.string().min(1).max(256), policy: z.unknown(), bindings: z.unknown() }).strict();
const entrySchema = z.object({ schemaVersion: z.literal(1), key: z.string().nullable(), state: z.enum(['prepared', 'committed']), before: side, after: side }).strict();
export type AuthorityArchiveEntry = z.infer<typeof entrySchema>;
const keySchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const archiveKeyName = (key: string) => `k-${keySchema.parse(key)}.json`;

export class AuthorityArchive {
  constructor(private readonly directory: string, private readonly ownerUid: number, private readonly unsafe: () => Error) {}
  private async ready() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.ownerUid || (stat.mode & 0o077) !== 0) throw this.unsafe();
  }
  /** Atomic replacement of one record (O_EXCL temporary, fsync, rename, directory fsync): a crash leaves the old or the new record. */
  async write(name: string, entry: AuthorityArchiveEntry): Promise<void> {
    await this.ready();
    const path = join(this.directory, name), temporary = join(this.directory, `.${name}.${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let renamed = false;
    try {
      try { await handle.writeFile(`${JSON.stringify(entrySchema.parse(entry))}\n`); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path); renamed = true;
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { if (!renamed) await unlink(temporary).catch(() => undefined); }
  }
  /** Bounded, read-only history: directory names and total retained bytes share the policy source's byte budget. */
  async history(maxBytes: number): Promise<readonly AuthorityArchiveEntry[] | null> {
    try {
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== this.ownerUid || (directory.mode & 0o077) !== 0) return null;
      const entries: AuthorityArchiveEntry[] = []; let bytes = 0;
      const handle = await opendir(this.directory);
      for await (const item of handle) {
        bytes += Buffer.byteLength(item.name);
        if (bytes > maxBytes) return null;
        if (!/^[kr]-[A-Za-z0-9_-]+\.json$/.test(item.name)) continue;
        const file = await open(join(this.directory, item.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          bytes += stat.size;
          if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.ownerUid || (stat.mode & (constants.S_IRWXG | constants.S_IRWXO)) !== 0 || bytes > maxBytes) return null;
          const buffer = Buffer.alloc(stat.size); let offset = 0;
          while (offset < buffer.length) { const chunk = await file.read(buffer, offset, buffer.length - offset, offset); if (!chunk.bytesRead) break; offset += chunk.bytesRead; }
          const value = entrySchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer))), after = await file.stat();
          if (!value.success || offset !== buffer.length || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) return null;
          if (value.data.state === 'committed') entries.push(value.data);
        } finally { await file.close(); }
      }
      return entries;
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null; }
  }
  async remove(name: string): Promise<void> { await unlink(join(this.directory, name)).catch(() => undefined); }
  /** The keyed record, `missing`, or null when it cannot be trusted (unreadable, torn, a link, foreign). */
  async read(key: string): Promise<AuthorityArchiveEntry | 'missing' | null> {
    const path = join(this.directory, archiveKeyName(key));
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== this.ownerUid) return null;
      const parsed = entrySchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      return parsed.success && parsed.data.key === key ? parsed.data : null;
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : null; }
  }
}
