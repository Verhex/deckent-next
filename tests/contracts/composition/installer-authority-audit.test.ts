import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { auditEventSchema } from '#domain/index.js';
import { AuditApplication, verifyAuditRecord } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteAuditStore } from '#adapters/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { applyPolicyTemplateInstallation, upgradePolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { productResourcePath } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(named: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-installer-audit-')); roots.push(root);
  await applyPolicyTemplateInstallation(root, 's');
  const config = await loadComposedConfig(root, { heal: false });
  const path = productResourcePath(config.productLayout, 'policy');
  const policy = JSON.parse(await readFile(path, 'utf8'));
  const person = named ? { issuer: 'customer-idp', subject: 'alice' } : policy.grants.find((g: { id: string }) => g.id === 'first-run-read-tools').principals[0];
  const next = { ...policy, revision: 'first-run-template-v4', grants: named ? [{ id: 'customer-read', effect: 'allow', actions: ['invoke'], scopes: ['s'],
    principals: [person], resource: { kind: 'agent-tool', ids: ['read_file'] } }] : policy.grants.filter((g: { id: string }) => !['first-run-secret-switch', 'first-run-provider-spending'].includes(g.id)) };
  await writeFile(path, JSON.stringify(next), { mode: 0o600 });
  const upgrade = (apply: boolean, expect?: string) => upgradePolicyTemplateInstallation(root, 's', apply, expect, {}, process.getuid?.(), named ? person : undefined);
  return { root, config, path, person, upgrade };
}

it.skipIf(process.platform === 'win32').each([false, true])('installer template/person=%s: sealed verifiable event without approval/decider, archive retained, preview/conflict/current write no event', async named => {
  const f = await fixture(named), before = await readFile(f.path, 'utf8');
  expect(await f.upgrade(false)).toMatchObject({ status: 'preview' });
  expect(await f.upgrade(true, 'stale')).toMatchObject({ status: 'conflict' });
  expect(await readFile(f.path, 'utf8')).toBe(before);
  const applied = await f.upgrade(true, 'first-run-template-v4');
  expect(applied.status).toBe('upgraded');
  expect(await f.upgrade(true)).toMatchObject({ status: 'current' });
  const store = await openSqliteAuditStore(productResourcePath(f.config.productLayout, 'ledger'), f.config.storage.sqlite);
  try {
    const integrity = await openLocalIntegrityAuthority(f.config.productLayout, f.config.approvals.keyFile);
    const records = new AuditApplication(store, integrity).list('s', 0, 100);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.event.subject).toMatchObject({ kind: 'authority-change', installer: { basis: named ? 'named-person' : 'first-run', person: f.person },
      revision: { before: 'first-run-template-v4', after: applied.revision }, counts: { grantsAdded: applied.rules.length, grantsRemoved: 0, bindingsAdded: 0, bindingsRemoved: 0 } });
    expect(record.event.subject).not.toHaveProperty('approvalId'); expect(record.event.subject).not.toHaveProperty('decider');
    expect(auditEventSchema.safeParse({ ...record.event, subject: { ...record.event.subject, approvalId: 'fabricated' } }).success).toBe(false);
    expect(verifyAuditRecord(record, integrity)).toEqual(record);
    expect(() => verifyAuditRecord({ ...record, event: { ...record.event, policyRevision: 'tampered' } }, integrity)).toThrow('AUDIT_INTEGRITY');
  } finally { store.close(); }
  expect(await readdir(join(productResourcePath(f.config.productLayout, 'audit'), 'authority-revisions'))).not.toHaveLength(0);
});

it.skipIf(process.platform === 'win32')('an unavailable audit ledger prevents installer policy publication', async () => {
  const f = await fixture(false), before = await readFile(f.path, 'utf8');
  // A directory at the ledger file path makes audit preparation fail safely. INSTALL-FLOW: the fresh install already created the ledger; replace it.
  const ledger = productResourcePath(f.config.productLayout, 'ledger');
  for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${ledger}${suffix}`, { force: true });
  await mkdir(dirname(ledger), { recursive: true, mode: 0o700 });
  await mkdir(ledger, { mode: 0o700 });
  await expect(f.upgrade(true)).rejects.toThrow();
  expect(await readFile(f.path, 'utf8')).toBe(before);
});

it.skipIf(process.platform === 'win32')('a sealing/persistence refusal in the authority writer callback prevents publication', async () => {
  const f = await fixture(false), before = await readFile(f.path, 'utf8');
  vi.spyOn(AuditApplication.prototype, 'record').mockImplementationOnce(() => { throw new Error('AUDIT_UNAVAILABLE'); });
  await expect(f.upgrade(true)).rejects.toThrow('AUDIT_UNAVAILABLE');
  expect(await readFile(f.path, 'utf8')).toBe(before);
});
