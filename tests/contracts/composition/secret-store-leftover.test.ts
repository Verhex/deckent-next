import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { inspectConfiguredSecretStore } from '#composition/core/secrets/index.js';
import { createInstallationSecretStoreSelection, openRegisteredSecretStore, openSqliteAuditStore, readLocalOsIdentity, registerProviderConfig } from '#adapters/index.js';
import { prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { prepareProviderSecret } from '#composition/core/model-connect/index.js';
import { renderDoctorReport } from '#surfaces/core/doctor/index.js';

// Astra 2456 N2: a store that is not selected and cannot be listed now is reported as unverified, never counted as empty; doctor names it.
const FILE = 'core.secret-store.file@1', SEALED = 'core.secret-store.encrypted-file@1';
const roots: string[] = [];
beforeAll(() => { registerProviderConfig(); });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(process.platform !== 'linux')('leftover copies are counted; an unreadable non-selected store is unverified, not empty; doctor shows both', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-secret-leftover-')); roots.push(root);
  const home = join(root, 'home'), global = join(home, 'global'), project = join(root, 'project');
  await mkdir(global, { recursive: true, mode: 0o700 }); await mkdir(project);
  const env = { HOME: home, USERPROFILE: home, DECKENT_GLOBAL_HOME: global, DECKENT_LANGUAGE: 'en' };
  const selection = createInstallationSecretStoreSelection(env, 'linux');
  await selection.publish(SEALED, (await selection.read()).digest);
  await openRegisteredSecretStore(FILE, env, 'linux').set('A_KEY', 'synthetic-a');
  expect((await inspectConfiguredSecretStore(project, { env, platform: 'linux' })).leftover).toEqual({ backends: [FILE], entries: 1, unverified: [] });
  // The file store's document becomes unreadable (corrupt): its copies can be neither counted nor ruled out.
  await writeFile(join(global, 'secrets.json'), '{', { mode: 0o600 });
  const view = await inspectConfiguredSecretStore(project, { env, platform: 'linux' });
  expect(view).toMatchObject({ backend: SEALED, leftover: { backends: [], entries: 0, unverified: [FILE] } });
  const text = renderDoctorReport({ platform: 'linux', host: { cpuCores: 1, totalMemMB: 1, recommendedMaxWorkers: 1 }, company: { companyId: 'c' },
    principal: { id: 'p' }, secretStore: view, imageRefresh: null, installationBinding: null, shellRealm: null }, [], 'en');
  expect(text).toContain(`could not be read now (${FILE})`);
  expect(text).not.toContain('remain in a store that is not selected');
});

// U1 S1: an installation root open to others refuses every file-backed store before any file is read; doctor's data names that cause and the
// root's mode (the dropped `SECRET_STORE_UNSAFE` of the owner test), while a private root with no store file yet leaves nothing to report.
it.skipIf(process.platform !== 'linux')('an open installation root gives each unlistable store its typed code and the root mode; a private root gives no leftover', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-secret-open-root-')); roots.push(root);
  const home = join(root, 'home'), global = join(home, 'global'), project = join(root, 'project');
  await mkdir(global, { recursive: true, mode: 0o755 }); await mkdir(project);
  const env = { HOME: home, USERPROFILE: home, DECKENT_GLOBAL_HOME: global, DECKENT_LANGUAGE: 'en' };
  const open = await inspectConfiguredSecretStore(project, { env, platform: 'linux' });
  expect(open).toMatchObject({ backend: 'core.secret-store.env@1', globalRoot: { path: global, mode: '0755' },
    leftover: { entries: 0, unverified: [FILE, SEALED], codes: { [FILE]: 'SECRET_STORE_UNSAFE', [SEALED]: 'SECRET_STORE_UNSAFE' } } });
  await chmod(global, 0o700);
  const closed = await inspectConfiguredSecretStore(project, { env, platform: 'linux' });
  expect(closed.leftover).toBeUndefined();
  expect(closed.globalRoot).toEqual({ path: global, mode: '0700' });
});

it.skipIf(process.platform !== 'linux')('U1 retry checks custody before entry, seals the absent default once, and preserves an explicit env selection', async () => {
  const base = await mkdtemp(join(tmpdir(), 'deckent-provider-custody-')); roots.push(base);
  const project = join(base, 'project'), global = join(base, 'global');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(global, { mode: 0o755 });
  const options = { env: { HOME: base, USERPROFILE: base, DECKENT_GLOBAL_HOME: global }, platform: 'linux' as const };
  const { issuer, subject } = readLocalOsIdentity();
  await writeFile(join(project, '.deckent', 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'custody-test', restrictions: [], grants: [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: [{ issuer, subject }], resource: { kind: 'scope', ids: ['scope'] } },
    { id: 'switch', effect: 'allow', actions: ['switch'], scopes: ['scope'], principals: [{ issuer, subject }], resource: { kind: 'secret', ids: 'all' } },
  ] }), { mode: 0o600 });
  const ledger = await openSqliteAuditStore(await prepareProductFile(resolveProductLayout({ projectRoot: project }), 'ledger', ['-wal', '-shm', '-journal']),
    { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }, 'allow'); ledger.close();
  expect(await prepareProviderSecret(project, 'scope', options, { attest: async () => false })).toMatchObject({ state: 'refused', code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(await prepareProviderSecret(project, 'scope', options, { attest: async () => true })).toMatchObject({ state: 'refused', code: 'SECRET_STORE_UNSAFE', path: global });
  await chmod(global, 0o700);
  expect(await prepareProviderSecret(project, 'scope', options, { attest: async () => true })).toEqual({ state: 'ready', backend: SEALED });
  expect(await prepareProviderSecret(project, 'scope', options, { attest: async () => true })).toEqual({ state: 'ready', backend: SEALED });
  const audit = await openSqliteAuditStore(join(project, '.deckent', 'state', 'ledger.db'), { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }, 'forbid');
  try { expect(audit.page('scope', 0, 100).map(record => record.event.subject)).toEqual([
    expect.objectContaining({ kind: 'secret-store-switch', to: SEALED, decision: { effect: 'allow', ruleId: 'switch' } }),
  ]); } finally { audit.close(); }
  const selection = createInstallationSecretStoreSelection(options.env, 'linux');
  expect((await selection.read()).store).toBe(SEALED);
  await selection.publish('core.secret-store.env@1', (await selection.read()).digest);
  expect(await prepareProviderSecret(project, 'scope', options, { attest: async () => true })).toMatchObject({ state: 'refused', code: 'SECRET_STORE_READ_ONLY' });
  expect((await selection.read()).store).toBe('core.secret-store.env@1');
});
