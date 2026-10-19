import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import * as adapters from '#adapters/index.js';
import * as inventory from '#composition/core/inventory/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { RUNTIME_SERVICE_SCHEMA_VERSION } from '#engine/index.js';
import { clearConfigCache, resolveGlobalConfigPaths } from '#platform/index.js';

const canary = 'registered-customer-fixture-canary';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] replies before the diagnostic sink settles and drains the pending record before host done', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dk-query-reply-'));
  const events: { code: string; diagnosticId: string; detail: string }[] = [];
  let releaseReport!: () => void;
  const gate = new Promise<void>(resolve => { releaseReport = resolve; });
  let handler!: adapters.RuntimeServiceHandler;
  const socket = vi.spyOn(adapters, 'acquireLocalRuntimeSocketGuard').mockResolvedValue({ custodyId: 'a'.repeat(64), async release() {},
    async start(serve) { handler = serve; return { endpoint: 'controlled-query-socket', termination: new Promise(() => {}), stopAccepting() {}, disconnectClients() {}, async dispose() {} }; } });
  const operation = vi.spyOn(inventory, 'inspectConfiguredInventory').mockImplementation(async () => { throw queryFailure(new Error(`adapter customer data ${canary}`)); });
  let service: Awaited<ReturnType<typeof startConfiguredRuntimeService>> | undefined;
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await mkdir(join(root, '.deckent'));
    await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') },
      cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
      cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 } }));
    const options = { env: { HOME: join(root, 'home') }, secretResolver: async () => canary };
    const installationPath = resolveGlobalConfigPaths(options.env).platformPath; await mkdir(dirname(installationPath), { recursive: true });
    // SEC-3: only the installation (global) layer may hold a $DECK reference.
    await writeFile(installationPath, JSON.stringify({ service: { identity: { scopeId: 's', serviceId: '$DECK:QUERY_FIXTURE' } } }));
    (await openConfiguredAttemptStore(root, options)).store.close();
    service = await startConfiguredRuntimeService(root, { onPage() {}, onError() {}, onQueryFailure(event) { events.push(event); return gate; } }, options);
    const peer = { pid: process.pid, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, assurance: 'linux-so-peercred' as const };
    const response = await Promise.race([
      handler({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'query-reply', operation: 'inspectInventory', input: { schemaVersion: 1, scopeId: 's' } }, peer),
      new Promise<'blocked'>(resolve => { timer = setTimeout(() => resolve('blocked'), 2000); }),
    ]);
    clearTimeout(timer);
    expect(response).toMatchObject({ ok: false, error: { code: 'QUERY_UNEXPECTED_FAILURE', params: { errorClass: 'Error', diagnosticId: expect.stringMatching(uuid) } } });
    expect(response).not.toBe('blocked');
    expect(JSON.stringify(response)).not.toContain('customer data'); expect(JSON.stringify(response)).not.toContain(canary);
    if (response === 'blocked' || 'response' in response || response.ok) throw new Error('Expected a direct error response');
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 3000 });
    expect(events[0]!.diagnosticId).toBe(response.error.params!['diagnosticId']);
    expect(events[0]!.detail).toContain('adapter customer data'); expect(events[0]!.detail).toContain('‹secret:QUERY_FIXTURE›');
    expect(events[0]!.detail).not.toContain(canary);
    const result = await service.stop(); stopped = true;
    expect(result.state).toBe('clean');
    let done = false;
    void service.done.then(() => { done = true; });
    await wait(200);
    expect(done).toBe(false);
    releaseReport();
    await service.done;
    expect(done).toBe(true);
  } finally {
    releaseReport(); clearTimeout(timer);
    if (service) { if (!stopped) await service.stop(); await service.done; }
    socket.mockRestore(); operation.mockRestore(); clearConfigCache(); await rm(root, { recursive: true, force: true });
  }
});
