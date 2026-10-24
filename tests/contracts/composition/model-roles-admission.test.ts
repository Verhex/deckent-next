import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyConfiguredModelCatalog, assignConfiguredModelRole, inspectConfiguredModelRoles } from '#composition/core/model-activation/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { readLocalOsIdentity, withMcpPrincipal } from '#adapters/index.js';
import { composeModelRolePolicy } from '#engine/index.js';
import { CORE_MODEL_ROLES, decideRoleModel, roleModelKey } from '#domain/index.js';
import { clearConfigCache, loadConfig, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { seedCatalog, SEED_CHANNEL } from '../support/model-catalog.js';

// M2 through the real composition (policy file, SQLite ledger, registered catalog, config file writer, sealed audit): a model the catalog
// lists but no row names is pending and every role refuses it; a person's card writes one row into the global `model_roles` overlay by
// compare-and-set, audited as a `config-change`; the AI (MCP actor) or a caller without the terminal witness is refused before anything is read.
beforeEach(context => {
  if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: configured policy/integrity flows require a verified POSIX UID');
});
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
const NEW = { channelId: SEED_CHANNEL, modelId: 'claude-next-1' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-roles-composition-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home'), global = join(root, 'global');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  openSqliteLedger(ledger, sqlite).close();
  const person = readLocalOsIdentity(), principals = [{ issuer: person.issuer, subject: person.subject }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'roles-policy', restrictions: [], grants: [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals, resource: { kind: 'scope', ids: ['scope'] } },
    { id: 'catalog', effect: 'allow', actions: ['inspect', 'activate', 'deactivate'], scopes: 'all', principals, resource: { kind: 'model-activation', ids: 'all' } },
    { id: 'roles', effect: 'allow', actions: ['write'], scopes: 'all', principals, resource: { kind: 'config', ids: ['global:model_roles'] } },
  ] }), { mode: 0o600 });
  const options = { env: { HOME: home, USERPROFILE: home, DECKENT_GLOBAL_HOME: global, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
  // The packaged seed plus one model the Core role seed has never heard of: a data update, no code.
  const catalog = await seedCatalog(), first = catalog.providers[0].models[0];
  catalog.revision = 'seed-plus-next';
  catalog.providers[0].models.push({ ...first, id: 'next-1', nativeId: NEW.modelId, channelModelId: NEW.modelId, canonicalModelId: NEW.modelId, displayName: 'Claude Next 1' });
  await applyConfiguredModelCatalog(project, { schemaVersion: 1, commandId: 'seed', scopeId: 'scope', action: 'register', catalog }, options);
  return { project, ledger, options, globalFile: join(global, 'config.json') };
}
const person = { attest: async () => true };
const auditRows = (ledger: string) => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return db.prepare('SELECT record FROM audit_events').all().map(row => String(row['record'])); } finally { db.close(); } };
const assign = (expect: string | null, extra: object = {}) => ({ schemaVersion: 1, commandId: 'roles-1', scopeId: 'scope', ...NEW, tier: 'frontier', roles: ['brain', 'worker'], expect, ...extra });

it('a new catalog model is pending until a person assigns it; the write is one global overlay row, audited, and the merged policy serves it', async () => {
  const f = await fixture();
  const before = await inspectConfiguredModelRoles(f.project, { schemaVersion: 1, scopeId: 'scope', channelId: SEED_CHANNEL }, f.options);
  expect(before.models.find(row => row.modelId === NEW.modelId)).toMatchObject({ state: 'pending', tier: null, catalog: { maker: 'anthropic', displayName: 'Claude Next 1' } });
  expect(before).toMatchObject({ revision: CORE_MODEL_ROLES.revision, pending: 1, digest: null });
  const active = { today: '2026-10-23', active: new Set([roleModelKey(NEW)]) };
  expect(decideRoleModel(composeModelRolePolicy(undefined), 'brain', NEW, active)).toEqual({ state: 'refused', reason: 'model-unknown' });
  const audits = auditRows(f.ledger).length;
  expect(await assignConfiguredModelRole(f.project, assign(before.digest), f.options, person)).toMatchObject({ status: 'applied', row: { ...NEW, version: 1, tier: 'frontier' } });
  const written = JSON.parse(await readFile(f.globalFile, 'utf8'));
  expect(written.model_roles.overlays).toEqual([{ schemaVersion: 1, revision: 'installation-roles:1', roles: [], exceptions: [],
    models: [{ ...NEW, version: 1, tier: 'frontier', roles: ['brain', 'worker'] }] }]);
  const recorded = auditRows(f.ledger).slice(audits);
  expect(recorded).toHaveLength(1); expect(recorded[0]).toContain('config-change'); expect(recorded[0]).toContain('model_roles'); expect(recorded[0]).toContain('"layer":"global"');
  clearConfigCache();
  const config = await loadConfig(f.project, f.options);
  expect(decideRoleModel(composeModelRolePolicy(config['model_roles']), 'brain', NEW, active)).toMatchObject({ state: 'eligible', basis: 'tier', tier: 'frontier' });
  const after = await inspectConfiguredModelRoles(f.project, { schemaVersion: 1, scopeId: 'scope', channelId: SEED_CHANNEL, modelId: NEW.modelId }, f.options);
  expect(after).toMatchObject({ pending: 0, models: [{ state: 'assigned', tier: 'frontier', roles: ['brain', 'worker'] }] });
  expect(after.digest).toMatch(/^[a-f0-9]{64}$/);
});

it('negative: the AI, a caller without the terminal witness, a stale card, a worker-tier Brain and a model outside the catalog write nothing', async () => {
  const f = await fixture();
  const { digest } = await inspectConfiguredModelRoles(f.project, { schemaVersion: 1, scopeId: 'scope' }, f.options), audits = auditRows(f.ledger).length;
  await expect(withMcpPrincipal(() => assignConfiguredModelRole(f.project, assign(digest), f.options, person))).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  await expect(assignConfiguredModelRole(f.project, assign(digest), f.options)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  await expect(assignConfiguredModelRole(f.project, assign(digest), f.options, { attest: async () => false })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  await expect(assignConfiguredModelRole(f.project, assign('e'.repeat(64)), f.options, person)).rejects.toMatchObject({ code: 'MODEL_ROLE_STALE' });
  await expect(assignConfiguredModelRole(f.project, assign(digest, { tier: 'worker' }), f.options, person)).rejects.toMatchObject({ code: 'MODEL_ROLE_TIER_INVALID' });
  await expect(assignConfiguredModelRole(f.project, assign(digest, { modelId: 'claude-unlisted-9' }), f.options, person)).rejects.toMatchObject({ code: 'MODEL_ROLE_CATALOG_UNKNOWN' });
  await expect(readFile(f.globalFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(auditRows(f.ledger)).toHaveLength(audits);
  // A project layer can never carry the section (config validation, unchanged): the installation owns which model serves a role.
  await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(f.project, '..', 'data') }, storage: { driver: 'sqlite', sqlite },
    model_roles: { schemaVersion: 1, overlays: [] } }), { mode: 0o600 });
  clearConfigCache();
  await expect(loadConfig(f.project, f.options)).rejects.toMatchObject({ code: 'CONFIG_VALIDATION' });
});
