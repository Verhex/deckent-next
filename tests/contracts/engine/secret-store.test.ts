import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { auditEventSchema } from '#domain/index.js';
import { AuditApplication, SECRET_STORE_PORT_VERSION, SecretStoreAdministration, policySecretChangeAuthorization, SecretStoreRegistry, isSecretName, type SecretStore,
  type SecretStoreFactory } from '#engine/index.js';
import { createFileSecretStore, openSqliteAuditStore } from '#adapters/index.js';
import { createHmacIntegrity } from '#platform/index.js';

const CANARY = 'synthetic-canary-2d9e4b-not-a-real-key';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };

const memoryFactory = (id: string, values = new Map<string, string>()): SecretStoreFactory => ({ id, create: () => ({
  descriptor: { id, writable: true, enumerable: true },
  async get(name) { return values.get(name); }, async set(name, value) { values.set(name, value); },
  async delete(name) { return values.delete(name); }, async listNames() { return [...values.keys()].sort(); },
  async inspect() { return { status: 'ready', code: null }; } }) });
const context = { env: {}, platform: 'linux', root: null };

it('port v1 name grammar is the $DECK reference grammar with a bound', () => {
  expect(SECRET_STORE_PORT_VERSION).toBe(1);
  for (const name of ['A', '_A', 'PROVIDER_TOKEN_2', 'A'.repeat(128)]) expect(isSecretName(name)).toBe(true);
  for (const name of ['', 'a', '1A', 'A-B', 'A.B', 'A'.repeat(129), '__proto__', 'constructor']) expect(isSecretName(name)).toBe(false);
});

it('registry: Core backends at construction, namespaced overlays after, sealed afterwards; unknown ids are typed refusals', () => {
  const registry = SecretStoreRegistry.create([memoryFactory('core.secret-store.env@1'), memoryFactory('core.secret-store.file@1')]);
  expect(registry.ids()).toEqual(['core.secret-store.env@1', 'core.secret-store.file@1']);
  expect(() => registry.register(memoryFactory('core.secret-store.vault@1'))).toThrow(expect.objectContaining({ code: 'REGISTRY_NAMESPACE_RESERVED' }));
  expect(() => registry.register(memoryFactory('not-a-store-id'))).toThrow(expect.objectContaining({ code: 'REGISTRY_MANIFEST_INVALID' }));
  registry.register(memoryFactory('enterprise.secret-store.vault@1'));
  expect(() => registry.register(memoryFactory('enterprise.secret-store.vault@1'))).toThrow(expect.objectContaining({ code: 'REGISTRY_ADAPTER_DUPLICATE' }));
  expect(() => SecretStoreRegistry.create([memoryFactory('enterprise.secret-store.x@1')])).toThrow(expect.objectContaining({ code: 'REGISTRY_NAMESPACE_RESERVED' }));
  registry.seal();
  expect(() => registry.register(memoryFactory('custom.secret-store.other@1'))).toThrow(expect.objectContaining({ code: 'REGISTRY_SEALED' }));
  expect(registry.has('enterprise.secret-store.vault@1')).toBe(true);
  expect(registry.open('enterprise.secret-store.vault@1', context).descriptor.id).toBe('enterprise.secret-store.vault@1');
  expect(() => registry.open('enterprise.secret-store.missing@1', context)).toThrow(expect.objectContaining({ code: 'SECRET_STORE_UNKNOWN' }));
  // A factory whose store claims another identity is refused: the audit names the backend by the registry's id.
  const lying = SecretStoreRegistry.create([{ id: 'core.secret-store.env@1', create: () => memoryFactory('core.secret-store.file@1').create(context) }]);
  expect(() => lying.open('core.secret-store.env@1', context)).toThrow(expect.objectContaining({ code: 'REGISTRY_FACTORY_MISMATCH' }));
});

async function ledger() {
  const base = await mkdtemp(join(tmpdir(), 'deckent-secret-admin-'));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'global'), { mode: 0o700 });
  const store = await openSqliteAuditStore(join(base, 'ledger.db'), sqlite, 'allow');
  cleanups.push(async () => store.close());
  const audit = new AuditApplication(store, createHmacIntegrity('audit-key', randomBytes(32)));
  return { base, audit, file: createFileSecretStore({ root: join(base, 'global'), platform: 'linux' }) };
}
const principal = { issuer: 'local-os', subject: '1000' };
const allow = (policyRevision = 'rev-1', ruleId = 'secret-rule') => ({ policyRevision, effect: 'allow' as const, ruleId });

