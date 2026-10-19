import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { cliChildEnv } from '../support/child-env.js';

// R6 (alpha.47, CI-FLAKE 2026-10-18): the SQLite companion/busy family. Every client operation opens and closes its own ledger
// connection while the runtime service runs; when the last connection closes SQLite checkpoints and unlinks -wal/-shm, and every
// write-capable open takes the write lock. Separate client processes open the ledger exactly as `task execute` and the CLI do, while
// the live service polls it; each failure is reported with its typed code and the managed-file diagnostic (reason, mode, links,
// companion, stage). CLIENTS/ROUNDS widen the run for a stress loop (one core, busy loops: see the R6 handoff); the default stays small.
registerProviderConfig();
const clients = Number(process.env.DECKENT_LEDGER_STRESS_CLIENTS ?? 4), rounds = Number(process.env.DECKENT_LEDGER_STRESS_ROUNDS ?? 25);
const storage = resolve('dist/composition/core/storage/index.js');
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const program = `
  const [storage, project, rounds, writer] = process.argv.slice(1); const { openConfiguredAttemptStore } = await import(storage);
  const failures = [];
  for (let round = 0; round < Number(rounds); round++) {
    let stage = 'open';
    try { const opened = await openConfiguredAttemptStore(project, { env: process.env }); stage = writer === 'none' ? 'read' : 'write';
      try { if (writer === 'none') await opened.store.load('installation', 'absent-attempt');
        else await opened.store.createExecutionPool({ schemaVersion: 1, poolId: writer + '-' + round, capacity: { executionSlots: 1, inFlightSlots: 1 } }); }
      finally { opened.store.close(); } }
    catch (error) { failures.push({ stage, code: error?.code ?? String(error), diagnostic: error?.diagnostic ?? null }); }
  }
  process.stdout.write(JSON.stringify(failures));`;
/** A reader loads an absent Attempt; a writer creates one execution pool per round (a durable write, as dispatch records are). */
function client(project: string, env: NodeJS.ProcessEnv, writer: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, storage, project, String(rounds), writer], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  return new Promise<{ code: number | null; stderr: string; failures: { stage: string; code: string; diagnostic: unknown }[] }>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', code => { try { resolveExit({ code, stderr, failures: JSON.parse(stdout || '[]') }); } catch (error) { reject(new Error(`${String(error)} ${stdout} ${stderr}`)); } });
  });
}

it.skipIf(process.platform !== 'linux')('client processes open the ledger beside a live service without a companion refusal or a busy refusal', async () => {
  await access(storage).catch(() => { throw new Error('BUILD_REQUIRED: run npm run build before this process proof'); });
  const root = await mkdtemp(join(tmpdir(), 'deckent-ledger-stress-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home');
  await mkdir(project, { recursive: true }); await mkdir(home, { mode: 0o700 });
  const env = cliChildEnv({ HOME: home });
  await applyPolicyTemplateInstallation(project, 'installation');
  // The service's background pages poll the ledger often, as a busy installation's would.
  await writeFile(join(project, '.deckent', 'config.json'), JSON.stringify({
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['installation'], pollIntervalMs: 20, failureBackoffMs: 20 },
    service: { inputMaxBytes: 262144, responseMaxBytes: 65536, maxConnections: 8, maxConcurrentRequests: 8, maxConcurrentExecutions: 2,
      headerTimeoutMs: 1000, responseTimeoutMs: 10000, shutdownGraceMs: 50 } }), { mode: 0o600 });
  (await openConfiguredAttemptStore(project, { env })).store.close(); clearConfigCache();
  const service = await startConfiguredRuntimeService(project, { async onPage() { /* observed by the ledger only */ }, async onError() { /* idem */ } }, { env });
  try {
    const results = await Promise.all(Array.from({ length: clients }, (_, index) => client(project, env, index % 2 ? `writer${index}` : 'none')));
    const failures = results.flatMap(result => result.failures);
    const counted = failures.reduce<Record<string, number>>((all, failure) => {
      const key = `${failure.stage} ${failure.code} ${JSON.stringify(failure.diagnostic)}`; all[key] = (all[key] ?? 0) + 1; return all; }, {});
    // The counts are the evidence a stress loop records (before/after); the assertion is the product contract.
    if (failures.length) process.stderr.write(`ledger-stress failures ${failures.length}/${clients * rounds}: ${JSON.stringify(counted)}\n`);
    expect(results.map(result => [result.code, result.stderr])).toEqual(results.map(() => [0, '']));
    expect(counted).toEqual({});
  } finally { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
}, 120_000);
