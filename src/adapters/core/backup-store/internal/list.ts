import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyAuditRecord } from '#engine/index.js';
import { sha256, type IntegrityAuthority } from '#platform/index.js';
import type { BackupLimits } from './archive.js';
import { readPrivate } from './files.js';

/** One recovery set as `deckent backup` lists it, read without the passphrase (nothing is decrypted or verified here). */
export interface BackupSetEntry { readonly path: string; readonly name: string; readonly kind: 'scheduled' | 'manual'; readonly createdAtMs: number;
  readonly bytes: number; readonly lastVerifiedAtMs: number | null }
const SCHEDULED = /^recovery-[0-9TZ-]+-[0-9a-f-]{36}$/;
const absent = (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [] as string[]; throw error; };
/**
 * C-ADMIN (owner CLI review 2026-10-19 `backup`): the sets in one folder, newest first. A set is a private folder of this user holding
 * MANIFEST.sha256; anything else is passed over. Kind comes from the name the schedule writes; time from the manifest; size = its files.
 * `verified` maps sha256(set path) to the last authenticated successful operation on it (see {@link lastBackupVerifications}).
 */
export async function listBackupSets(directory: string, limits: BackupLimits, verified: ReadonlyMap<string, number>): Promise<BackupSetEntry[]> {
  const sets: BackupSetEntry[] = [];
  for (const name of (await readdir(directory).catch(absent)).filter(item => !item.startsWith('.')).slice(0, limits.maxFiles)) {
    const path = join(directory, name), info = await lstat(path);
    if (!info.isDirectory() || info.uid !== process.getuid?.()) continue;
    const members = (await readdir(path).catch(() => [] as string[])).slice(0, limits.maxFiles);
    if (!members.includes('MANIFEST.sha256')) continue;
    let bytes = 0;
    for (const member of members) { const stat = await lstat(join(path, member)).catch(() => null); if (stat?.isFile()) bytes += stat.size; }
    sets.push({ path, name, kind: SCHEDULED.test(name) ? 'scheduled' : 'manual', createdAtMs: (await lstat(join(path, 'MANIFEST.sha256'))).mtimeMs, bytes,
      lastVerifiedAtMs: verified.get(sha256(path)) ?? null });
  }
  return sets.sort((a, b) => b.createdAtMs - a.createdAtMs || a.name.localeCompare(b.name));
}
/** The newest successful backup operation (create, verify or restore each authenticate the set) per set-path digest, from the sealed
 * backup audit records; a record whose seal does not verify under this installation's key is ignored. Bounded by `maxFiles`. */
export async function lastBackupVerifications(directory: string, limits: BackupLimits, authority: IntegrityAuthority): Promise<Map<string, number>> {
  const latest = new Map<string, number>();
  for (const name of (await readdir(directory).catch(absent)).slice(0, limits.maxFiles)) {
    try {
      const { event } = verifyAuditRecord(JSON.parse((await readPrivate(join(directory, name), 65_536)).toString('utf8')), authority);
      const subject = event.subject as { kind?: string; phase?: string; setPathDigest?: string };
      if (subject.kind === 'backup-operation' && subject.phase === 'succeeded' && subject.setPathDigest && event.atMs > (latest.get(subject.setPathDigest) ?? -1)) latest.set(subject.setPathDigest, event.atMs);
    } catch { /* unreadable or unauthenticated record: not evidence of a verification */ }
  }
  return latest;
}
