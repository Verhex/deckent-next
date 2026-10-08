import { describe, expect, it } from 'vitest';
import { SecretStoreSwitch, isSecretStoreDowngrade, policySecretStoreSwitchAuthorization, type SecretStore, type SecretStoreSwitchPorts } from '#engine/index.js';
import { firstRunPolicyTemplate, resolvePolicyBindings, type AuditEvent } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';

// SECRET-STORE-SWITCH (owner 2026-10-08, option B): one governed operation moves every secret into another registered store and selects it.
// Synthetic values only.
const ENV = 'core.secret-store.env@1', FILE = 'core.secret-store.file@1', SEALED = 'core.secret-store.encrypted-file@1';
const me = { issuer: 'os', subject: '1000' };

function memoryStore(id: string, entries: Record<string, string> = {}, options: { writable?: boolean; enumerable?: boolean; log?: string[] } = {}) {
  const data = new Map(Object.entries(entries)), log = options.log ?? [];
  const failures = { delete: false, readBack: false };
  const store: SecretStore = {
    descriptor: { id, writable: options.writable ?? true, enumerable: options.enumerable ?? true },
    async get(name) { return failures.readBack ? 'altered' : data.get(name); },
    async set(name, value) { log.push(`set ${id} ${name}`); data.set(name, value); },
    async delete(name) { log.push(`delete ${id} ${name}`); if (failures.delete) throw new Error('crash'); return data.delete(name); },
    async listNames() { return [...data.keys()].sort(); },
    async inspect() { return { status: 'ready', code: null }; },
  };
  return { store, data, failures, log };
}
function harness(selected: string | null, stores: Record<string, ReturnType<typeof memoryStore>>, effect: 'allow' | 'deny' | 'require-approval' = 'allow') {
  const log: string[] = [], audits: AuditEvent[] = []; let selection = selected, digest = 'digest-0';
  const ports: SecretStoreSwitchPorts = {
    has: id => Object.hasOwn(stores, id), open: id => stores[id]!.store,
    selection: {
      async read() { return { store: selection, digest }; },
      async publish(store, expect) { if (expect !== digest) throw new Error('raced'); log.push(`publish ${store}`); selection = store; digest = `digest-${store}`; },
    },
    authorize: async () => ({ policyRevision: 'p1', effect, ruleId: effect === 'allow' ? 'first-run-secret-switch' : null }),
    audit: event => { log.push('audit'); audits.push(event); }, now: () => 1,
  };
  for (const entry of Object.values(stores)) entry.log.push = (...items: string[]) => log.push(...items);
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
    expect(h.log).toEqual(['audit', `set ${SEALED} A_KEY`, `set ${SEALED} B_KEY`, `publish ${SEALED}`, `delete ${FILE} A_KEY`, `delete ${FILE} B_KEY`]);
    expect([...sealed.data]).toEqual([['A_KEY', 'synthetic-a'], ['B_KEY', 'synthetic-b']]);
    expect(file.data.size).toBe(0);
    expect(h.audits[0]!.subject).toEqual({ kind: 'secret-store-switch', from: FILE, to: SEALED, entries: 2, downgrade: false,
      decision: { effect: 'allow', ruleId: 'first-run-secret-switch' } });
    expect(JSON.stringify(h.audits)).not.toContain('synthetic');
  });

  it('a fresh installation (environment, nothing to move) only changes the selection', async () => {
    const h = harness(null, { [ENV]: memoryStore(ENV, {}, { writable: false, enumerable: false }), [SEALED]: memoryStore(SEALED) });
    expect(await h.application.switch(request(SEALED))).toMatchObject({ status: 'switched', from: ENV, to: SEALED, entries: 0, cleaned: true });
    expect(h.log).toEqual(['audit', `publish ${SEALED}`]);
  });

  it('a downgrade runs only with an explicit confirmation; refused, nothing is audited, moved or selected', async () => {
    const sealed = memoryStore(SEALED, { A_KEY: 'synthetic-a' }), file = memoryStore(FILE);
    const h = harness(SEALED, { [SEALED]: sealed, [FILE]: file, [ENV]: memoryStore(ENV, {}, { writable: false, enumerable: false }) });
    expect(await code(h.application.switch(request(FILE)))).toBe('SECRET_STORE_DOWNGRADE_UNCONFIRMED');
    expect(h.log).toEqual([]); expect(h.selection()).toBe(SEALED);
    expect(await h.application.switch(request(FILE, true))).toMatchObject({ status: 'switched', downgrade: true, entries: 1 });
    expect(isSecretStoreDowngrade(SEALED, ENV)).toBe(true);
    expect(isSecretStoreDowngrade(ENV, FILE)).toBe(false);
    expect(isSecretStoreDowngrade(FILE, 'enterprise.secret-store.vault@1')).toBe(true);
  });

  it('a read-only target cannot receive secrets; an empty store may move to it (confirmed)', async () => {
    const sealed = memoryStore(SEALED, { A_KEY: 'synthetic-a' });
    const h = harness(SEALED, { [SEALED]: sealed, [ENV]: memoryStore(ENV, {}, { writable: false, enumerable: false }) });
    expect(await code(h.application.switch(request(ENV, true)))).toBe('SECRET_STORE_READ_ONLY');
    expect(h.log).toEqual([]);
    sealed.data.clear();
    expect(await h.application.switch(request(ENV, true))).toMatchObject({ status: 'switched', to: ENV, entries: 0 });
  });

  it('a refused decision is recorded and nothing moves; an unknown target is refused before anything', async () => {
    const file = memoryStore(FILE, { A_KEY: 'synthetic-a' });
    const h = harness(FILE, { [FILE]: file, [SEALED]: memoryStore(SEALED) }, 'deny');
    expect(await code(h.application.switch(request(SEALED)))).toBe('SECRET_STORE_SWITCH_DENIED');
    expect(h.log).toEqual(['audit']); expect(h.audits[0]!.subject).toMatchObject({ decision: { effect: 'deny' } });
    expect(file.data.size).toBe(1); expect(h.selection()).toBe(FILE);
    expect(await code(harness(FILE, { [FILE]: file }).application.switch(request('core.secret-store.nope@1')))).toBe('SECRET_STORE_UNKNOWN');
  });

  it('a copy that does not read back unchanged stops before publication: the old selection and its secrets stay', async () => {
    const file = memoryStore(FILE, { A_KEY: 'synthetic-a' }), sealed = memoryStore(SEALED); sealed.failures.readBack = true;
    const h = harness(FILE, { [FILE]: file, [SEALED]: sealed });
    expect(await code(h.application.switch(request(SEALED)))).toBe('SECRET_STORE_SWITCH_UNVERIFIED');
    expect(h.selection()).toBe(FILE); expect(file.data.get('A_KEY')).toBe('synthetic-a');
    expect(h.log).not.toContain(`publish ${SEALED}`);
  });

  it('a crash after publication leaves secrets reachable (cleaned false); the same switch again removes identical leftovers only', async () => {
    const file = memoryStore(FILE, { A_KEY: 'synthetic-a', B_KEY: 'synthetic-b' }), sealed = memoryStore(SEALED); file.failures.delete = true;
    const stores: Record<string, ReturnType<typeof memoryStore>> = { [FILE]: file, [SEALED]: sealed, [ENV]: memoryStore(ENV, {}, { writable: false, enumerable: false }) };
    const h = harness(FILE, stores);
    expect(await h.application.switch(request(SEALED))).toMatchObject({ status: 'switched', cleaned: false });
    expect(h.selection()).toBe(SEALED); expect(sealed.data.size).toBe(2); expect(file.data.size).toBe(2);
    file.failures.delete = false; file.data.set('B_KEY', 'changed-since'); file.data.set('C_ONLY', 'synthetic-c');
    const again = await new SecretStoreSwitch({ has: id => Object.hasOwn(stores, id), open: id => stores[id]!.store,
      selection: { read: async () => ({ store: SEALED, digest: 'd' }), publish: async () => { throw new Error('not expected'); } },
      authorize: async () => { throw new Error('not expected'); }, audit: () => { throw new Error('not expected'); }, now: () => 1 }).switch(request(SEALED));
    expect(again).toEqual({ schemaVersion: 1, scopeId: 'installation', status: 'current', from: SEALED, to: SEALED, entries: 0, downgrade: false, cleaned: false });
    expect([...file.data.keys()].sort()).toEqual(['B_KEY', 'C_ONLY']);
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
