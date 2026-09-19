import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { healCorruptProjectConfig, pruneConfigBackups, readJsonFile } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(process.platform === 'win32')('retains the returned corrupt-byte backup across clock regression without touching foreign or symlink entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-retention-')); roots.push(root);
  const path = join(root, '.deckent/config.json'); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const corruptBytes = '{"projectName":'; await writeFile(path, corruptBytes, { mode: 0o600 });
  const prefix = `${basename(path)}.bak.`;
  const prior = [
    `${prefix}2099-12-31T23-59-59.003Z.33333333-3333-4333-8333-333333333333`,
    `${prefix}2099-12-31T23-59-59.002Z.22222222-2222-4222-8222-222222222222`,
    `${prefix}2099-12-31T23-59-59.001Z.11111111-1111-4111-8111-111111111111`,
  ];
  for (const [index, name] of prior.entries()) await writeFile(join(dirname(path), name), `prior-${index}`, { mode: 0o600 });
  const foreign = join(dirname(path), `${prefix}foreign-evidence`); await writeFile(foreign, 'foreign', { mode: 0o600 });
  const symlinkTarget = join(root, 'symlink-target'); await writeFile(symlinkTarget, 'linked-evidence', { mode: 0o600 });
  const linked = join(dirname(path), `${prefix}2099-12-31T23-59-59.004Z.44444444-4444-4444-8444-444444444444`);
  await symlink(symlinkTarget, linked);

  const observed = await readJsonFile(path); if (observed.kind !== 'corrupt') throw new Error('EXPECTED_CORRUPT_CONFIG');
  const healed = await healCorruptProjectConfig(path, observed);

  expect(await readFile(healed.backupPath, 'utf8')).toBe(corruptBytes);
  const names = await readdir(dirname(path));
  const eligibleNames = new Set([...prior, basename(healed.backupPath)]);
  const regularBackups: string[] = [];
  for (const name of names.filter(name => eligibleNames.has(name))) {
    const stat = await lstat(join(dirname(path), name)); if (stat.isFile()) regularBackups.push(name);
  }
  expect(regularBackups).toHaveLength(3);
  expect(regularBackups).toContain(basename(healed.backupPath));
  expect(await readFile(join(dirname(path), prior[0]!), 'utf8')).toBe('prior-0');
  expect(await readFile(join(dirname(path), prior[1]!), 'utf8')).toBe('prior-1');
  await expect(lstat(join(dirname(path), prior[2]!))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(foreign, 'utf8')).toBe('foreign');
  expect((await lstat(linked)).isSymbolicLink()).toBe(true);
  expect(await readFile(linked, 'utf8')).toBe('linked-evidence');
});

it('keeps an explicitly protected old backup within a bound of one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-protected-')); roots.push(root);
  const path = join(root, 'config.json'), prefix = `${basename(path)}.bak.`;
  const protectedPath = join(root, `${prefix}2000-01-01T00-00-00.000Z.11111111-1111-4111-8111-111111111111`);
  const future = [
    join(root, `${prefix}2099-01-01T00-00-00.002Z.33333333-3333-4333-8333-333333333333`),
    join(root, `${prefix}2099-01-01T00-00-00.001Z.22222222-2222-4222-8222-222222222222`),
  ];
  await writeFile(protectedPath, 'protected-old', { mode: 0o600 });
  await Promise.all(future.map((file, index) => writeFile(file, `future-${index}`, { mode: 0o600 })));

  await pruneConfigBackups(path, 1, protectedPath);

  expect(await readFile(protectedPath, 'utf8')).toBe('protected-old');
  for (const file of future) await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('rejects foreign and symlink protected paths before deleting any backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-invalid-protected-')); roots.push(root);
  const path = join(root, 'config.json'), prefix = `${basename(path)}.bak.`;
  const backups = [
    join(root, `${prefix}2099-01-01T00-00-00.002Z.22222222-2222-4222-8222-222222222222`),
    join(root, `${prefix}2099-01-01T00-00-00.001Z.11111111-1111-4111-8111-111111111111`),
  ];
  await writeFile(backups[0]!, 'newer', { mode: 0o600 }); await writeFile(backups[1]!, 'older', { mode: 0o600 });
  const snapshot = await Promise.all(backups.map(file => readFile(file)));
  const foreign = join(root, `${prefix}foreign`); await writeFile(foreign, 'foreign', { mode: 0o600 });
  await expect(pruneConfigBackups(path, 1, foreign)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  await expect(Promise.all(backups.map(file => readFile(file)))).resolves.toEqual(snapshot);

  const target = join(root, 'target'); await writeFile(target, 'target', { mode: 0o600 });
  const linked = join(root, `${prefix}2099-01-01T00-00-00.003Z.33333333-3333-4333-8333-333333333333`);
  await symlink(target, linked);
  await expect(pruneConfigBackups(path, 1, linked)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  await expect(Promise.all(backups.map(file => readFile(file)))).resolves.toEqual(snapshot);
  expect(await readFile(foreign, 'utf8')).toBe('foreign'); expect((await lstat(linked)).isSymbolicLink()).toBe(true);
});
