import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it, vi } from 'vitest';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { mcpApplications } from '#composition/core/mcp/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import * as adapters from '#adapters/index.js';
import * as inventory from '#composition/core/inventory/index.js';
import { startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { SupervisorError, RUNTIME_SERVICE_SCHEMA_VERSION } from '#engine/index.js';
import { clearConfigCache, ErrorRegistry, getConfigKnownSecrets, loadConfig, reportQueryError, snapshotKnownSecrets, takeQueryErrorRecord } from '#platform/index.js';

const canary = 'registered-customer-fixture-canary';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
it('uses the real fresh config snapshot for the existing service record sink and never sends a registered secret to clients', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dk-query-diagnostic-'));
  try {
    await mkdir(join(root, '.deckent'));
    await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ service: { identity: { scopeId: 's', serviceId: '$DECK:QUERY_FIXTURE' } } }));
    const options = { env: { HOME: join(root, 'home') }, secretResolver: async () => canary };
    const failure = queryFailure(new Error(`adapter failed ${canary}`, { cause: new Error(`driver failed ${canary}`) }));
    expect(JSON.stringify(failure)).not.toContain(canary); expect(String(failure)).not.toContain('adapter failed');
    expect(failure.params).toEqual({ errorClass: 'Error', diagnosticId: expect.stringMatching(uuid) });
    expect(failure).not.toHaveProperty('cause');
    const events: { code: string; diagnosticId: string; detail: string }[] = [];
    await reportQueryError(failure, async () => getConfigKnownSecrets(await loadConfig(root, options)), event => { events.push(event); });
    expect(events).toHaveLength(1); expect(events[0]!.diagnosticId).toBe(failure.params!['diagnosticId']);
    expect(events[0]!.detail).toContain('adapter failed'); expect(events[0]!.detail).toContain('driver failed');
    expect(events[0]!.detail).toContain('‹secret:QUERY_FIXTURE›'); expect(events[0]!.detail).not.toContain(canary);
    expect(takeQueryErrorRecord(failure, snapshotKnownSecrets([]))).toBeUndefined();
  } finally { clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});
it('scans a patterned secret crossing the old 2048 cut before bounding the server record', () => {
  const token = 'BOUNDARY-CREDENTIAL-CANARY'.repeat(5), prefix = token.slice(0, 16);
  const failure = queryFailure(new Error(`${'x'.repeat(2020)} token=${token} done`));
  const record = takeQueryErrorRecord(failure, snapshotKnownSecrets([]))!;
  expect(record.length).toBeLessThanOrEqual(2048); expect(record).not.toContain(prefix);
  expect(JSON.stringify(failure)).not.toContain(prefix); expect(JSON.stringify(failure)).not.toContain('xxxxx');
});
it('withholds an incomplete registered-secret suffix and rejects private paths, query tokens and arbitrary names on clients', () => {
  const raw = new Error(`/private/customer/ledger https://customer.invalid/query?access_token=${canary}`);
  raw.name = `/private/customer/${canary}`;
  const failure = queryFailure(raw);
  expect(failure.params).toMatchObject({ errorClass: 'Error', diagnosticId: expect.stringMatching(uuid) });
  expect(JSON.stringify(failure)).not.toMatch(/private|customer|access_token|https|registered-customer/);
  const partial = canary.slice(0, 17), truncated = new Error(`driver output ${partial}`);
  const record = takeQueryErrorRecord(queryFailure(truncated), snapshotKnownSecrets([{ name: 'QUERY_FIXTURE', value: canary }]))!;
  expect(record).not.toContain(partial); expect(record).toContain('[REDACTED]');
});
it('falls back without unregistered codes or params for known classes and unregistered DeckentErrors', () => {
  const typed = new SupervisorError('SUPERVISOR_CONTROL_FAILED');
  Object.assign(typed, { code: `/private/${canary}` });
  for (const error of [typed, ErrorRegistry.createError(canary, { params: { detail: canary } })]) {
    const failure = queryFailure(error);
    expect(failure.code).toBe('INVENTORY_UNAVAILABLE'); expect(failure.params).toEqual({});
    expect(JSON.stringify(failure)).not.toContain(canary);
  }
});
it('never falls back to raw text when the snapshot or service record sink fails', async () => {
  const records: unknown[] = [], failure = queryFailure(new Error(canary));
  await reportQueryError(failure, async () => { throw new Error(canary); }, event => { records.push(event); });
  expect(records).toEqual([]); expect(JSON.stringify(failure)).not.toContain(canary);
  await reportQueryError(failure, async () => snapshotKnownSecrets([{ name: 'QUERY_FIXTURE', value: canary }]), () => { throw new Error(canary); });
  expect(JSON.stringify(failure)).not.toContain(canary);
});
it('gives the distinct MCP actor the same content-free typed error on the actual MCP wire', async () => {
  const failure = queryFailure(new Error(`/private/customer https://customer.invalid/?token=${canary}`, { cause: new Error(canary) }));
  const applications = mcpApplications({ async inspectInventory() { throw failure; } });
  const server = createMcpServer(applications, { maxConcurrentCalls: 1, responseMaxBytes: 4096 }, 'en');
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
  const client = new Client({ name: 'query-fix1', version: '1' }); await client.connect(ct);
  try {
    const result = await client.callTool({ name: 'inspect_inventory', arguments: { schemaVersion: 1, scopeId: 's' } });
    expect(result.isError).toBe(true); const wire = JSON.stringify(result);
    expect(wire).toContain('QUERY_UNEXPECTED_FAILURE'); expect(wire).toContain(String(failure.params!['diagnosticId']));
    expect(wire).not.toMatch(/private|customer|token=|registered-customer|https/);
  } finally { await client.close(); await server.close(); }
});

