import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DOWNGRADE_TO_PREVIOUS_LEDGER_SQL } from '../../fixtures/ledger-previous.js';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, randomBytes, scrypt } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { FileInstallationIdentityStore } from '#adapters/core/installation-files/index.js';
import { FileBackupStorage, createBackupSet, verifyBackupSet } from '#adapters/core/backup-store/index.js';
import { upgradeExistingLedger, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { BackupApplication, policyBackupAuthorization, type BackupAuthority } from '#engine/core/backup/index.js';
import { assertUnsealedInstallation, parseBeuserRealmSeal } from '#engine/core/beuser-realm/index.js';
import { verifiedPrincipalSchema, installationIdentityRecordSchema, type AuditEvent } from '#domain/index.js';
import { resolveProductLayout, productResourcePath, sha256, type ProductLayout } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const seal = parseBeuserRealmSeal({ schemaVersion: 1, fixture: 'realm-sealed', realmId: 'fixture-realm',
  nonce: '12345678-1234-4234-8234-123456789abc', bindingDigest: 'a'.repeat(64) });
const limits = { maxFiles: 100, maxDepth: 10, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 22 };
const phrase = 'synthetic-fixture-passphrase';
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'beuser-transfer-')); roots.push(base);
  const root = join(base, 'installation'); await mkdir(root, { mode: 0o700 });
  const layout = resolveProductLayout({ projectRoot: root });
  return { base, root, layout };
}
async function file(path: string, bytes: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600);
}
function approvedBackup(layout: ProductLayout, installationId: string, root: string) {
  const authority: BackupAuthority = { installationId, integrity: {} as BackupAuthority['integrity'], principal: verifiedPrincipalSchema.parse({ id: 'owner', issuer: 'fixture', subject: 'owner', assurance: 'os-user', scopeIds: ['scope'] }) };
  const events: AuditEvent[] = [];
  const allow = policyBackupAuthorization({ schemaVersion: 1, revision: 'fixture-explicit-approval', restrictions: [], grants: [
    { id: 'explicit-owner-grant', principals: [{ issuer: 'fixture', subject: 'owner' }], scopes: 'all', actions: ['create', 'verify', 'restore'], resource: { kind: 'backup', ids: [installationId] }, effect: 'allow' }] });
  const storage = new FileBackupStorage({ layout, projectRoot: root, installationId, keyFile: 'authority.key' }, limits);
  return { app: new BackupApplication(storage, allow, async event => { events.push(event); }, authority), events, authority, allow };
}
it('a forged/null/extended marker only refuses transfer; it never grants an unsealed identity', () => {
  for (const record of [{ realmSeal: null }, { realmSeal: { fixture: 'forged' } }, { fixture: 'realm-sealed' }, { schemaVersion: 3 }]) {
    expect(() => assertUnsealedInstallation(record)).toThrow('BACKUP_REALM_SEALED');
  }
  expect(() => parseBeuserRealmSeal({ ...seal, disabled: true })).toThrow();
  expect(() => assertUnsealedInstallation({ schemaVersion: 2, installationId: 'ordinary' })).not.toThrow();
});
it('trusted genesis creates fresh durable sealed identity; flags, reopen and relocation cannot strip it', async context => {
  if (process.platform !== 'linux') { context.skip('verify-not-run: POSIX installation binding'); return; }
  const f = await fixture();
  const source = { capture: async () => { const info = await stat(f.layout.root, { bigint: true }); return { schemaVersion: 2 as const, strength: 'weak' as const, source: 'location' as const,
    canonicalRoot: f.layout.root, device: String(info.dev), inode: String(info.ino) }; } };
  const store = new FileInstallationIdentityStore(f.layout, undefined, source, {}, async () => seal);
  const identity = await store.loadOrCreate();
  expect(identity.realmSeal).toEqual(seal);
  const path = join(productResourcePath(f.layout, 'installationIdentity'), 'identity.json');
  expect(installationIdentityRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')))).toMatchObject({ schemaVersion: 3, realmSeal: seal });
  expect((await new FileInstallationIdentityStore(f.layout, undefined, source, { requireMachineBinding: false }).loadOrCreate()).realmSeal).toEqual(seal);
  await expect(store.resolveRelocation('new', { issuer: 'fixture', subject: 'owner' })).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RESOLUTION_INVALID' });
  const before = await readFile(path, 'utf8');
  await file(path, JSON.stringify({ schemaVersion: 1, installationId: identity.installationId }));
  await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
  expect(await readFile(path, 'utf8')).not.toBe(before);
});
it('explicitly approved backup/export and startup VACUUM refuse a sealed ledger before any copy', async context => {
  if (process.platform === 'win32') { context.skip('verify-not-run: POSIX private backup files'); return; }
  const f = await fixture();
  await file(join(productResourcePath(f.layout, 'installationIdentity'), 'identity.json'), JSON.stringify({ schemaVersion: 3, realmSeal: seal }));
  const approved = approvedBackup(f.layout, 'fixture-installation', f.root), set = join(f.base, 'export');
  const command = { schemaVersion: 1 as const, scopeId: 'scope', action: 'create' as const, set };
  expect((await approved.allow(command, approved.authority)).effect).toBe('allow');
  await expect(approved.app.execute(command, phrase)).rejects.toMatchObject({ code: 'BACKUP_REALM_SEALED' });
  expect(approved.events.map(event => event.subject)).toMatchObject([{ phase: 'intent' }, { phase: 'failed', code: 'BACKUP_REALM_SEALED' }]);
  await expect(stat(set)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(createBackupSet(f.layout, f.root, 'fixture-installation', 'authority.key', set, phrase, limits)).rejects.toMatchObject({ code: 'BACKUP_REALM_SEALED' });
  const ledger = join(f.root, 'ledger.db'), options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
  openSqliteLedger(ledger, options).close();
  // No-op opens are permitted: the absolute ban is on backup/restore, not ordinary sealed runtime startup.
  expect(upgradeExistingLedger(ledger, options, join(f.base, 'backups'), new Date(), undefined, undefined, { realmSeal: seal })).toBeNull();
  const db = new DatabaseSync(ledger); db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL); db.close();
  expect(() => upgradeExistingLedger(ledger, options, join(f.base, 'backups'), new Date(), undefined, undefined, { realmSeal: seal })).toThrow('BACKUP_REALM_SEALED');
  await expect(stat(join(f.base, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('normal backup roundtrip stays valid; sealed destination and cryptographically valid sealed import refuse under explicit grants', async context => {
  if (process.platform === 'win32') { context.skip('verify-not-run: POSIX private backup files'); return; }
  const f = await fixture(), installationId = 'temporary';
  await file(join(productResourcePath(f.layout, 'installationIdentity'), 'identity.json'), JSON.stringify({ installationId }));
  for (const resource of ['config', 'policy', 'bindings'] as const) await file(productResourcePath(f.layout, resource), '{}');
  const material = Buffer.alloc(32, 9);
  await file(join(productResourcePath(f.layout, 'approvals'), 'authority.key'), material);
  const ledger = productResourcePath(f.layout, 'ledger'); await mkdir(dirname(ledger), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(ledger); db.exec('CREATE TABLE fixture(value TEXT);'); db.close(); await chmod(ledger, 0o600);
  const approved = approvedBackup(f.layout, installationId, f.root), set = join(f.base, 'set');
  await approved.app.execute({ schemaVersion: 1, scopeId: 'scope', action: 'create', set }, phrase);
  const verified = await verifyBackupSet(set, phrase, limits); expect(verified.state.schemaVersion).toBe(2); verified.close();
  const target = await fixture();
  await file(join(productResourcePath(target.layout, 'installationIdentity'), 'identity.json'), JSON.stringify({ installationId, realmSeal: seal }));
  const restore = { schemaVersion: 1 as const, scopeId: 'scope', action: 'restore' as const, set, target: target.root, confirmTarget: target.root };
  expect((await approved.allow(restore, approved.authority)).effect).toBe('allow');
  await expect(approved.app.execute(restore, phrase)).rejects.toMatchObject({ code: 'BACKUP_REALM_SEALED' });
  await expect(stat(productResourcePath(target.layout, 'ledger'))).rejects.toMatchObject({ code: 'ENOENT' });
  // Independent archive-v2/AEAD fixture: recompute integrity, so the test reaches the seal gate rather than a tamper/password refusal.
  const archivePath = join(set, 'state.archive.json.gz');
  const state = JSON.parse(gunzipSync(await readFile(archivePath)).toString('utf8'));
  const identity = state.entries.find((entry: { resource: string; path: string }) => entry.resource === 'installationIdentity' && entry.path === 'identity.json');
  identity.content = Buffer.from(JSON.stringify({ installationId, realmSeal: seal })).toString('base64');
  await file(archivePath, gzipSync(JSON.stringify(state)));
  let payload = '';
  for (const name of ['ledger.db', 'ledger.fingerprint.json', 'state.archive.json.gz']) payload += `${sha256(await readFile(join(set, name)))}  ${name}\n`;
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await new Promise<Buffer>((resolve, reject) => scrypt(phrase, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 100663296 }, (error, key) => error ? reject(error) : resolve(key)));
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(payload));
  const ciphertext = Buffer.concat([cipher.update(material), cipher.final()]); key.fill(0);
  const envelope = JSON.stringify({ schemaVersion: 1, kdf: 'scrypt', cipher: 'aes-256-gcm', salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') });
  await file(join(set, 'authority.key.enc'), envelope);
  await file(join(set, 'MANIFEST.sha256'), payload + `${sha256(envelope)}  authority.key.enc\n`);
  const verify = { schemaVersion: 1 as const, scopeId: 'scope', action: 'verify' as const, set };
  expect((await approved.allow(verify, approved.authority)).effect).toBe('allow');
  await expect(approved.app.execute(verify, phrase)).rejects.toMatchObject({ code: 'BACKUP_REALM_SEALED' });
  await expect(approved.app.execute({ ...restore, target: join(f.base, 'never-created'), confirmTarget: join(f.base, 'never-created') }, phrase)).rejects.toMatchObject({ code: 'BACKUP_REALM_SEALED' });
  await expect(stat(join(f.base, 'never-created'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('application seal guard refuses even an explicitly allowed custom storage adapter before storage effects', async () => {
  const authority: BackupAuthority = { installationId: 'fixture', integrity: {} as BackupAuthority['integrity'],
    principal: verifiedPrincipalSchema.parse({ id: 'owner', issuer: 'fixture', subject: 'owner', assurance: 'os-user', scopeIds: ['scope'] }) };
  const storage = { execute: vi.fn(async () => { throw new Error('storage must not be reached'); }) }, events: AuditEvent[] = [];
  const app = new BackupApplication(storage, async () => ({ effect: 'allow', policyRevision: 'explicit-owner-grant', ruleId: 'approved' }),
    async event => { events.push(event); }, authority, Date.now, async () => ({ realmSeal: seal }));
  await expect(app.execute({ schemaVersion: 1, scopeId: 'scope', action: 'create', set: '/fixture/export' }, phrase)).rejects.toMatchObject({ code: 'BACKUP_REALM_SEALED' });
  expect(storage.execute).not.toHaveBeenCalled();
  expect(events.map(event => event.subject)).toMatchObject([{ phase: 'intent' }, { phase: 'failed', code: 'BACKUP_REALM_SEALED' }]);
});
