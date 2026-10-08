import { opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyBackupSet } from './set.js';
import { refuse } from './files.js';
import type { BackupLimits } from './archive.js';
/** Retention only admits private, authenticated scheduled sets. Foreign names remain untouched. */
export async function inspectScheduledSets(directory: string, passphrase: string, limits: BackupLimits) {
  const names: string[] = []; let entries = 0;
  for await (const item of await opendir(directory)) {
    if (++entries > limits.maxFiles) return refuse('BACKUP_LIMIT');
    if (/^recovery-[0-9TZ-]+-[0-9a-f-]{36}$/.test(item.name)) names.push(item.name);
  }
  const ordered: { name: string; at: number }[] = [];
  for (const name of names) {
    const saved = await verifyBackupSet(join(directory, name), passphrase, limits);
    try { ordered.push({ name, at: Date.parse(saved.state.createdAt) }); } finally { saved.close(); }
  }
  return ordered.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
}
export async function pruneScheduledSets(directory: string, ordered: readonly { name: string }[], retention: number, passphrase: string, limits: BackupLimits) {
  for (const { name } of ordered.slice(0, Math.max(0, ordered.length + 1 - retention))) {
    const path = join(directory, name);
    const saved = await verifyBackupSet(path, passphrase, limits); saved.close();
    await rm(path, { recursive: true });
  }
}
