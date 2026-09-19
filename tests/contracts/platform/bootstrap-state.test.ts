import { chmod, link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertBootstrapUnchanged, assertBootstrapUsable, hashBootstrapJournal,
  observeBootstrapState } from '../../../src/platform/core/bootstrap-state/index.js';

const roots: string[] = [], hex = (value: string) => value.repeat(64).slice(0, 64);
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() { const root = await mkdtemp(join(tmpdir(), 'deckent-bootstrap-')); roots.push(root); return root; }
function payload(root: string, phase: 'pending' | 'committed' = 'pending') {
  return { schemaVersion: 1 as const, transactionId: 'transaction-1', planDigest: hex('a'), profileDigest: hex('b'), phase,
    createdAtMs: 10, updatedAtMs: 11, resources: [{ resource: 'config', path: join(root, '.deckent/config.json'),
      preimageDigest: null, targetDigest: hex('c'), state: phase === 'committed' ? 'published' as const : 'pending' as const }],
    blockers: phase === 'committed' ? [] : ['PACKAGE_TRUST_UNVERIFIED'] };
}
async function publish(root: string, input = payload(root)) {
  const path = join(root, '.deckent/installation/journal.json'); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ ...input, checksum: hashBootstrapJournal(input) }), { mode: 0o600 }); return path;
}

it('observes absence and a usable committed journal without creating state', async () => {
  const root = await project();
  const absent = await observeBootstrapState(root); expect(absent).toEqual({ generation: 'absent', record: null });
  expect(() => assertBootstrapUsable(absent)).not.toThrow();
  await publish(root, payload(root, 'committed')); const committed = await observeBootstrapState(root);
  expect(committed.record).toMatchObject({ phase: 'committed', resources: [{ state: 'published' }], blockers: [] });
  expect(() => assertBootstrapUsable(committed)).not.toThrow();
});

it('returns pending state for inspection and makes the load gate reject it', async () => {
  const root = await project(); await publish(root);
  const observation = await observeBootstrapState(root);
  expect(observation.record?.phase).toBe('pending');
  expect(() => assertBootstrapUsable(observation)).toThrow(expect.objectContaining({ code: 'BOOTSTRAP_INSTALLATION_INCOMPLETE' }));
});

it.skipIf(process.platform === 'win32')('preserves ordinary absence in an owned group-writable project but requires private custody for a journal', async () => {
  const root = await project(); await chmod(root, 0o775);
  await expect(observeBootstrapState(root)).resolves.toEqual({ generation: 'absent', record: null });
  await publish(root);
  await expect(observeBootstrapState(root)).rejects.toMatchObject({ code: 'BOOTSTRAP_STATE_UNSAFE' });
  await chmod(root, 0o755);
  await expect(observeBootstrapState(root)).resolves.toMatchObject({ record: { phase: 'pending' } });
});

it('rejects malformed contracts, invalid commit invariants and bad checksums', async () => {
  const root = await project(), path = await publish(root);
  await writeFile(path, '{', { mode: 0o600 });
  await expect(observeBootstrapState(root)).rejects.toMatchObject({ code: 'BOOTSTRAP_STATE_INVALID' });
  const invalid = { ...payload(root), phase: 'committed' as const };
  await writeFile(path, JSON.stringify({ ...invalid, checksum: hex('0') }), { mode: 0o600 });
  await expect(observeBootstrapState(root)).rejects.toMatchObject({ code: 'BOOTSTRAP_STATE_INVALID' });
  await writeFile(path, JSON.stringify({ ...payload(root), checksum: hex('0') }), { mode: 0o600 });
  await expect(observeBootstrapState(root)).rejects.toMatchObject({ code: 'BOOTSTRAP_STATE_INVALID' });
});

it('rejects unsafe permissions, symlinks and multiply linked journals', async () => {
  const root = await project(), path = await publish(root); await chmod(path, 0o644);
  await expect(observeBootstrapState(root)).rejects.toMatchObject({ code: 'BOOTSTRAP_STATE_UNSAFE' });
  await chmod(path, 0o600); const alias = `${path}.alias`; await link(path, alias);
  await expect(observeBootstrapState(root)).rejects.toMatchObject({ code: 'BOOTSTRAP_STATE_UNSAFE' });
  await rm(alias); const target = `${path}.target`; await rename(path, target); await symlink(target, path);
  await expect(observeBootstrapState(root)).rejects.toMatchObject({ code: 'BOOTSTRAP_STATE_UNSAFE' });
});

it('does not treat an absent journal reached through a parent symlink as ordinary absence', async () => {
  const root = await project(), elsewhere = await project(); await mkdir(join(elsewhere, 'installation'));
  await symlink(elsewhere, join(root, '.deckent'));
  await expect(observeBootstrapState(root)).rejects.toMatchObject({ code: 'BOOTSTRAP_STATE_UNSAFE' });
  await rm(join(root, '.deckent')); await symlink(join(root, 'missing-target'), join(root, '.deckent'));
  await expect(observeBootstrapState(root)).rejects.toMatchObject({ code: 'BOOTSTRAP_STATE_UNSAFE' });
});

it('detects content mutation and inode replacement between observations', async () => {
  const root = await project(), path = await publish(root); const first = await observeBootstrapState(root);
  await writeFile(path, JSON.stringify({ ...payload(root), updatedAtMs: 12, checksum: hashBootstrapJournal({ ...payload(root), updatedAtMs: 12 }) }), { mode: 0o600 });
  const mutated = await observeBootstrapState(root);
  expect(() => assertBootstrapUnchanged(first, mutated)).toThrow(expect.objectContaining({ code: 'BOOTSTRAP_STATE_CHANGED' }));
  const replacement = `${path}.replacement`; const next = payload(root, 'committed');
  await writeFile(replacement, JSON.stringify({ ...next, checksum: hashBootstrapJournal(next) }), { mode: 0o600 }); await rename(replacement, path);
  const replaced = await observeBootstrapState(root);
  expect(() => assertBootstrapUnchanged(mutated, replaced)).toThrow(expect.objectContaining({ code: 'BOOTSTRAP_STATE_CHANGED' }));
});

it('hashes canonical bounded data without invoking accessors', () => {
  const root = '/project'; expect(hashBootstrapJournal(payload(root))).toBe(hashBootstrapJournal({ ...payload(root) }));
  let invoked = false; const hostile = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { invoked = true; return 1; } });
  expect(() => hashBootstrapJournal(hostile)).toThrow(expect.objectContaining({ code: 'BOOTSTRAP_STATE_INVALID' })); expect(invoked).toBe(false);
});
