import { describe, expect, it } from 'vitest';
import { SecretStoreAdministration, SecretStoreSwitch, isSecretStoreDowngrade, policySecretStoreSwitchAuthorization, type SecretStore, type SecretStoreSwitchPorts } from '#engine/index.js';
import { firstRunPolicyTemplate, resolvePolicyBindings, type AuditEvent } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';

// SECRET-STORE-SWITCH (owner 2026-10-08, option B): one governed operation moves every secret into another registered store and selects it.
// Synthetic values only.
const ENV = 'core.secret-store.env@1', FILE = 'core.secret-store.file@1', SEALED = 'core.secret-store.encrypted-file@1';
const me = { issuer: 'os', subject: '1000' };

const shared: { log: string[] } = { log: [] };
function memoryStore(id: string, entries: Record<string, string> = {}, options: { writable?: boolean; enumerable?: boolean } = {}) {
  const data = new Map(Object.entries(entries));
  const failures = { delete: false, readBack: false };
  const store: SecretStore = {
    descriptor: { id, writable: options.writable ?? true, enumerable: options.enumerable ?? true },
    async get(name) { return failures.readBack ? 'altered' : data.get(name); },
    async set(name, value) { shared.log.push(`set ${id} ${name}`); data.set(name, value); },
    async delete(name) { shared.log.push(`delete ${id} ${name}`); if (failures.delete) throw new Error('crash'); return data.delete(name); },
    async listNames() { return [...data.keys()].sort(); },
    async inspect() { return { status: 'ready', code: null }; },
  };
  return { store, data, failures };
}
function harness(selected: string | null, stores: Record<string, ReturnType<typeof memoryStore>>, effect: 'allow' | 'deny' | 'require-approval' = 'allow') {
  const log: string[] = [], audits: AuditEvent[] = []; let selection = selected, digest = 'digest-0'; shared.log = log;
  const ports: SecretStoreSwitchPorts = {
    has: id => Object.hasOwn(stores, id), open: id => stores[id]!.store,
    selection: {
      async read() { return { store: selection, digest }; },
      async publish(store, expect) { if (expect !== digest) throw new Error('raced'); log.push(`publish ${store}`); selection = store; digest = `digest-${store}`; },
    },
    authorize: async () => ({ policyRevision: 'p1', effect, ruleId: effect === 'allow' ? 'first-run-secret-switch' : null }),
    audit: event => { log.push('audit'); audits.push(event); }, now: () => 1,
    // The custody section as the log sees it: everything the switch does happens between `enter` and `leave`.
    custody: { async exclusive<T>(work: () => Promise<T>) { log.push('enter'); try { return await work(); } finally { log.push('leave'); } },
      selected: async () => selection ?? ENV },
  };
  return { application: new SecretStoreSwitch(ports), log, audits, selection: () => selection };
}
const request = (to: string, confirmDowngrade = false) => ({ principal: me, scopeId: 'installation', to, confirmDowngrade });
const code = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string }) => error.code);

