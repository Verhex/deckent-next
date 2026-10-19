import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { inspectConfiguredBackupSets } from '#composition/core/backup/index.js';

/*
 * C-ADMIN (lead 2026-10-19): `deckent backup` says whether the scheduled backup passphrase is kept in this installation only through the same
 * assurance-gated secret-name reader as `secret list` (`enforce_principal_assurance`). A refused or failed read is "unknown" (null), never an
 * error of the whole list and never "not stored".
 */
const reader = vi.hoisted(() => ({ calls: 0, answer: null as null | (() => Promise<{ names: readonly string[] }>) }));
vi.mock('#composition/core/secrets/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('#composition/core/secrets/index.js')>();
  return { ...real, listConfiguredSecretNames: async (...args: Parameters<typeof real.listConfiguredSecretNames>) => {
    reader.calls++; return reader.answer ? { schemaVersion: 1 as const, backend: 'test', ...(await reader.answer()) } : real.listConfiguredSecretNames(...args); } };
});
const roots: string[] = [];
afterEach(async () => { reader.calls = 0; reader.answer = null; clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() {
  const base = await mkdtemp(join(tmpdir(), 'deckent-backup-sets-')); roots.push(base);
  const root = join(base, 'project'), home = join(base, 'home');
  await mkdir(join(root, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(root, '.deckent', 'config.json'), JSON.stringify({}), { mode: 0o600 });
  return { root, options: { env: { HOME: home, DECKENT_GLOBAL_HOME: join(base, 'global'), PATH: process.env['PATH'] ?? '/usr/bin:/bin' } } };
}

it.skipIf(process.platform === 'win32')('the passphrase-present line reads through the assurance-gated reader; a refusal is unknown and the list still answers', async () => {
  const f = await project();
  reader.answer = async () => ({ names: ['BACKUP_PASSPHRASE', 'OTHER'] });
  expect(await inspectConfiguredBackupSets(f.root, f.options)).toMatchObject({ passphraseStored: true, sets: [] });
  reader.answer = async () => ({ names: ['OTHER'] });
  expect(await inspectConfiguredBackupSets(f.root, f.options)).toMatchObject({ passphraseStored: false });
  // Negative: the gate refuses (enforce_principal_assurance, ACTOR_UNVERIFIED) or the store fails: unknown, fail-closed, no throw.
  for (const code of ['ACTOR_UNVERIFIED', 'SECRET_STORE_UNAVAILABLE']) {
    reader.answer = async () => { throw Object.assign(new Error(code), { code }); };
    expect(await inspectConfiguredBackupSets(f.root, f.options)).toMatchObject({ passphraseStored: null, sets: [] });
  }
  expect(reader.calls).toBe(4);
});
