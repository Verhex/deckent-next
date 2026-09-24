import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { CURRENT_LEDGER_VERSION, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { startConfiguredRuntimeService } from '../../../src/index.js';
import { clearConfigCache } from '#platform/index.js';

type Service = Awaited<ReturnType<typeof startConfiguredRuntimeService>>;
const roots: string[] = [], services: Service[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
  clearConfigCache();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const observer = { async onPage() {}, async onError() {} };
const version = (path: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('PRAGMA user_version').get()?.user_version; } finally { db.close(); } };
/** Puts the ledger back to the previous schema, as an older build left it. */
function downgrade(path: string) {
  const db = new DatabaseSync(path); try { db.exec(`DROP TABLE worker_event_logs; PRAGMA user_version=${CURRENT_LEDGER_VERSION - 1};`); } finally { db.close(); }
}
async function backups(data: string) { try { return await readdir(join(data, 'state/backups')); } catch { return []; } }

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-upgrade-custody-')); roots.push(root);
  const data = join(root, 'data'), env = { HOME: join(root, 'home') };
  await mkdir(join(root, '.deckent'), { recursive: true });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: data },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 4096, responseMaxBytes: 4096, maxConnections: 2, maxConcurrentRequests: 2, maxConcurrentExecutions: 1,
      headerTimeoutMs: 100, shutdownGraceMs: 100 } }));
  // A first start prepares the product layout; the current ledger is then created as an installed project has it.
  const first = await startConfiguredRuntimeService(root, observer, { env });
  await first.stop(); await first.done;
  const ledger = join(data, 'state/ledger.db');
  openSqliteLedger(ledger, { busyTimeoutMs: 1_000, journalMode: 'delete', durability: 'full' }).close();
  await chmod(ledger, 0o600);
  return { root, data, env, ledger };
}

it('a second start against a live host never backs up or migrates the schema that host is using (Astra 2054 R1)', async () => {
  const f = await project();
  const live = await startConfiguredRuntimeService(f.root, observer, { env: f.env }); services.push(live);
  downgrade(f.ledger); // the live host stands in for an older build whose schema is still the previous version
  await expect(startConfiguredRuntimeService(f.root, observer, { env: f.env })).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_ALREADY_RUNNING' });
  expect(version(f.ledger)).toBe(CURRENT_LEDGER_VERSION - 1);
  expect(await backups(f.data)).toEqual([]);
});

it('two simultaneous starts on an older ledger migrate it once, under the winner\'s custody', async () => {
  const f = await project();
  downgrade(f.ledger);
  const [a, b] = await Promise.allSettled([startConfiguredRuntimeService(f.root, observer, { env: f.env }),
    startConfiguredRuntimeService(f.root, observer, { env: f.env })]);
  for (const result of [a, b]) if (result.status === 'fulfilled') services.push(result.value);
  const outcomes = [a, b].map(result => result.status === 'fulfilled' ? 'started' : (result.reason as { code?: string }).code).sort();
  expect(outcomes).toEqual(['LOCAL_RUNTIME_ALREADY_RUNNING', 'started']);
  expect(version(f.ledger)).toBe(CURRENT_LEDGER_VERSION);
  expect(await backups(f.data)).toHaveLength(1);
});