describe('secret store switch', () => {
  it('file → encrypted: audits first, copies and reads back every name, publishes the selection, then deletes the old copies', async () => {
    const file = memoryStore(FILE, { A_KEY: 'synthetic-a', B_KEY: 'synthetic-b' }), sealed = memoryStore(SEALED);
    const h = harness(FILE, { [ENV]: memoryStore(ENV, {}, { writable: false, enumerable: false }), [FILE]: file, [SEALED]: sealed });
    const result = await h.application.switch(request(SEALED));
    expect(result).toEqual({ schemaVersion: 1, scopeId: 'installation', status: 'switched', from: FILE, to: SEALED, entries: 2, downgrade: false, cleaned: true });
    expect(h.log).toEqual(['enter', 'audit', `set ${SEALED} A_KEY`, `set ${SEALED} B_KEY`, `publish ${SEALED}`, `delete ${FILE} A_KEY`, `delete ${FILE} B_KEY`, 'leave']);
    expect([...sealed.data]).toEqual([['A_KEY', 'synthetic-a'], ['B_KEY', 'synthetic-b']]);
    expect(file.data.size).toBe(0);
    expect(h.audits[0]!.subject).toEqual({ kind: 'secret-store-switch', from: FILE, to: SEALED, entries: 2, downgrade: false,
      decision: { effect: 'allow', ruleId: 'first-run-secret-switch' } });
    expect(JSON.stringify(h.audits)).not.toContain('synthetic');
  });

  it('a fresh installation (environment, nothing to move) only changes the selection', async () => {
    const h = harness(null, { [ENV]: memoryStore(ENV, {}, { writable: false, enumerable: false }), [SEALED]: memoryStore(SEALED) });
    expect(await h.application.switch(request(SEALED))).toMatchObject({ status: 'switched', from: ENV, to: SEALED, entries: 0, cleaned: true });
    expect(h.log).toEqual(['enter', 'audit', `publish ${SEALED}`, 'leave']);
  });

  it('a downgrade runs only with an explicit confirmation; refused, nothing is audited, moved or selected', async () => {
    const sealed = memoryStore(SEALED, { A_KEY: 'synthetic-a' }), file = memoryStore(FILE);
    const h = harness(SEALED, { [SEALED]: sealed, [FILE]: file, [ENV]: memoryStore(ENV, {}, { writable: false, enumerable: false }) });
    expect(await code(h.application.switch(request(FILE)))).toBe('SECRET_STORE_DOWNGRADE_UNCONFIRMED');
    expect(h.log).toEqual(['enter', 'leave']); expect(h.selection()).toBe(SEALED);
    expect(await h.application.switch(request(FILE, true))).toMatchObject({ status: 'switched', downgrade: true, entries: 1 });
    expect(isSecretStoreDowngrade(SEALED, ENV)).toBe(true);
    expect(isSecretStoreDowngrade(ENV, FILE)).toBe(false);
    expect(isSecretStoreDowngrade(FILE, 'enterprise.secret-store.vault@1')).toBe(true);
  });

  it('a read-only target cannot receive secrets; an empty store may move to it (confirmed)', async () => {
    const sealed = memoryStore(SEALED, { A_KEY: 'synthetic-a' });
    const h = harness(SEALED, { [SEALED]: sealed, [ENV]: memoryStore(ENV, {}, { writable: false, enumerable: false }) });
    expect(await code(h.application.switch(request(ENV, true)))).toBe('SECRET_STORE_READ_ONLY');
    expect(h.log).toEqual(['enter', 'leave']);
    sealed.data.clear();
    expect(await h.application.switch(request(ENV, true))).toMatchObject({ status: 'switched', to: ENV, entries: 0 });
  });

  it('a refused decision is recorded and nothing moves; an unknown target is refused before anything', async () => {
    const file = memoryStore(FILE, { A_KEY: 'synthetic-a' });
    const h = harness(FILE, { [FILE]: file, [SEALED]: memoryStore(SEALED) }, 'deny');
    expect(await code(h.application.switch(request(SEALED)))).toBe('SECRET_STORE_SWITCH_DENIED');
    expect(h.log).toEqual(['enter', 'audit', 'leave']); expect(h.audits[0]!.subject).toMatchObject({ decision: { effect: 'deny' } });
    expect(file.data.size).toBe(1); expect(h.selection()).toBe(FILE);
    const unknown = harness(FILE, { [FILE]: file });
    expect(await code(unknown.application.switch(request('core.secret-store.nope@1')))).toBe('SECRET_STORE_UNKNOWN');
    expect(unknown.log).toEqual([]);
  });

  it('a copy that does not read back unchanged stops before publication: the old selection and its secrets stay', async () => {
    const file = memoryStore(FILE, { A_KEY: 'synthetic-a' }), sealed = memoryStore(SEALED); sealed.failures.readBack = true;
    const h = harness(FILE, { [FILE]: file, [SEALED]: sealed });
    expect(await code(h.application.switch(request(SEALED)))).toBe('SECRET_STORE_SWITCH_UNVERIFIED');
    expect(h.selection()).toBe(FILE); expect(file.data.get('A_KEY')).toBe('synthetic-a');
    expect(h.log).not.toContain(`publish ${SEALED}`);
  });

  it('a crash after publication leaves secrets reachable (cleaned false); the same switch again removes identical leftovers only, decided and audited', async () => {
    const file = memoryStore(FILE, { A_KEY: 'synthetic-a', B_KEY: 'synthetic-b' }), sealed = memoryStore(SEALED); file.failures.delete = true;
    const stores: Record<string, ReturnType<typeof memoryStore>> = { [FILE]: file, [SEALED]: sealed, [ENV]: memoryStore(ENV, {}, { writable: false, enumerable: false }) };
    const h = harness(FILE, stores);
    expect(await h.application.switch(request(SEALED))).toMatchObject({ status: 'switched', cleaned: false });
    expect(h.selection()).toBe(SEALED); expect(sealed.data.size).toBe(2); expect(file.data.size).toBe(2);
    file.failures.delete = false; file.data.set('B_KEY', 'changed-since'); file.data.set('C_ONLY', 'synthetic-c');
    const again = harness(SEALED, stores);
    expect(await again.application.switch(request(SEALED))).toEqual({ schemaVersion: 1, scopeId: 'installation', status: 'current', from: SEALED, to: SEALED,
      entries: 1, downgrade: false, cleaned: false });
    // The deletion of the identical leftover is a decision recorded before it happens; nothing is published.
    expect(again.log).toEqual(['enter', 'audit', `delete ${FILE} A_KEY`, 'leave']);
    expect(again.audits[0]!.subject).toMatchObject({ kind: 'secret-store-switch', from: SEALED, to: SEALED, entries: 1 });
    expect([...file.data.keys()].sort()).toEqual(['B_KEY', 'C_ONLY']);
    // Nothing identical left: no change, no record.
    const quiet = harness(SEALED, stores);
    expect(await quiet.application.switch(request(SEALED))).toMatchObject({ status: 'current', entries: 0, cleaned: false });
    expect(quiet.log).toEqual(['enter', 'leave']);
  });

  it('a principal the policy denies cannot remove leftovers through a current-target switch', async () => {
    const file = memoryStore(FILE, { A_KEY: 'synthetic-a' }), sealed = memoryStore(SEALED, { A_KEY: 'synthetic-a' });
    const h = harness(SEALED, { [FILE]: file, [SEALED]: sealed }, 'deny');
    expect(await code(h.application.switch(request(SEALED)))).toBe('SECRET_STORE_SWITCH_DENIED');
    expect(h.log).toEqual(['enter', 'audit', 'leave']); expect(file.data.get('A_KEY')).toBe('synthetic-a');
  });

  it('a store that cannot be listed during cleanup leaves the result unverified (cleaned false), other stores are still cleaned (N2)', async () => {
    const file = memoryStore(FILE, { A_KEY: 'synthetic-a' }), sealed = memoryStore(SEALED, { A_KEY: 'synthetic-a' });
    const broken = memoryStore(ENV, {}, { writable: true, enumerable: true });
    broken.store.listNames = async () => { throw new Error('unreadable'); };
    const h = harness(SEALED, { [ENV]: broken, [FILE]: file, [SEALED]: sealed });
    expect(await h.application.switch(request(SEALED))).toMatchObject({ status: 'current', entries: 1, cleaned: false });
    expect(file.data.size).toBe(0);
    const nothingElse = harness(SEALED, { [ENV]: broken, [SEALED]: sealed });
    expect(await nothingElse.application.switch(request(SEALED))).toMatchObject({ status: 'current', entries: 0, cleaned: false });
  });

  it('a secret change runs inside the custody section and refuses typed when the store it opened is no longer selected (Astra 2456 P1-1)', async () => {
    const file = memoryStore(FILE, { A_KEY: 'synthetic-a' }), log: string[] = []; shared.log = log;
    let selected = FILE;
    const custody = { async exclusive<T>(work: () => Promise<T>) { log.push('enter'); try { return await work(); } finally { log.push('leave'); } },
      selected: async () => selected };
    const admin = new SecretStoreAdministration(file.store, async request => { log.push(`authorize ${request.action}`); return { policyRevision: 'p1', effect: 'allow', ruleId: 'r' }; },
      () => { log.push('audit'); }, () => 1, custody);
    await admin.set({ principal: me, scopeId: 'installation', name: 'A_KEY' }, 'synthetic-b');
    expect(log).toEqual(['enter', 'authorize set', 'audit', `set ${FILE} A_KEY`, 'leave']);
    log.length = 0; selected = SEALED;
    expect(await code(admin.set({ principal: me, scopeId: 'installation', name: 'A_KEY' }, 'synthetic-c'))).toBe('SECRET_STORE_CHANGED');
    expect(await code(admin.delete({ principal: me, scopeId: 'installation', name: 'A_KEY' }))).toBe('SECRET_STORE_CHANGED');
    expect(log).toEqual(['enter', 'leave', 'enter', 'leave']); expect(file.data.get('A_KEY')).toBe('synthetic-b');
    expect(ErrorRegistry.has('SECRET_STORE_BUSY')).toBe(true);
  });

  it('policy: the template owner may switch; another principal is refused before evaluation', async () => {
    const template = firstRunPolicyTemplate({ scopeId: 'installation', principal: me, readToolNames: ['read_file'], scratchToolNames: ['scratch_write'],
      scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['edit_file'], writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run',
      proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' });
    const policy = resolvePolicyBindings(template.policy, template.bindings);
    const principal = { id: 'os:1000', issuer: 'os', subject: '1000', assurance: 'os-user' as const, scopeIds: ['installation'] };
    const authorize = policySecretStoreSwitchAuthorization(policy, principal);
    expect(await authorize(request(SEALED))).toMatchObject({ effect: 'allow', ruleId: 'first-run-secret-switch' });
    expect(await code(authorize({ ...request(SEALED), principal: { issuer: 'os', subject: 'other' } }))).toBe('SECRET_STORE_SWITCH_DENIED');
    expect(ErrorRegistry.has('SECRET_STORE_SWITCH_UNVERIFIED')).toBe(true);
  });
});
