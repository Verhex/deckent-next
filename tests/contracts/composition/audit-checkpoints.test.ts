import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openLocalIntegrityAuthority, openSqliteAuditStore, readLocalOsIdentity } from '#adapters/index.js';
import { AuditApplication } from '#engine/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { verifyConfiguredAuditCheckpoints } from '#composition/core/audit/index.js';
import { main } from '#surfaces/core/cli/index.js';
const roots: string[] = [];
beforeEach(context => { if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: scoped policy verification requires a supported local OS principal'); });
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-audit-composed-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  const layout = resolveProductLayout({ projectRoot: project, root: data });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite }, audit_checkpoints: { schemaVersion: 1, everyRecords: 1 }, approvals: { keyFile: 'authority.key' } }), { mode: 0o600 });
  const principal = readLocalOsIdentity();
  const policy = join(data, 'policy.json');
  await writeFile(policy, JSON.stringify({ schemaVersion: 1, revision: 'audit-policy', restrictions: [], grants: [{ id: 'scope-read', effect: 'allow', actions: ['inspect'],
    scopes: ['scope'], principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'scope', ids: ['scope'] } }] }), { mode: 0o600 });
  const ledger = await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
  const store = await openSqliteAuditStore(ledger, sqlite, 'allow');
  const integrity = await openLocalIntegrityAuthority(layout, 'authority.key', true);
  try { new AuditApplication(store, integrity, { everyRecords: 1 }).record({ schemaVersion: 1, eventId: 'event', scopeId: 'scope', principal: { issuer: principal.issuer, subject: principal.subject },
    policyRevision: 'audit-policy', atMs: 1, subject: { kind: 'model-ingress', fieldDigest: 'a'.repeat(64), projectedDigest: 'b'.repeat(64), decodedDigest: null, codePoints: 1, disposition: 'note' } }); }
  finally { store.close(); }
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') };
  return { project, data, ledger, policy, env };
}
it('real scoped composition and CLI verify/export without mutating the ledger or pinning scopes', async () => {
  const f = await fixture(), command = { schemaVersion: 1, scopeId: 'scope' } as const;
  const before = await readFile(f.ledger), read = await verifyConfiguredAuditCheckpoints(f.project, command, { env: f.env });
  expect(read).toMatchObject({ status: 'verified', checkpoints: 1, pendingRecords: 0 });
  expect((await verifyConfiguredAuditCheckpoints(f.project, { ...command, anchor: read.anchor! }, { env: f.env })).anchor).toEqual(read.anchor);
  let out = '';
  expect(await main(['audit', 'verify', '--scope', 'scope', '--json'], { root: f.project, env: f.env, stdout: { write(value) { out += value; } },
    verifyAuditCheckpoints: verifyConfiguredAuditCheckpoints })).toBe(0);
  expect(JSON.parse(out)).toEqual(read); expect(await readFile(f.ledger)).toEqual(before);
  const raw = new DatabaseSync(f.ledger, { readOnly: true });
  try { expect(raw.prepare('SELECT count(*) AS n FROM scope_registry').get()?.n).toBe(0); } finally { raw.close(); }
});
it('denies another scope before opening custody and never recreates a missing integrity key', async () => {
  const f = await fixture();
  const layout = resolveProductLayout({ projectRoot: f.project, root: f.data });
  const { productResourcePath } = await import('#platform/index.js');
  const key = join(productResourcePath(layout, 'approvals'), 'authority.key');
  await rm(key, { force: true });
  await expect(verifyConfiguredAuditCheckpoints(f.project, { schemaVersion: 1, scopeId: 'other' }, { env: f.env })).rejects.toThrow();
  await expect(verifyConfiguredAuditCheckpoints(f.project, { schemaVersion: 1, scopeId: 'scope' }, { env: f.env })).rejects.toThrow();
  await expect(readFile(key)).rejects.toMatchObject({ code: 'ENOENT' });
});
