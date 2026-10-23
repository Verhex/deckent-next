import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyConfiguredModelCatalog, assignConfiguredModelRole } from '#composition/core/model-activation/index.js';
import { inspectMonitor } from '#composition/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { readLocalOsIdentity } from '#adapters/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { describeDiagnostic } from '#surfaces/core/monitor-view/index.js';
import { seedCatalog, SEED_CHANNEL } from '../support/model-catalog.js';

// M2 follow-up (f2): the monitor snapshot carries the doctor row's fact, "new model: role pending (N)", as one typed diagnostic code
// (`model-roles-pending:<n>`); assigning the row clears it. The words come from the catalogs, in both locales.
beforeEach(context => {
  if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: configured policy/integrity flows require a verified POSIX UID');
});
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
const NEW = { channelId: SEED_CHANNEL, modelId: 'claude-next-1' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-roles-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home'), global = join(root, 'global');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite }, terminal: { scopeId: 'scope' },
    inspection: { workers: { sources: [] } } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  openSqliteLedger(ledger, sqlite).close();
  const person = readLocalOsIdentity(), principals = [{ issuer: person.issuer, subject: person.subject }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'roles-policy', restrictions: [], grants: [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals, resource: { kind: 'scope', ids: ['scope'] } },
    { id: 'catalog', effect: 'allow', actions: ['inspect', 'activate', 'deactivate'], scopes: 'all', principals, resource: { kind: 'model-activation', ids: 'all' } },
    { id: 'roles', effect: 'allow', actions: ['write'], scopes: 'all', principals, resource: { kind: 'config', ids: ['global:model_roles'] } },
  ] }), { mode: 0o600 });
  const options = { env: { HOME: home, USERPROFILE: home, DECKENT_GLOBAL_HOME: global, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
  const catalog = await seedCatalog(), first = catalog.providers[0].models[0];
  catalog.revision = 'seed-plus-next';
  catalog.providers[0].models.push({ ...first, id: 'next-1', nativeId: NEW.modelId, channelModelId: NEW.modelId, canonicalModelId: NEW.modelId, displayName: 'Claude Next 1' });
  await applyConfiguredModelCatalog(project, { schemaVersion: 1, commandId: 'seed', scopeId: 'scope', action: 'register', catalog }, options);
  return { project, options };
}
const pendingCodes = async (f: Awaited<ReturnType<typeof fixture>>) => { clearConfigCache();
  return (await inspectMonitor(f.project, f.options, { schemaVersion: 1 })).installs[0]!.diagnostics.filter(code => code.startsWith('model-roles-pending')); };

it('the snapshot counts catalog models without a role row, in words in both locales, and an assignment clears it', async () => {
  const f = await fixture();
  expect(await pendingCodes(f)).toEqual(['model-roles-pending:1']);
  expect(describeDiagnostic('model-roles-pending:1', 'en')).toMatchObject({ note: false, text: expect.stringContaining('New model: role pending (1)'), action: expect.stringContaining('deckent models roles') });
  expect(describeDiagnostic('model-roles-pending:1', 'tr').text).toContain('Yeni model: rol bekliyor (1)');
  const { inspectConfiguredModelRoles } = await import('#composition/core/model-activation/index.js');
  const view = await inspectConfiguredModelRoles(f.project, { schemaVersion: 1, scopeId: 'scope' }, f.options);
  await assignConfiguredModelRole(f.project, { schemaVersion: 1, commandId: 'roles-1', scopeId: 'scope', ...NEW, tier: 'frontier', roles: ['brain', 'worker'], expect: view.digest },
    f.options, { attest: async () => true });
  expect(await pendingCodes(f)).toEqual([]);
});
