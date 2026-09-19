import { mkdirSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, writeFile, rm, readFile, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { clearConfigCache, loadConfig, registerConfigSection, resolveProductLayout, productResourcePath, readJsonFile, healCorruptProjectConfig } from '#platform/index.js';
import { hashBootstrapJournal, observeBootstrapState, assertBootstrapUsable, assertBootstrapUnchanged } from '#platform/core/bootstrap-state/index.js';

const roots: string[] = [];
let onValidate: (() => void) | undefined;
registerConfigSection('bootstrap_gate_test', z.object({}).strict(), { optional: true, validateEffective: () => { onValidate?.(); } });
afterEach(async () => { onValidate = undefined; clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-bootstrap-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(project);
  const layout = resolveProductLayout({ projectRoot: project });
  return { root, project, env: { HOME: join(root, 'home') }, journal: productResourcePath(layout, 'installationJournal'), config: productResourcePath(layout, 'config') };
}
function journal(f: Awaited<ReturnType<typeof fixture>>, phase: 'pending' | 'committed') {
  const payload = { schemaVersion: 1 as const, transactionId: 'test-install', planDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
    phase, createdAtMs: 0, updatedAtMs: 0, resources: [{ resource: 'config', path: f.config, preimageDigest: null,
      targetDigest: 'c'.repeat(64), state: phase === 'pending' ? 'pending' as const : 'published' as const }], blockers: [] };
  return JSON.stringify({ ...payload, checksum: hashBootstrapJournal(payload) });
}
function publishSync(f: Awaited<ReturnType<typeof fixture>>, phase: 'pending' | 'committed') {
  mkdirSync(dirname(f.journal), { recursive: true, mode: 0o700 });
  writeFileSync(f.journal, journal(f, phase), { mode: 0o600 });
}

it('holds fresh and previously cached defaults when an installation journal is pending', async () => {
  const f = await fixture(); await loadConfig(f.project, { env: f.env });
  publishSync(f, 'pending');
  await expect(loadConfig(f.project, { env: f.env })).rejects.toMatchObject({ code: 'BOOTSTRAP_INSTALLATION_INCOMPLETE' });
  clearConfigCache();
  await expect(loadConfig(f.project, { env: f.env, force: true })).rejects.toMatchObject({ code: 'BOOTSTRAP_INSTALLATION_INCOMPLETE' });
});
it.skipIf(process.platform === 'win32')('loads fresh and cached config in a group-writable project when no journal exists', async () => {
  const f = await fixture(); await chmod(f.project, 0o775);
  await expect(loadConfig(f.project, { env: f.env })).resolves.toMatchObject({ projectName: 'deckent-project' });
  await expect(loadConfig(f.project, { env: f.env })).resolves.toMatchObject({ projectName: 'deckent-project' });
  expect(await readdir(f.project)).toEqual([]);
});
it('detects anchor creation between cache lookup and return', async () => {
  const f = await fixture(); await loadConfig(f.project, { env: f.env });
  onValidate = () => { onValidate = undefined; publishSync(f, 'committed'); };
  await expect(loadConfig(f.project, { env: f.env })).rejects.toMatchObject({ code: 'BOOTSTRAP_STATE_CHANGED' });
});
it('detects anchor creation while a fresh load awaits secret resolution', async () => {
  const f = await fixture(); await mkdir(dirname(f.config), { recursive: true, mode: 0o700 });
  await writeFile(f.config, JSON.stringify({ projectName: '$DECK:PROJECT' }), { mode: 0o600 });
  await expect(loadConfig(f.project, { env: f.env, secretResolver: async () => { publishSync(f, 'pending'); return 'resolved-name'; } }))
    .rejects.toMatchObject({ code: 'BOOTSTRAP_INSTALLATION_INCOMPLETE' });
});
it('does not heal malformed configuration while installation is incomplete', async () => {
  const f = await fixture(); publishSync(f, 'pending'); await writeFile(f.config, '{', { mode: 0o600 });
  await expect(loadConfig(f.project, { env: f.env })).rejects.toMatchObject({ code: 'BOOTSTRAP_INSTALLATION_INCOMPLETE' });
  expect(await readFile(f.config, 'utf8')).toBe('{');
});
it('keeps global-only config independent and admits stable committed project configuration', async () => {
  const f = await fixture(); publishSync(f, 'pending');
  await expect(loadConfig(f.project, { env: f.env, globalOnly: true })).resolves.toMatchObject({ projectName: 'deckent-project' });
  await writeFile(f.config, JSON.stringify({ projectName: 'installed-project' }), { mode: 0o600 }); publishSync(f, 'committed');
  await expect(loadConfig(f.project, { env: f.env })).resolves.toMatchObject({ projectName: 'installed-project' });
});
it('reads the fixed anchor before a relocated data root from config or environment', async () => {
  const f = await fixture(); publishSync(f, 'pending'); await writeFile(f.config, JSON.stringify({ layout: { root: join(f.root, 'data') } }), { mode: 0o600 });
  await expect(loadConfig(f.project, { env: { ...f.env, DECKENT_HOME: join(f.root, 'another-data') } }))
    .rejects.toMatchObject({ code: 'BOOTSTRAP_INSTALLATION_INCOMPLETE' });
});

for (const cached of [false, true]) it(`checks warning callbacks before ${cached ? 'cached' : 'fresh'} config admission`, async () => {
  const f = await fixture(); await mkdir(dirname(f.config), { recursive: true, mode: 0o700 });
  await writeFile(f.config, JSON.stringify({ max_workers: Number.MAX_SAFE_INTEGER }), { mode: 0o600 });
  if (cached) await loadConfig(f.project, { env: f.env });
  await expect(loadConfig(f.project, { env: f.env, onWarning: () => publishSync(f, 'pending') }))
    .rejects.toMatchObject({ code: 'BOOTSTRAP_INSTALLATION_INCOMPLETE' });
});

it('checks the captured bootstrap fence under the config writer lock before any heal backup/write', async () => {
  const f = await fixture(); await mkdir(dirname(f.config), { recursive: true, mode: 0o700 });
  await writeFile(f.config, '{', { mode: 0o600 }); const before = await observeBootstrapState(f.project);
  const corrupt = await readJsonFile(f.config); if (corrupt.kind !== 'corrupt') throw new Error('EXPECTED_CORRUPT');
  let guardedUnderLock = false;
  await expect(healCorruptProjectConfig(f.config, corrupt, { beforeHeal: async () => {
    guardedUnderLock = (await lstat(`${f.config}.write-lock`)).isDirectory();
    publishSync(f, 'pending'); const after = await observeBootstrapState(f.project);
    assertBootstrapUsable(after); assertBootstrapUnchanged(before, after);
  } })).rejects.toMatchObject({ code: 'BOOTSTRAP_INSTALLATION_INCOMPLETE' });
  expect(guardedUnderLock).toBe(true); expect(await readFile(f.config, 'utf8')).toBe('{');
  expect((await readdir(dirname(f.config))).filter(name => name.includes('.bak.') || name.includes('.write-lock'))).toEqual([]);
});
