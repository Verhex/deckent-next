import { expect, it } from 'vitest';
import { AuthenticationError, ServicePolicyAuthorization, ServiceShutdownApplication,
  type ServiceShutdownAdmissionResult, type ServiceShutdownStore, type ShutdownAdmission } from '#engine/index.js';

const instance = { scopeId: 'service-scope', serviceId: 'runtime', instanceId: 'instance-1' } as const;
const principal = { id: 'local-user', issuer: 'installation', subject: '1000', assurance: 'os-user' as const, scopeIds: ['service-scope'] };
const actor = { principal, evidence: { method: 'os-peer' as const, pid: 41, uid: 1000, gid: 1000 } };
const command = { schemaVersion: 1 as const, commandId: 'shutdown-1', serviceId: 'runtime', instanceId: 'instance-1', reason: 'operator request' };
const grant = { id: 'shutdown-grant', effect: 'allow' as const, actions: ['shutdown'], scopes: ['service-scope'],
  principals: [{ issuer: 'installation', subject: '1000' }], resource: { kind: 'service', ids: ['runtime'] } };
const policy = { schemaVersion: 1 as const, revision: 'policy-1', restrictions: [], grants: [grant] };

function admission(overrides: Partial<ShutdownAdmission> = {}): ShutdownAdmission {
  return { schemaVersion: 1 as const, scopeId: instance.scopeId, command, actor,
    authorization: { revision: 'policy-1', ruleId: 'shutdown-grant' }, admittedAtMs: 10, ...overrides };
}
function application(openStore: () => Promise<ServiceShutdownStore>, authorization = {
  async authorize() { return { revision: 'policy-1', ruleId: 'shutdown-grant' }; },
}, authentication = { async verify() { return actor; } }) {
  return new ServiceShutdownApplication(instance, authentication, authorization, openStore, () => 10);
}

it('rejects authentication and foreign-instance requests before opening the audit store', async () => {
  let opened = 0;
  const openStore = async (): Promise<ServiceShutdownStore> => { opened++; throw new Error('must not open'); };
  const failedAuthentication = application(openStore, undefined, { async verify() { throw new Error('untrusted'); } });
  await expect(failedAuthentication.admit(command, 'forged')).rejects.toBeInstanceOf(AuthenticationError);
  expect(opened).toBe(0);

  const wrongInstance = application(openStore);
  await expect(wrongInstance.admit({ ...command, instanceId: 'other-instance' }, undefined))
    .rejects.toMatchObject({ code: 'SERVICE_SHUTDOWN_INSTANCE' });
  expect(opened).toBe(0);
});

it('reauthorizes a replay and rejects a revoked service grant before it opens the journal', async () => {
  let current: unknown = policy;
  const authorization = new ServicePolicyAuthorization({ async load() { return current; } });
  let opened = 0; let admissions = 0; let closed = 0;
  const store: ServiceShutdownStore = {
    async admitServiceShutdown(value) { admissions++; return { admission: value, replayed: admissions > 1 }; },
    async readServiceShutdown() { return null; },
    async retainServiceShutdownOutcome(value) { return value; },
    close() { closed++; },
  };
  const app = application(async () => { opened++; return store; }, authorization);
  await expect(app.admit(command, undefined)).resolves.toMatchObject({ replayed: false });
  current = { ...policy, revision: 'revoked', grants: [] };
  await expect(app.admit(command, undefined)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect({ opened, admissions, closed }).toEqual({ opened: 1, admissions: 1, closed: 1 });
});

it('maps journal open, admission, and close failures to typed audit-unavailable rejection', async () => {
  const failures: readonly [string, () => Promise<ServiceShutdownStore>][] = [
    ['open', async () => { throw new Error('open failed'); }],
    ['admit', async () => ({
      async admitServiceShutdown() { throw new Error('audit write failed'); },
      async readServiceShutdown() { return null; }, async retainServiceShutdownOutcome(value) { return value; }, close() {},
    })],
    ['close', async () => ({
      async admitServiceShutdown(value) { return { admission: value, replayed: false }; },
      async readServiceShutdown() { return null; }, async retainServiceShutdownOutcome(value) { return value; }, close() { throw new Error('close failed'); },
    })],
  ];
  for (const entry of failures) {
    const openStore = entry[1];
    await expect(application(openStore).admit(command, undefined)).rejects.toMatchObject({ code: 'SERVICE_SHUTDOWN_AUDIT_UNAVAILABLE' });
  }
});

it('rejects a corrupted stored receipt without claiming a shutdown admission', async () => {
  let closed = 0;
  const app = application(async () => ({
    async admitServiceShutdown(): Promise<ServiceShutdownAdmissionResult> {
      return { replayed: true, admission: admission({ command: { ...command, reason: 'forged receipt' } }) };
    },
    async readServiceShutdown() { return null; }, async retainServiceShutdownOutcome(value) { return value; }, close() { closed++; },
  }));
  await expect(app.admit(command, undefined)).rejects.toMatchObject({ code: 'SERVICE_SHUTDOWN_CORRUPT' });
  expect(closed).toBe(1);
});

it('returns the original immutable audit receipt, closes its store, and exposes no lifecycle effect', async () => {
  const original = admission({ admittedAtMs: 1, authorization: { revision: 'policy-0', ruleId: 'earlier-grant' } });
  let closed = 0;
  const result = await application(async () => ({
    async admitServiceShutdown(): Promise<ServiceShutdownAdmissionResult> { return { replayed: true, admission: original }; },
    async readServiceShutdown() { return null; }, async retainServiceShutdownOutcome(value) { return value; }, close() { closed++; },
  })).admit(command, undefined);
  expect(result).toEqual({ replayed: true, admission: original });
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.admission)).toBe(true);
  expect(closed).toBe(1);
  expect(Object.keys(result)).toEqual(['replayed', 'admission']);
});
