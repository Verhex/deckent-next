import { mkdtemp, mkdir, rm, stat, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CURRENT_LEDGER_VERSION, MODEL_CATALOG_LEDGER_VERSION, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteModelCatalogReader, openSqliteModelCatalogStore, upgradeExistingProductLedger } from '#adapters/index.js';
import { createHash } from 'node:crypto';
import { encodeModelBindingDefinition, parseModelCatalogCommand, parseProviderCatalog, parseProviderCatalogDocument } from '#domain/index.js';
import type { ModelCatalogAdmission } from '#engine/index.js';
import { DOWNGRADE_TO_V42_LEDGER_SQL, PREVIOUS_LEDGER_VERSION } from '../../fixtures/ledger-previous.js';
import { seedCatalog } from '../support/model-catalog.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };
const rows = (path: string, sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
const version = (path: string) => rows(path, 'PRAGMA user_version')[0]?.user_version;
const actor = { id: 'local-os:1000', issuer: 'local-os', subject: '1000', assurance: 'os-user' as const };
const authorization = { revision: 'p', ruleId: 'catalog' };
function admission(command: unknown): ModelCatalogAdmission {
  const parsed = parseModelCatalogCommand(command);
  const targets = parsed.action === 'register' ? parsed.catalog.providers.map(p => ({ channelId: p.id, modelId: null }))
    : [{ channelId: parsed.channelId, modelId: parsed.modelId }];
  return { command: parsed, actor, admittedAtMs: 1, authorizations: targets.map(target => ({ target, action: parsed.action === 'deactivate' ? 'deactivate' : 'activate',
    level: parsed.action === 'register' ? 'installation' : 'scope', authorization })) };
}
async function ledger() {
  const root = await mkdtemp(join(tmpdir(), 'dn-model-catalog-')); roots.push(root);
  const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close(); return { root, path };
}
const channel = 'claude-cli-subscription';

describe.skipIf(process.platform === 'win32')('ledger v43 model catalog', () => {
  it('upgrades a v42 ledger losslessly: 0600 backup at v42, every existing table byte-equal, four empty catalog tables', async () => {
    expect(CURRENT_LEDGER_VERSION).toBe(46); expect(MODEL_CATALOG_LEDGER_VERSION).toBe(43); expect(PREVIOUS_LEDGER_VERSION).toBe(45);
    const { root, path } = await ledger(); const backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
    const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_V42_LEDGER_SQL);
    // An existing chat activation row and receipt must survive untouched.
    db.prepare('INSERT INTO model_activations(scope_id,provider_id,provider_version,model_id,model_version,revision,record) VALUES(?,?,?,?,?,?,?)')
      .run('s', 'local', 1, 'qwen', 1, 1, '{"kept":true}');
    db.prepare('INSERT INTO model_activation_receipts(scope_id,command_id,record) VALUES(?,?,?)').run('s', 'c', '{"kept":true}');
    db.close();
    const tables = (file: string) => rows(file, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(row => String(row.name));
    const dump = (file: string, names: string[]) => Object.fromEntries(names.map(name => [name, rows(file, `SELECT * FROM "${name}"`)]));
    const before = tables(path), beforeRows = dump(path, before);
    expect(before.filter(name => name.startsWith('model_catalog'))).toEqual([]);
    expect(() => openSqliteLedger(path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
    const upgrade = await upgradeExistingProductLedger(path, options, backups, new Date('2026-09-30T12:00:00.000Z'));
    const backupPath = join(backups, 'ledger-v42-2026-09-30T12-00-00-000Z.db');
    expect(upgrade).toEqual({ from: 42, to: CURRENT_LEDGER_VERSION, backupPath });
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600); expect(version(backupPath)).toBe(42); expect(version(path)).toBe(CURRENT_LEDGER_VERSION);
    expect(dump(path, before)).toEqual(beforeRows);
    expect(tables(path).filter(name => name.startsWith('model_catalog'))).toEqual(['model_catalog_activations', 'model_catalog_channels', 'model_catalog_models', 'model_catalog_receipts']);
    for (const name of ['model_catalog_activations', 'model_catalog_channels', 'model_catalog_models', 'model_catalog_receipts']) expect(rows(path, `SELECT count(*) AS n FROM ${name}`)[0]!.n).toBe(0);
  });
  it('refuses a ledger newer than this build on writer and admission-reader opens (the rule a v42 build applies to v43)', async () => {
    const { path } = await ledger();
    const db = new DatabaseSync(path); db.exec(`PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1};`); db.close();
    expect(() => openSqliteLedger(path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
    await expect(openSqliteModelCatalogReader(path, options)).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
    const older = await ledger(); const raw = new DatabaseSync(older.path); raw.exec(DOWNGRADE_TO_V42_LEDGER_SQL); raw.close();
    await expect(openSqliteModelCatalogReader(older.path, options)).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  });
  it('rolls the v43 step back when a same-name object of another shape exists (ledger stays at v42)', async () => {
    const { path } = await ledger();
    const db = new DatabaseSync(path); db.exec(`${DOWNGRADE_TO_V42_LEDGER_SQL} CREATE TABLE model_catalog_models(id INTEGER PRIMARY KEY, payload TEXT);`); db.close();
    expect(() => openSqliteLedger(path, options, 'allow')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
    expect(version(path)).toBe(42);
    expect(rows(path, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'model_catalog%'").map(row => row.name)).toEqual(['model_catalog_models']);
  });
  it('registers facts, activates hierarchically, replays exactly and refuses conflicts, unknown targets and stale revisions', async () => {
    const { path } = await ledger(); const catalog = await seedCatalog();
    const store = await openSqliteModelCatalogStore(path, options, 'forbid');
    try {
      const register = { schemaVersion: 1, commandId: 'seed', scopeId: 's', action: 'register', catalog };
      const first = await store.apply(admission(register));
      expect(first.replayed).toBe(false);
      expect(first.receipt.changes.map(change => `${change.kind}:${change.modelId ?? '-'}:${change.revision}`)).toEqual(['channel:-:1',
        'model:claude-fable-5-1:1', 'model:claude-haiku-4-5-20251001:1', 'model:claude-opus-5-5:1', 'model:claude-sonnet-5-5:1']);
      expect(await store.apply(admission(register))).toEqual({ replayed: true, receipt: first.receipt });
      await expect(store.apply(admission({ ...register, scopeId: 's', catalog: { ...catalog, revision: 'other' } }))).rejects.toMatchObject({ code: 'MODEL_CATALOG_COMMAND_CONFLICT' });
      // Unchanged facts are not rewritten; a lifecycle change bumps only that model.
      expect((await store.apply(admission({ ...register, commandId: 'same' }))).receipt.changes).toEqual([]);
      const retired = structuredClone(catalog); const haiku = retired.providers[0].models.find((m: { nativeId: string }) => m.nativeId === 'claude-haiku-4-5-20251001');
      haiku.lifecycle = { ...haiku.lifecycle, state: 'retired', retiredOn: '2026-10-15' };
      expect((await store.apply(admission({ ...register, commandId: 'retire', catalog: retired }))).receipt.changes)
        .toEqual([{ kind: 'model', channelId: channel, modelId: 'claude-haiku-4-5-20251001', revision: 2 }]);
      const activate = (commandId: string, modelId: string | null, expectedRevision = 0, action = 'activate') =>
        store.apply(admission({ schemaVersion: 1, commandId, scopeId: 's', action, channelId: channel, modelId, expectedRevision }));
      await expect(activate('unknown-model', 'claude-sonnet-9')).rejects.toMatchObject({ code: 'MODEL_CATALOG_NOT_FOUND' });
      await expect(store.apply(admission({ schemaVersion: 1, commandId: 'unknown-channel', scopeId: 's', action: 'activate', channelId: 'nope', modelId: null, expectedRevision: 0 })))
        .rejects.toMatchObject({ code: 'MODEL_CATALOG_NOT_FOUND' });
      await expect(activate('deactivate-missing', null, 0, 'deactivate')).rejects.toMatchObject({ code: 'MODEL_CATALOG_NOT_ACTIVE' });
      expect((await activate('channel', null)).receipt.changes).toEqual([{ kind: 'activation', channelId: channel, modelId: null, revision: 1 }]);
      await expect(activate('stale', null, 0)).rejects.toMatchObject({ code: 'MODEL_CATALOG_REVISION_CONFLICT' });
      await activate('sonnet', 'claude-sonnet-5-5');
    } finally { store.close(); }
    const reader = await openSqliteModelCatalogReader(path, options);
    try {
      expect((await reader.channel(channel))?.channel).toMatchObject({ kind: 'native-cli', cli: 'claude' });
      expect((await reader.models(channel)).map(entry => [entry.modelId, entry.model.lifecycle.state])).toEqual([['claude-fable-5-1', 'active'],
        ['claude-haiku-4-5-20251001', 'retired'], ['claude-opus-5-5', 'active'], ['claude-sonnet-5-5', 'active']]);
      expect(await reader.activation('s', channel, null)).toMatchObject({ state: 'active', revision: 1 });
      expect(await reader.activation('s', channel, 'claude-sonnet-5-5')).toMatchObject({ state: 'active', revision: 1 });
      // Activation is scope-partitioned: another scope sees nothing.
      expect(await reader.activation('other', channel, 'claude-sonnet-5-5')).toBeNull();
    } finally { reader.close(); }
    // A row whose record disagrees with its key columns is corrupt, never silently used.
    const raw = new DatabaseSync(path); raw.prepare("UPDATE model_catalog_models SET lifecycle='active' WHERE model_id='claude-haiku-4-5-20251001'").run(); raw.close();
    const again = await openSqliteModelCatalogReader(path, options);
    try { await expect(again.models(channel)).rejects.toMatchObject({ code: 'MODEL_CATALOG_CORRUPT' }); } finally { again.close(); }
  });
  it('rejects catalog documents that break channel invariants (duplicate exact id, alias shadowing an exact id, CLI data on an API channel)', async () => {
    const catalog = JSON.parse(await readFile(new URL('../../fixtures/catalog/claude-v2.json', import.meta.url), 'utf8'));
    expect(() => parseProviderCatalogDocument(catalog)).not.toThrow();
    const bad = (mutate: (doc: typeof catalog) => void) => { const doc = structuredClone(catalog); mutate(doc); return () => parseProviderCatalogDocument(doc); };
    expect(bad(doc => { doc.providers[0].models.push({ ...doc.providers[0].models[0], id: 'copy' }); })).toThrow(expect.objectContaining({ code: 'PROVIDER_CATALOG_DUPLICATE' }));
    expect(bad(doc => { doc.providers[0].channel.aliases.push('claude-sonnet-5-5'); })).toThrow(expect.objectContaining({ code: 'PROVIDER_CATALOG_DUPLICATE' }));
    expect(bad(doc => { doc.providers[0].channel = { kind: 'http-api', cli: null, aliases: [] }; })).toThrow(expect.objectContaining({ code: 'PROVIDER_CATALOG_DUPLICATE' }));
    expect(bad(doc => { doc.providers[0].models[0].efforts = ['medium', 'medium']; })).toThrow(expect.objectContaining({ code: 'PROVIDER_CATALOG_DUPLICATE' }));
    expect(bad(doc => { doc.providers[0].models[0].nativeId = '--fallback-model'; })).toThrow(expect.objectContaining({ code: 'PROVIDER_CATALOG_INVALID' }));
    expect(bad(doc => { delete doc.providers[0].models[0].lifecycle; })).toThrow(expect.objectContaining({ code: 'PROVIDER_CATALOG_INVALID' }));
  });
  it('keeps the chat catalog contract byte-stable: a v1 declaration binds to the same digest as before v43 (existing activations stay valid)', () => {
    const catalog = parseProviderCatalog({ schemaVersion: 1, revision: 'r', providers: [{ id: 'local', version: 1, models: [{ id: 'qwen', version: 1, nativeId: 'Qwen/Qwen3-8B',
      protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [{ id: 'text', version: 1, state: 'supported' }] }] }] }] });
    const definition = { encodingVersion: 1, provider: { id: 'local', version: 1 }, model: catalog.providers[0]!.models[0] };
    // Golden value measured on main 6b15406a (before this slice) with the same input.
    expect(createHash('sha256').update(encodeModelBindingDefinition(definition), 'utf8').digest('hex')).toBe('a185c83527b619a6d9ecfe50e30286fb22be917e2eb314fe51c0c62b3d9903c8');
    // A v2 catalog document is never accepted as a v1 chat catalog (and vice versa): one shape per reader until chat moves to the ledger.
    expect(() => parseProviderCatalog({ schemaVersion: 2, revision: 'r', providers: [] })).toThrow(expect.objectContaining({ code: 'PROVIDER_CATALOG_INVALID' }));
    expect(() => parseProviderCatalogDocument({ schemaVersion: 1, revision: 'r', providers: [] })).toThrow(expect.objectContaining({ code: 'PROVIDER_CATALOG_INVALID' }));
  });
  it('WC-R3 (Astra 2197): a partial register is checked against the FINAL merged channel; alias collisions roll back completely', async () => {
    const { path } = await ledger();
    const store = await openSqliteModelCatalogStore(path, options, 'forbid');
    const channelDoc = (revision: string, models: object[], aliases: string[] = []) => ({ schemaVersion: 2, revision, providers: [{ id: 'c', version: 1,
      channel: { kind: 'native-cli', cli: 'claude', aliases }, models }] });
    const model = (nativeId: string, aliases: string[] = []) => ({ id: nativeId, version: 1, nativeId, protocols: [{ family: 'claude-code-stream-json', version: 'v1', capabilities: [] }],
      lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null }, minCliVersion: null, efforts: [], aliases });
    let n = 0;
    const register = (catalog: object) => store.apply(admission({ schemaVersion: 1, commandId: `r${++n}`, scopeId: 's', action: 'register', catalog }));
    try {
      await register(channelDoc('one', [model('model-a', ['alias-x'])]));
      await store.apply(admission({ schemaVersion: 1, commandId: 'act-c', scopeId: 's', action: 'activate', channelId: 'c', modelId: null, expectedRevision: 0 }));
      await store.apply(admission({ schemaVersion: 1, commandId: 'act-a', scopeId: 's', action: 'activate', channelId: 'c', modelId: 'model-a', expectedRevision: 0 }));
      const snapshot = () => Object.fromEntries(['model_catalog_channels', 'model_catalog_models', 'model_catalog_activations', 'model_catalog_receipts']
        .map(table => [table, rows(path, `SELECT * FROM ${table} ORDER BY 1,2`)]));
      const before = snapshot();
      // exact ↔ alias: the new model aliases the preserved exact id.
      await expect(register(channelDoc('two', [model('model-b', ['model-a'])]))).rejects.toMatchObject({ code: 'MODEL_CATALOG_ALIAS_CONFLICT' });
      // alias ↔ alias: the new model reuses a preserved model's alias; a channel alias equal to a preserved alias or exact id is refused too.
      await expect(register(channelDoc('three', [model('model-b', ['alias-x'])]))).rejects.toMatchObject({ code: 'MODEL_CATALOG_ALIAS_CONFLICT' });
      await expect(register(channelDoc('four', [model('model-b')], ['alias-x']))).rejects.toMatchObject({ code: 'MODEL_CATALOG_ALIAS_CONFLICT' });
      await expect(register(channelDoc('five', [model('model-b')], ['model-a']))).rejects.toMatchObject({ code: 'MODEL_CATALOG_ALIAS_CONFLICT' });
      // exact id equal to a preserved alias.
      await expect(register(channelDoc('six', [model('alias-x')]))).rejects.toMatchObject({ code: 'MODEL_CATALOG_ALIAS_CONFLICT' });
      expect(snapshot()).toEqual(before);
      // A non-conflicting partial update passes and keeps the preserved model and its activation.
      const ok = await register(channelDoc('seven', [model('model-b', ['alias-y'])]));
      expect(ok.receipt.changes).toEqual([{ kind: 'model', channelId: 'c', modelId: 'model-b', revision: 1 }]);
      expect(rows(path, 'SELECT model_id FROM model_catalog_models ORDER BY model_id').map(row => row.model_id)).toEqual(['model-a', 'model-b']);
      expect(rows(path, "SELECT state FROM model_catalog_activations WHERE model_id='model-a'")).toEqual([{ state: 'active' }]);
      // Updating the preserved model itself may move its own alias (no self-collision).
      await register(channelDoc('eight', [model('model-a', ['alias-z'])]));
      await register(channelDoc('nine', [model('model-b', ['alias-x'])]));
    } finally { store.close(); }
  });
});

