import { hostname, tmpdir, userInfo } from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createConnection } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { createConfiguredRuntimeClient, startConfiguredRuntimeService } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { ServiceShutdownApplication } from '#engine/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';

const roots: string[] = [];
const observer = { async onPage() {}, async onError() {} };
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(identity: { scopeId: string; serviceId: string } | null = { scopeId: 'service-scope', serviceId: 'runtime' }) {
  const project = await mkdtemp(join(tmpdir(), 'deckent-runtime-shutdown-')); roots.push(project); const data = join(project, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); const env = { HOME: join(project, 'home') };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
    cancellationRuntime: { scopeIds: ['service-scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { identity, inputMaxBytes: 4096, responseMaxBytes: 4096, maxConnections: 4, maxConcurrentRequests: 2,
      maxConcurrentExecutions: 1, headerTimeoutMs: 1000, responseTimeoutMs: 1000, shutdownGraceMs: 1000 },
  }));
  const opened = await openConfiguredAttemptStore(project, { env });
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'grant', restrictions: [], grants: identity ? [{
    id: 'shutdown', effect: 'allow', actions: ['shutdown'], scopes: [identity.scopeId], principals,
    resource: { kind: 'service', ids: [identity.serviceId] },
  }] : [] }), { mode: 0o600 });
  const ledgerPath = opened.path; opened.store.close(); return { project, env, ledgerPath, identity };
}
function command(instanceId: string) { return { schemaVersion: 1 as const, commandId: 'shutdown-1', serviceId: 'runtime', instanceId, reason: 'test shutdown' }; }
function bounded<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SHUTDOWN_TIMING_GATE_TIMEOUT')), 2000);
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

it('describes unconfigured shutdown honestly and rejects its client command', async () => {
  const f = await fixture(null); const service = await startConfiguredRuntimeService(f.project, observer, { env: f.env });
  try {
    const client = createConfiguredRuntimeClient(f.project, { env: f.env });
    expect(await client.describeService()).toMatchObject({ shutdownAvailable: false });
    await expect(client.shutdownService(command('instance-1'))).rejects.toMatchObject({ code: 'SERVICE_SHUTDOWN_INVALID' });
  } finally { await service.stop(); await service.done; }
});

it('records the actual local-peer shutdown admission and clean outcome, then rejects its old instance after restart', async () => {
  const f = await fixture(); const first = await startConfiguredRuntimeService(f.project, observer, { env: f.env });
  const firstClient = createConfiguredRuntimeClient(f.project, { env: f.env }); const descriptor = await firstClient.describeService();
  const admitted = await firstClient.shutdownService(command(descriptor.instanceId));
  expect(admitted).toMatchObject({ replayed: false, admission: { command: { instanceId: descriptor.instanceId } } });
  await first.done;
  const db = new DatabaseSync(f.ledgerPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT record FROM service_shutdown_commands').get() as { record: string };
    const outcome = db.prepare('SELECT record FROM service_shutdown_outcomes').get() as { record: string };
    expect(JSON.parse(row.record)).toMatchObject({ actor: { evidence: { method: 'os-peer', uid: userInfo().uid } } });
    expect(JSON.parse(outcome.record)).toMatchObject({ state: 'clean', remainingRequests: 0, recoveryPending: false });
  } finally { db.close(); }
  const second = await startConfiguredRuntimeService(f.project, observer, { env: f.env });
  try { await expect(createConfiguredRuntimeClient(f.project, { env: f.env }).shutdownService(command(descriptor.instanceId))).rejects.toMatchObject({ code: 'SERVICE_SHUTDOWN_INSTANCE' }); }
  finally { await second.stop(); await second.done; }
});

it('rejects a durable audit insert failure without stopping the live service', async () => {
  const f = await fixture(); const service = await startConfiguredRuntimeService(f.project, observer, { env: f.env });
  try {
    const descriptor = await createConfiguredRuntimeClient(f.project, { env: f.env }).describeService();
    const db = new DatabaseSync(f.ledgerPath);
    db.exec("CREATE TRIGGER reject_shutdown_audit BEFORE INSERT ON service_shutdown_commands BEGIN SELECT RAISE(ABORT, 'fixture'); END;"); db.close();
    const client = createConfiguredRuntimeClient(f.project, { env: f.env });
    await expect(client.shutdownService(command(descriptor.instanceId))).rejects.toMatchObject({ code: 'SERVICE_SHUTDOWN_AUDIT_UNAVAILABLE' });
    await expect(client.describeService()).resolves.toMatchObject({ instanceId: descriptor.instanceId });
  } finally { await service.stop(); await service.done; }
});

it('requires the current service grant even when current Run authority still matches the peer', async () => {
  const f = await fixture(); const service = await startConfiguredRuntimeService(f.project, observer, { env: f.env });
  try {
    const client = createConfiguredRuntimeClient(f.project, { env: f.env }); const descriptor = await client.describeService();
    const opened = await openConfiguredAttemptStore(f.project, { env: f.env }); const policyPath = productResourcePath(opened.layout, 'policy'); opened.store.close();
    await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, revision: 'run-only', restrictions: [], grants: [{
      id: 'run', effect: 'allow', actions: ['inspect'], scopes: ['service-scope'],
      principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'run', ids: 'all' },
    }] }), { mode: 0o600 });
    clearConfigCache();
    await expect(client.shutdownService(command(descriptor.instanceId))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(client.describeService()).resolves.toMatchObject({ instanceId: descriptor.instanceId });
  } finally { await service.stop(); await service.done; }
});

