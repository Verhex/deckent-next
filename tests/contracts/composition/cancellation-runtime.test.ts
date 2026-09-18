import { hostname, userInfo } from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runConfiguredCancellationRuntime } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache } from '#platform/index.js';
import { CONFIG_FIELDS } from '#platform/core/config-fields/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(policy = true) {
  const project = await mkdtemp(join(tmpdir(), 'deckent-runtime-host-')); roots.push(project); const data = join(project, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true }); const env = { HOME: join(project, 'home') };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, cancellation: {
    maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 2, retryDelayMs: 1, claimTtlMs: 1,
  }, cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 } }));
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  const grants = policy ? [{ id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'],
    principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'scope', ids: ['s'] } }] : [];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'runtime', restrictions: [], grants }), { mode: 0o600 });
  return { project, env };
}

it('hosts only configured trusted scopes and awaits an observed empty recovery page', async () => {
  const f = await fixture(); const controller = new AbortController(); const pages: unknown[] = [];
  await runConfiguredCancellationRuntime(f.project, { signal: controller.signal, observer: {
    async onPage(command, result) { pages.push({ command, result }); controller.abort(); }, async onError() { throw new Error('unexpected-error'); },
  } }, { env: f.env });
  expect(pages).toEqual([{ command: { schemaVersion: 1, scopeId: 's', afterAttemptId: null }, result: {
    schemaVersion: 1, scopeId: 's', nextAfterAttemptId: null, outcomes: [],
  } }]);
});

it('delivers sanitized recovery failures to the observer and stops on abort', async () => {
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