it('administration: authorize, then a sealed secret-change audit (name + backend + principal + decision, never the value), then the write', async () => {
  const f = await ledger(), order: string[] = [];
  const admin = new SecretStoreAdministration(f.file, async request => { order.push(`authorize:${request.action}:${request.name}`); return allow(); },
    event => { order.push(`audit:${event.subject.kind}`); f.audit.record(event); }, () => 42);
  await admin.set({ principal, scopeId: 'installation', name: 'PROVIDER_TOKEN' }, CANARY);
  expect(await f.file.get('PROVIDER_TOKEN')).toBe(CANARY);
  expect(await admin.delete({ principal, scopeId: 'installation', name: 'PROVIDER_TOKEN' })).toBe(true);
  expect(order).toEqual(['authorize:set:PROVIDER_TOKEN', 'audit:secret-change', 'authorize:delete:PROVIDER_TOKEN', 'audit:secret-change']);
  const records = f.audit.list('installation', 0, 10);
  expect(records.map(record => record.event.subject)).toEqual([
    { kind: 'secret-change', action: 'set', name: 'PROVIDER_TOKEN', backend: 'core.secret-store.file@1', decision: { effect: 'allow', ruleId: 'secret-rule' } },
    { kind: 'secret-change', action: 'delete', name: 'PROVIDER_TOKEN', backend: 'core.secret-store.file@1', decision: { effect: 'allow', ruleId: 'secret-rule' } }]);
  expect(records[0]!.event).toMatchObject({ principal, policyRevision: 'rev-1', atMs: 42, scopeId: 'installation' });
  // The sealed ledger bytes and the audit view never hold the value.
  expect(JSON.stringify(records)).not.toContain(CANARY);
  for (const name of await readdir(f.base)) if (name.startsWith('ledger.db')) expect((await readFile(join(f.base, name))).includes(Buffer.from(CANARY))).toBe(false);
  // The audit contract refuses a value field, a malformed name or a missing decision at the schema.
  const event = records[0]!.event;
  expect(auditEventSchema.safeParse({ ...event, subject: { ...event.subject, value: CANARY } }).success).toBe(false);
  expect(auditEventSchema.safeParse({ ...event, subject: { ...event.subject, name: 'lower' } }).success).toBe(false);
  const undecided = Object.fromEntries(Object.entries(event.subject).filter(([key]) => key !== 'decision'));
  expect(auditEventSchema.safeParse({ ...event, subject: undecided }).success).toBe(false);
});

it('administration: no audit record, no change; an authorization that fails writes and audits nothing', async () => {
  const f = await ledger(); let audited = 0;
  const failingAudit = new SecretStoreAdministration(f.file, async () => allow('rev'), () => { throw new Error('AUDIT_UNAVAILABLE'); }, () => 1);
  await expect(failingAudit.set({ principal, scopeId: 'installation', name: 'A' }, CANARY)).rejects.toThrow('AUDIT_UNAVAILABLE');
  expect(await f.file.listNames()).toEqual([]);
  const unavailable = new SecretStoreAdministration(f.file, async () => { throw Object.assign(new Error('POLICY_UNAVAILABLE'), { code: 'POLICY_UNAVAILABLE' }); },
    () => { audited++; }, () => 1);
  await expect(unavailable.set({ principal, scopeId: 'installation', name: 'A' }, CANARY)).rejects.toMatchObject({ code: 'POLICY_UNAVAILABLE' });
  expect(audited).toBe(0); expect(await f.file.listNames()).toEqual([]);
});