it('persists an incomplete outcome and rejects host completion when an accepted half-open socket outlives grace', async () => {
  const f = await fixture();
  const configPath = join(f.project, '.deckent/config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { service: { shutdownGraceMs: number } };
  config.service.shutdownGraceMs = 25; await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
  const service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); let held: ReturnType<typeof createConnection> | undefined;
  try {
    const client = createConfiguredRuntimeClient(f.project, { env: f.env }); const descriptor = await client.describeService();
    held = createConnection(service.endpoint); held.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => { held.once('connect', resolve); held.once('error', reject); });
    held.write(Buffer.from([0, 0]));
    await client.describeService(); // Complete a later accepted connection while the partial frame remains held.
    await client.shutdownService(command(descriptor.instanceId));
    await expect(service.done).rejects.toMatchObject({ code: 'RUNTIME_SERVICE_SHUTDOWN_INCOMPLETE' });
    const db = new DatabaseSync(f.ledgerPath, { readOnly: true });
    try { expect(JSON.parse(String((db.prepare('SELECT record FROM service_shutdown_outcomes').get() as { record: string }).record))).toMatchObject({ state: 'incomplete' }); }
    finally { db.close(); }
  } finally { held?.destroy(); await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
}, 3000);

it('keeps durable admission but rejects host completion when outcome audit persistence fails', async () => {
  const f = await fixture(); const service = await startConfiguredRuntimeService(f.project, observer, { env: f.env });
  try {
    const client = createConfiguredRuntimeClient(f.project, { env: f.env }); const descriptor = await client.describeService();
    const db = new DatabaseSync(f.ledgerPath);
    db.exec("CREATE TRIGGER reject_shutdown_outcome BEFORE INSERT ON service_shutdown_outcomes BEGIN SELECT RAISE(ABORT, 'fixture'); END;"); db.close();
    await client.shutdownService(command(descriptor.instanceId));
    await expect(service.done).rejects.toMatchObject({ code: 'SERVICE_SHUTDOWN_AUDIT_UNAVAILABLE' });
    const proof = await openConfiguredAttemptStore(f.project, { env: f.env });
    try { expect(await proof.store.readServiceShutdown({ scopeId: 'service-scope', serviceId: 'runtime', commandId: 'shutdown-1' })).toMatchObject({ outcome: null }); }
    finally { proof.store.close(); }
  } finally { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
});

it('persists outcomes for simultaneous distinct durable shutdown admissions', async () => {
  const f = await fixture(); const service = await startConfiguredRuntimeService(f.project, observer, { env: f.env });
  const original = ServiceShutdownApplication.prototype.admit; const gate = deferred(); let admitted = 0; let releaseAdmissions!: () => void;
  const bothAdmitted = new Promise<void>(resolve => { releaseAdmissions = resolve; });
  const spy = vi.spyOn(ServiceShutdownApplication.prototype, 'admit').mockImplementation(async function (...args) {
    const result = await original.apply(this, args); admitted++; if (admitted === 2) releaseAdmissions(); await gate.promise; return result;
  });
  try {
    const client = createConfiguredRuntimeClient(f.project, { env: f.env }); const descriptor = await client.describeService();
    // Timing seam after real policy and SQLite admission; it is not a kernel-peer proof substitute.
    const first = client.shutdownService(command(descriptor.instanceId));
    const second = client.shutdownService({ ...command(descriptor.instanceId), commandId: 'shutdown-2' });
    const requests = Promise.all([first, second]); void requests.catch(() => undefined);
    await bounded(bothAdmitted); gate.release(); await requests; await service.done;
    const db = new DatabaseSync(f.ledgerPath, { readOnly: true });
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM service_shutdown_outcomes').get()!.count).toBe(2); }
    finally { db.close(); }
  } finally { gate.release(); spy.mockRestore(); await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
});

it('waits for a durable outcome when explicit host stop races after admission before response handoff', async () => {
  const f = await fixture(); const service = await startConfiguredRuntimeService(f.project, observer, { env: f.env });
  const original = ServiceShutdownApplication.prototype.admit; const gate = deferred(); const admitted = deferred();
  const spy = vi.spyOn(ServiceShutdownApplication.prototype, 'admit').mockImplementation(async function (...args) {
    const result = await original.apply(this, args); admitted.release(); await gate.promise; return result;
  });
  try {
    const client = createConfiguredRuntimeClient(f.project, { env: f.env }); const descriptor = await client.describeService();
    // Timing seam after durable admission; service.stop is the real host lifecycle path.
    const request = client.shutdownService(command(descriptor.instanceId)); void request.catch(() => undefined); await bounded(admitted.promise);
    const stopping = service.stop(); gate.release(); await request; await stopping; await service.done;
    const db = new DatabaseSync(f.ledgerPath, { readOnly: true });
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM service_shutdown_outcomes').get()!.count).toBe(1); }
    finally { db.close(); }
  } finally { gate.release(); spy.mockRestore(); await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
});
