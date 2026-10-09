import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { clearConfigCache, productResourcePath, resolveProductLayout } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => {
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
export const me = [{ issuer: hostname(), subject: String(userInfo().uid) }];
/** Policy-only isolated fixture: no provider, model setup, HTTP server or paid-call possibility. */
export async function runtime() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-mcp-grant-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data },
    storage: { driver: 'sqlite', sqlite: { busyTimeoutMs: 1000, journalMode: 'delete', durability: 'full' } },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 262144, responseMaxBytes: 65536, maxConnections: 8, maxConcurrentRequests: 4,
      maxConcurrentExecutions: 2, headerTimeoutMs: 1000, responseTimeoutMs: 1000, shutdownGraceMs: 50 } }), { mode: 0o600 });
  const env = { HOME: home, DECKENT_GLOBAL_HOME: join(home, 'global'), PATH: process.env.PATH ?? '/usr/bin:/bin' }, ledger = productResourcePath(resolveProductLayout({ projectRoot: project, root: data }), 'ledger');
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  const rows = (sql: string) => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  return { project, data, env, ledger, rows, client: () => createConfiguredRuntimeClient(project, { env }) };
}
