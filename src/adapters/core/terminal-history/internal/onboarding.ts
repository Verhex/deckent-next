import { constants } from 'node:fs';
import { open, mkdir, rename, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ManagedFileError } from '#platform/index.js';
import limits from './onboarding-limits.json' with { type: 'json' };
const privateMode = constants.S_IRUSR | constants.S_IWUSR, modeMask = constants.S_IRWXU | constants.S_IRWXG | constants.S_IRWXO;
const entry = z.object({ principal: z.string().min(1).max(4096), folder: z.string().max(4096), stageId: z.string().min(1).max(160),
  deferredAt: z.number().int().nonnegative().safe(), planDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const document = z.object({ schemaVersion: z.literal(2), entries: z.array(entry).max(limits.maxEntries) }).strict();
const MAX_DEFERRAL_BYTES = limits.maxFileBytes;
export type OnboardingDeferral = z.infer<typeof entry>;
/** Presentation only. Legacy v1 folder-less entries belong to the root folder, never every folder. */
export function openOnboardingDeferrals(path: string) {
  if (process.platform === 'win32' || !constants.O_NOFOLLOW || !constants.O_NONBLOCK) throw new ManagedFileError('MANAGED_FILE_UNSUPPORTED');
  const read = async (): Promise<z.infer<typeof document>> => {
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 2, entries: [] }; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_DEFERRAL_BYTES || (stat.mode & modeMask) !== privateMode || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new ManagedFileError('MANAGED_FILE_UNSAFE');
      if (stat.size === 0) return { schemaVersion: 2, entries: [] }; // private managed-file bootstrap placeholder
      const raw = JSON.parse(await file.readFile('utf8')) as { schemaVersion?: unknown; entries?: unknown[] };
      if (raw.schemaVersion === 1 && Array.isArray(raw.entries)) return document.parse({ schemaVersion: 2,
        entries: raw.entries.map(value => ({ ...(value as object), folder: '' })) });
      return document.parse(raw);
    } finally { await file.close(); }
  };
  /** One locked rewrite: `keep` filters the current entries, `added` is appended. */
  const write = async (keep: (row: OnboardingDeferral) => boolean, added: readonly OnboardingDeferral[]) => {
    const lock = `${path}.lock`, temporary = `${path}.${randomUUID()}.tmp`;
    // A conflicting writer is refused. Never steal a lock or lose another principal/folder's update.
    await mkdir(lock, { mode: 0o700 });
    try {
      const current = await read(), next = document.parse({ schemaVersion: 2, entries: [...current.entries.filter(keep), ...added] });
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized) > MAX_DEFERRAL_BYTES) throw new ManagedFileError('MANAGED_FILE_UNSAFE');
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, privateMode);
      try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => undefined); await rmdir(lock); }
  };
  return {
    async list(principal: string, folder: string) { return (await read()).entries.filter(row => row.principal === principal && row.folder === folder); },
    async defer(input: OnboardingDeferral) {
      const value = entry.parse(input);
      await write(row => row.principal !== value.principal || row.folder !== value.folder || row.stageId !== value.stageId, [value]);
    },
    /** R18: drops this principal's deferrals of the named steps in this folder (settled elsewhere); other people's and folders' stay. */
    async settle(principal: string, folder: string, stageIds: readonly string[]) {
      await write(row => row.principal !== principal || row.folder !== folder || !stageIds.includes(row.stageId), []);
    },
  };
}