it('administration: a refusal is audited with its decision and nothing is written; an unrecordable refusal is still a refusal', async () => {
  const f = await ledger();
  const deny = new SecretStoreAdministration(f.file, async () => ({ policyRevision: 'rev-2', effect: 'deny', ruleId: null }), event => { f.audit.record(event); }, () => 7);
  const error = await deny.set({ principal, scopeId: 'installation', name: 'OPENAI_API_KEY' }, CANARY).then(() => null, (caught: unknown) => caught);
  expect(error).toMatchObject({ code: 'SECRET_CHANGE_DENIED', params: { action: 'set', name: 'OPENAI_API_KEY' } });
  expect(JSON.stringify(error)).not.toContain(CANARY); expect(String((error as Error).message)).not.toContain(CANARY);
  await expect(deny.delete({ principal, scopeId: 'installation', name: 'OPENAI_API_KEY' })).rejects.toMatchObject({ code: 'SECRET_CHANGE_DENIED', params: { action: 'delete' } });
  const approval = new SecretStoreAdministration(f.file, async () => ({ policyRevision: 'rev-2', effect: 'require-approval', ruleId: 'ask' }), event => { f.audit.record(event); }, () => 8);
  await expect(approval.set({ principal, scopeId: 'installation', name: 'A' }, CANARY)).rejects.toMatchObject({ code: 'POLICY_APPROVAL_UNSUPPORTED' });
  expect(await f.file.listNames()).toEqual([]);
  expect(f.audit.list('installation', 0, 10).map(record => record.event.subject)).toEqual([
    { kind: 'secret-change', action: 'set', name: 'OPENAI_API_KEY', backend: 'core.secret-store.file@1', decision: { effect: 'deny', ruleId: null } },
    { kind: 'secret-change', action: 'delete', name: 'OPENAI_API_KEY', backend: 'core.secret-store.file@1', decision: { effect: 'deny', ruleId: null } },
    { kind: 'secret-change', action: 'set', name: 'A', backend: 'core.secret-store.file@1', decision: { effect: 'require-approval', ruleId: 'ask' } }]);
  const unrecordable = new SecretStoreAdministration(f.file, async () => ({ policyRevision: 'rev-2', effect: 'deny', ruleId: null }), () => { throw new Error('AUDIT_UNAVAILABLE'); }, () => 9);
  await expect(unrecordable.set({ principal, scopeId: 'installation', name: 'A' }, CANARY)).rejects.toMatchObject({ code: 'SECRET_CHANGE_DENIED' });
  expect(await f.file.listNames()).toEqual([]);
});

it('policySecretChangeAuthorization: the policy cell is resource kind secret, action set|delete, id = the name, for the verified principal in the scope', async () => {
  const verified = { id: 'os:1000', issuer: 'local-os', subject: '1000', assurance: 'os-user' as const, scopeIds: ['installation'] };
  const policy = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'set-one', effect: 'allow', actions: ['set'], scopes: ['installation'], principals: [principal], resource: { kind: 'secret', ids: ['PROVIDER_TOKEN'] } },
    { id: 'other', effect: 'allow', actions: 'all', scopes: 'all', principals: [{ issuer: 'local-os', subject: '1001' }], resource: { kind: 'secret', ids: 'all' } }] };
  const authorize = policySecretChangeAuthorization(policy, verified);
  expect(await authorize({ principal, scopeId: 'installation', name: 'PROVIDER_TOKEN', action: 'set' })).toEqual({ policyRevision: 'p', effect: 'allow', ruleId: 'set-one' });
  expect(await authorize({ principal, scopeId: 'installation', name: 'PROVIDER_TOKEN', action: 'delete' })).toEqual({ policyRevision: 'p', effect: 'deny', ruleId: null });
  expect(await authorize({ principal, scopeId: 'installation', name: 'OTHER', action: 'set' })).toEqual({ policyRevision: 'p', effect: 'deny', ruleId: null });
  expect(await authorize({ principal, scopeId: 'elsewhere', name: 'PROVIDER_TOKEN', action: 'set' })).toMatchObject({ effect: 'deny' });
  // The request's principal must be the verified one: a mismatch is refused, never evaluated for someone else.
  await expect(authorize({ principal: { issuer: 'local-os', subject: '1001' }, scopeId: 'installation', name: 'PROVIDER_TOKEN', action: 'set' }))
    .rejects.toMatchObject({ code: 'SECRET_CHANGE_DENIED' });
});

it('administration: input is checked before authority is asked; a read-only backend is refused before any audit', async () => {
  const f = await ledger(); const asked: string[] = [];
  const admin = new SecretStoreAdministration(f.file, async request => { asked.push(request.name); return allow('r'); }, () => { asked.push('audit'); }, () => 1);
  await expect(admin.set({ principal, scopeId: 'installation', name: 'bad-name' }, 'x')).rejects.toMatchObject({ code: 'SECRET_NAME_INVALID' });
  await expect(admin.set({ principal, scopeId: 'installation', name: 'A' }, '')).rejects.toMatchObject({ code: 'SECRET_VALUE_INVALID' });
  await expect(admin.set({ principal, scopeId: 'installation', name: 'A' }, 'x'.repeat(65_537))).rejects.toMatchObject({ code: 'SECRET_VALUE_INVALID' });
  const readOnly: SecretStore = { ...memoryFactory('core.secret-store.env@1').create(context), descriptor: { id: 'core.secret-store.env@1', writable: false, enumerable: false } };
  await expect(new SecretStoreAdministration(readOnly, async () => allow('r'), () => { asked.push('audit'); }, () => 1)
    .set({ principal, scopeId: 'installation', name: 'A' }, 'x')).rejects.toMatchObject({ code: 'SECRET_STORE_READ_ONLY' });
  expect(asked).toEqual([]);
});
