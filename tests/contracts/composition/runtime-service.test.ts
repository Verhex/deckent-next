import { hostname, tmpdir, userInfo } from 'node:os';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createConfiguredRuntimeClient, startConfiguredRuntimeService } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'selected', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };

async function fixture(allow = true, shutdownGraceMs = 1000, headerTimeoutMs = 1000) {
  const project = await mkdtemp(join(tmpdir(), 'dk-svc-')); roots.push(project); const data = join(project, 'd');
  await mkdir(join(project, '.deckent'), { recursive: true }); const env = { HOME: join(project, 'h') };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: {
    poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: fixtureDockerRegistry(['selected']),
  }, cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
  cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 }, service: {
    inputMaxBytes: 65536, responseMaxBytes: 65536, maxConnections: 4, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs, shutdownGraceMs,
  } }));
  const opened = await openConfiguredAttemptStore(project, { env }); await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: allow ? 'allow' : 'deny', restrictions: [], grants: [
    ...(allow ? [{ id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
      { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
      { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } }] : []),
  ] }), { mode: 0o600 }); const ledgerPath = opened.path; opened.store.close();
  return { project, data, env, ledgerPath };
}

async function admit(client: ReturnType<typeof createConfiguredRuntimeClient>) {
  const command = { schemaVersion: 1 as const, commandId: 'create', scopeId: 's', runId: 'r', graph };
  const created = await client.createRun(command); const reserved = await client.reserveRunTasks({ schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r', expectedRevision: 0 });
  return { command, created, reserved };
}

it('rejects an invalid spending account query before connecting to an absent runtime', async () => {
  const f = await fixture(), before = await readFile(f.ledgerPath);
  const client = createConfiguredRuntimeClient(f.project, { env: f.env });
  await expect(client.inspectProviderSpendAccount({ schemaVersion: 1, scopeId: 's', budgetId: 'budget', budgetRevision: 0 }))
    .rejects.toMatchObject({ code: 'PROVIDER_SPEND_INVALID' });
  expect(await readFile(f.ledgerPath)).toEqual(before);
});

it('bounds half-open client cleanup by the service grace and releases ownership after disconnect', async () => {
  const f = await fixture(true, 25, 10000);
  const observer = { async onPage() {}, async onError() {} };
  const service = await startConfiguredRuntimeService(f.project, observer, { env: f.env });
  const socket = createConnection(service.endpoint); socket.on('error', () => undefined);
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.write(Buffer.from([0, 0]));
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(service.stop()).resolves.toMatchObject({ state: 'incomplete', remainingRequests: 0 });
    await service.done;
    const restarted = await startConfiguredRuntimeService(f.project, observer, { env: f.env });
    await restarted.stop(); await restarted.done;
  } finally {
    socket.destroy(); await service.stop(); await service.done;
  }
}, 3000);

it('serves typed create/inspect/reserve requests, enforces policy, rejects malformed input, and restarts cleanly', async () => {
  const f = await fixture(); const observer = { async onPage() {}, async onError() {} };
  const service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); const client = createConfiguredRuntimeClient(f.project, { env: f.env });
  try {
    const admitted = await admit(client);
    expect(admitted.created.admission.run.runId).toBe('r'); expect(admitted.reserved.reservation.identities).toHaveLength(1);
    const inspected = await client.inspectRun({ schemaVersion: 1, scopeId: 's', runId: 'r' });
    expect(inspected.run).toEqual(admitted.reserved.reservation.run);
    const before = await readFile(f.ledgerPath);
    await expect(client.createRun({ ...admitted.command, schemaVersion: 99 })).rejects.toThrow();
    expect(await readFile(f.ledgerPath)).toEqual(before);
    const paths = await openConfiguredAttemptStore(f.project, { env: f.env }); const policyPath = productResourcePath(paths.layout, 'policy'); paths.store.close();
    await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, revision: 'deny', restrictions: [], grants: [] }), { mode: 0o600 }); clearConfigCache();
    await expect(client.inspectRun({ schemaVersion: 1, scopeId: 's', runId: 'r' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(startConfiguredRuntimeService(f.project, observer, { env: f.env })).rejects.toThrow();
  } finally {
    await service.stop(); await service.done;
  }
  const restarted = await startConfiguredRuntimeService(f.project, observer, { env: f.env });
  try { await expect(createConfiguredRuntimeClient(f.project, { env: f.env }).inspectRun({ schemaVersion: 1, scopeId: 's', runId: 'r' })).rejects.toMatchObject({ code: 'POLICY_DENIED' }); }
  finally { await restarted.stop(); await restarted.done; }
});