it('records a service request failure with fresh known secrets and returns only safe parameters to SDK and MCP channels (controlled socket port)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dk-query-service-'));
  const events: { code: string; diagnosticId: string; detail: string }[] = [];
  let handler!: adapters.RuntimeServiceHandler;
  const socket = vi.spyOn(adapters, 'acquireLocalRuntimeSocketGuard').mockResolvedValue({ custodyId: 'a'.repeat(64), async release() {},
    async start(serve) { handler = serve; return { endpoint: 'controlled-query-socket', termination: new Promise(() => {}), stopAccepting() {}, disconnectClients() {}, async dispose() {} }; } });
  const operation = vi.spyOn(inventory, 'inspectConfiguredInventory').mockImplementation(async () => { throw queryFailure(new Error(`adapter customer data ${canary}`)); });
  let service: Awaited<ReturnType<typeof startConfiguredRuntimeService>> | undefined;
  try {
    await mkdir(join(root, '.deckent'));
    await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') },
      service: { identity: { scopeId: 's', serviceId: '$DECK:QUERY_FIXTURE' } },
      cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
      cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 } }));
    const options = { env: { HOME: join(root, 'home') }, secretResolver: async () => canary };
    (await openConfiguredAttemptStore(root, options)).store.close();
    service = await startConfiguredRuntimeService(root, { onPage() {}, onError() {}, onQueryFailure(event) { events.push(event); } }, options);
    const peer = { pid: process.pid, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, assurance: 'linux-so-peercred' as const };
    for (const channel of [undefined, 'mcp'] as const) {
      const response = await handler({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'query-fix1', operation: 'inspectInventory', input: { schemaVersion: 1, scopeId: 's' }, ...(channel ? { channel } : {}) }, peer);
      expect(response).toMatchObject({ ok: false, error: { code: 'QUERY_UNEXPECTED_FAILURE', params: { errorClass: 'Error', diagnosticId: expect.stringMatching(uuid) } } });
      expect(JSON.stringify(response)).not.toMatch(/customer data|registered-customer/);
      expect(events.at(-1)).toMatchObject({ code: 'QUERY_UNEXPECTED_FAILURE', diagnosticId: expect.stringMatching(uuid) });
      expect(events.at(-1)!.detail).toContain('adapter customer data'); expect(events.at(-1)!.detail).toContain('‹secret:QUERY_FIXTURE›');
      expect(events.at(-1)!.detail).not.toContain(canary);
    }
    expect(events).toHaveLength(2);
  } finally { if (service) { await service.stop(); await service.done; } socket.mockRestore(); operation.mockRestore(); clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});

it('never re-exposes legacy typed query details or custom messages when a failure crosses another mapper', () => {
  const legacy = ErrorRegistry.createError('QUERY_UNEXPECTED_FAILURE', { message: canary, params: { detail: canary } });
  const failure = queryFailure(legacy);
  expect(JSON.stringify(failure)).not.toContain(canary); expect(String(failure)).not.toContain(canary);
  expect(failure.params).toEqual({ errorClass: 'Error', diagnosticId: expect.stringMatching(uuid) });
  const first = queryFailure(new Error(canary)), second = queryFailure(first);
  expect(second.params).toEqual(first.params);
  const record = takeQueryErrorRecord(second, snapshotKnownSecrets([{ name: 'QUERY_FIXTURE', value: canary }]))!;
  expect(record).toContain('‹secret:QUERY_FIXTURE›'); expect(record).not.toContain(canary);
});
