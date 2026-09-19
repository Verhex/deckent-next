import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { ServicePolicyAuthorization, ServiceShutdownApplication } from '#engine/index.js';

const roots: string[] = [];
const options = { busyTimeoutMs: 20, journalMode: 'wal' as const, durability: 'full' as const };
const instance = { scopeId: 'service-scope', serviceId: 'runtime', instanceId: 'instance-1' } as const;
const command = { schemaVersion: 1 as const, commandId: 'shutdown-1', serviceId: 'runtime', instanceId: 'instance-1', reason: 'operator request' };
const grant = { id: 'shutdown-grant', effect: 'allow' as const, actions: ['shutdown'], scopes: ['service-scope'],
  principals: [{ issuer: 'installation', subject: '1000' }], resource: { kind: 'service', ids: ['runtime'] } };
const policy = { schemaVersion: 1 as const, revision: 'policy-1', restrictions: [], grants: [grant] };

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-shutdown-admission-')); roots.push(root);
  return { path: join(root, 'ledger.db') };
}
function createApplication(path: string, current: () => unknown, peer: () => number) {
  // Synthetic actor fixture only: this test proves SQLite admission, not SO_PEERCRED transport verification.
  return new ServiceShutdownApplication(instance, {
    async verify() {
      const pid = peer(); return { principal: { id: 'local-user', issuer: 'installation', subject: '1000', assurance: 'os-user' as const,
        scopeIds: ['service-scope'] }, evidence: { method: 'os-peer' as const, pid, uid: 1000, gid: 1000 } };
    },
  }, new ServicePolicyAuthorization({ async load() { return current(); } }),
  () => openSqliteAttemptStore(path, options), () => 10);
}
async function count(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Number(db.prepare('SELECT COUNT(*) AS count FROM service_shutdown_commands').get()!.count); }
  finally { db.close(); }
}

it('persists one canonical admission and replays it with fresh peer PID evidence', async () => {
  const { path } = await fixture(); let pid = 41;
  const app = createApplication(path, () => policy, () => pid);
  const first = await app.admit(command, undefined);
  pid = 99;
  const replay = await app.admit(command, undefined);
  expect(first).toMatchObject({ replayed: false, admission: { actor: { evidence: { pid: 41 } }, authorization: { revision: 'policy-1', ruleId: 'shutdown-grant' } } });
  expect(replay).toEqual({ replayed: true, admission: first.admission });
  expect(await count(path)).toBe(1);
});

it('blocks a revoked grant and foreign instance without modifying the durable receipt', async () => {
  const { path } = await fixture(); let current: unknown = policy;
  const app = createApplication(path, () => current, () => 41);
  const recorded = await app.admit(command, undefined);
  current = { ...policy, revision: 'revoked', grants: [] };
  await expect(app.admit(command, undefined)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(app.admit({ ...command, instanceId: 'foreign-instance' }, undefined))
    .rejects.toMatchObject({ code: 'SERVICE_SHUTDOWN_INSTANCE' });
  const store = await openSqliteAttemptStore(path, options);
  try { expect(await store.readServiceShutdown({ scopeId: instance.scopeId, serviceId: instance.serviceId, commandId: command.commandId })).toEqual({ admission: recorded.admission, outcome: null }); }
  finally { store.close(); }
  expect(await count(path)).toBe(1);
});

it('rejects a SQLite audit-write failure and leaves no shutdown row', async () => {
  const { path } = await fixture();
  const setup = await openSqliteAttemptStore(path, options); setup.close();
  const db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER reject_shutdown_audit BEFORE INSERT ON service_shutdown_commands BEGIN SELECT RAISE(ABORT, 'fixture'); END;"); db.close();
  const app = createApplication(path, () => policy, () => 41);
  await expect(app.admit(command, undefined)).rejects.toMatchObject({ code: 'SERVICE_SHUTDOWN_AUDIT_UNAVAILABLE' });
  expect(await count(path)).toBe(0);
});
