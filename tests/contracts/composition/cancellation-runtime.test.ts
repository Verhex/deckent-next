import { hostname, userInfo } from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runConfiguredCancellationRuntime } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache } from '#platform/index.js';
import * as platform from '#platform/index.js';
import * as runs from '#composition/core/runs/index.js';
import * as invocations from '#composition/core/model-invocation/index.js';
import { prepareConfiguredCancellationRuntime, prepareConfiguredReconciliationRuntime, prepareConfiguredModelCancellationRuntime } from '#composition/core/runtime/index.js';
import { ModelInvocationControllers } from '#engine/index.js';
import { CONFIG_FIELDS } from '#platform/core/config-fields/index.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(policy = true, pollIntervalMs = 1000) {
  const project = await mkdtemp(join(tmpdir(), 'deckent-runtime-host-')); roots.push(project); const data = join(project, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true }); const env = { HOME: join(project, 'home'), USERPROFILE: join(project, 'home') };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, cancellation: {
    maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 2, retryDelayMs: 1, claimTtlMs: 1,
  }, cancellationRuntime: { scopeIds: ['s'], pollIntervalMs, failureBackoffMs: 1000 },
  reconciliationRuntime: { scopeIds: ['s'], pollIntervalMs, failureBackoffMs: 1000 } }));
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  const grants = policy ? [{ id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'],
    principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'scope', ids: ['s'] } }] : [];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'runtime', restrictions: [], grants }), { mode: 0o600 });
  return { project, env };
}

it.skipIf(process.platform === 'win32')('requires POSIX local principal — hosts only configured trusted scopes and awaits an observed empty recovery page', async () => {
  const f = await fixture(); const controller = new AbortController(); const pages: unknown[] = [];
  await runConfiguredCancellationRuntime(f.project, { signal: controller.signal, observer: {
    async onPage(command, result) { pages.push({ command, result }); controller.abort(); }, async onError() { throw new Error('unexpected-error'); },
  } }, { env: f.env });
  expect(pages).toEqual([{ command: { schemaVersion: 1, scopeId: 's', afterAttemptId: null }, result: {
    schemaVersion: 1, scopeId: 's', nextAfterAttemptId: null, outcomes: [],
  } }]);
});

it.skipIf(process.platform === 'win32')('requires POSIX local principal — delivers sanitized recovery failures to the observer and stops on abort', async () => {
  const f = await fixture(false); const controller = new AbortController(); const errors: { code?: string; message: string }[] = [];
  await runConfiguredCancellationRuntime(f.project, { signal: controller.signal, observer: {
    async onPage() { throw new Error('unexpected-page'); },
    async onError(_command, error) { errors.push({ code: error.code, message: error.message }); controller.abort(); },
  } }, { env: f.env });
  expect(errors).toEqual([{ code: 'POLICY_DENIED', message: expect.any(String) }]);
  expect(errors[0]!.message).not.toContain(f.project);
});

it('keeps runtime scope and timing defaults and rejects an empty trusted scope list', () => {
  const schema = CONFIG_FIELDS.cancellationRuntime.schema;
  expect(schema.parse(null)).toBeNull();
  expect(schema.parse({ scopeIds: ['s'] })).toEqual({ scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 5000 });
  expect(() => schema.parse({ scopeIds: [] })).toThrow();
});


it.skipIf(process.platform === 'win32').each(['cancellation', 'reconciliation', 'model-cancellation'] as const)('requires POSIX local principal — uses elapsed time for configured %s failure backoff while the wall floor stalls', async kind => {
  const f = await fixture(true, 1), controller = new AbortController();
  let wallMs = 10000, failures = 0;
  const elapsed = [0, 0, 500, 1000, 1000];
  const floor = new platform.SystemTrustedClock(() => wallMs);
  vi.spyOn(platform, 'SystemTrustedClock').mockImplementation(function () {
    return { sample: () => {
      const monotonicMs = elapsed.shift(); if (monotonicMs === undefined) throw new Error('BACKOFF_DID_NOT_ADVANCE');
      const result = { wallMs: floor.sample().wallMs, monotonicMs }; wallMs = 8000; return result;
    } };
  } as never);
  const unavailable = async () => { throw new Error('UNAVAILABLE'); };
  vi.spyOn(runs, 'recoverConfiguredCancellations').mockImplementation(unavailable);
  vi.spyOn(runs, 'recoverConfiguredReconciliation').mockImplementation(unavailable);
  vi.spyOn(invocations, 'recoverConfiguredModelCancellations').mockImplementation(unavailable);
  const observer = { onPage() { throw new Error('UNEXPECTED_PAGE'); }, onError() { if (++failures === 2) controller.abort(); } };
  const options = { env: f.env };
  const prepared = kind === 'cancellation' ? await prepareConfiguredCancellationRuntime(f.project, observer, options)
    : kind === 'reconciliation' ? await prepareConfiguredReconciliationRuntime(f.project, observer, options)
      : await prepareConfiguredModelCancellationRuntime(f.project, new ModelInvocationControllers(1), observer, options);
  await prepared.run(controller.signal);
  // Failure at elapsed 0; no retry at 500; retry at the original 1000-ms boundary despite a 2-s wall step.
  expect(failures).toBe(2); expect(elapsed).toEqual([]);
});
