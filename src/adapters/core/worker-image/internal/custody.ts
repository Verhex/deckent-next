import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ErrorRegistry, writeJsonAtomic } from '#platform/index.js';
import { retainedWorkerHistory } from '../../../../../assets/worker-image/receipts.mjs';
import { acquireLedgerLock } from '#adapters/core/local-runtime-socket/index.js';
import { privateDirectory } from './build.js';
import limits from './limits.json' with { type: 'json' };
const refuse = (code: string): never => { throw ErrorRegistry.createError(code); };
export type WorkerReservation = Readonly<{ version: string; floor: number; daemonId: string; expiresAt: string }>;
type Owner = { instanceId: string; pid: number; startedAt: string; expiresAt: string; released?: boolean };
async function readRecord(path: string): Promise<unknown | null> {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.nlink !== 1 || info.size > limits.receiptBytes) refuse('WORKER_IMAGE_CONTEXT_UNSAFE');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(await file.readFile('utf8')) as unknown; } finally { await file.close(); }
}
/** Kernel lock is the concurrency fence; metadata/lease never authorizes stealing a still-held kernel lock. Death releases it automatically. */
export async function withWorkerBuilder<T>(input: { root: string; packageRoot: string; daemonId: string; instanceId: string; budgetMs: number; signal?: AbortSignal;
  audit: (event: unknown) => Promise<void> }, run: (custody: { reserve(floor: number, at: string): Promise<WorkerReservation>; retain(receipt: unknown): Promise<void> }) => Promise<T>): Promise<T> {
  const directory = join(input.root, createHash('sha256').update(input.daemonId).digest('hex'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await privateDirectory(input.root); await privateDirectory(directory);
  const deadline = performance.now() + input.budgetMs;
  let lock;
  for (;;) {
    input.signal?.throwIfAborted();
    try { lock = acquireLedgerLock(join(directory, limits.custody.lock)); break; }
    catch (error) {
      if ((error as { code?: string }).code !== 'LOCAL_RUNTIME_ALREADY_RUNNING') throw error;
      if (performance.now() >= deadline) refuse('WORKER_IMAGE_BUILDING');
      await wait(limits.custody.waitMs, undefined, input.signal ? { signal: input.signal } : undefined);
    }
  }
  const ownerPath = join(directory, limits.custody.owner), now = new Date().toISOString(), expiresAt = new Date(Date.now() + input.budgetMs).toISOString(); let published = false;
  try {
    const previous = await readRecord(ownerPath) as Owner | null;
    if (previous && !previous.released) {
      if (typeof previous.instanceId !== 'string' || !Number.isSafeInteger(previous.pid) || !Number.isFinite(Date.parse(previous.expiresAt))) refuse('WORKER_IMAGE_CONTEXT_UNSAFE');
      // The acquired kernel custody proves the previous builder no longer holds it, even if its PID was reused.
      await input.audit({ event: 'lockTakenOver', from: previous.instanceId, instanceId: input.instanceId, daemonId: input.daemonId, at: now });
    }
    await writeJsonAtomic(ownerPath, { instanceId: input.instanceId, pid: process.pid, startedAt: now, expiresAt });
    published = true;
    const receipts = join(directory, limits.custody.receipts); await mkdir(receipts, { mode: 0o700, recursive: true }); await privateDirectory(receipts);
    return await run({
      async reserve(floor, at) {
        const path = join(directory, limits.custody.counter), value = await readRecord(path) as { highest?: number } | null;
        if (value && (!Number.isSafeInteger(value.highest) || value.highest! < 0 || value.highest! >= Number.MAX_SAFE_INTEGER)) refuse('WORKER_HISTORY_COUNTER');
        const history = await readWorkerHistory({ packageRoot: input.packageRoot, home: directory, daemonId: input.daemonId });
        const highest = Math.max(value?.highest ?? 0, floor, ...history.map(version => Number(/^r([0-9]+)/u.exec(version)![1])));
        if (!Number.isSafeInteger(highest + 1)) refuse('WORKER_HISTORY_COUNTER');
        const reservation = { version: `r${highest + 1}-${at.slice(0, 10).replaceAll('-', '')}`, floor: highest, daemonId: input.daemonId, expiresAt };
        await writeJsonAtomic(path, { schemaVersion: 1, highest: highest + 1, instanceId: input.instanceId, reservation });
        return reservation;
      },
      async retain(receipt) {
        const file = await open(join(receipts, `${randomUUID()}.json`), 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(receipt) + '\n'); await file.sync(); } finally { await file.close(); }
      },
    });
  } finally {
    try { if (published) await writeJsonAtomic(ownerPath, { instanceId: input.instanceId, released: true }); } finally { lock.release(); }
  }
}
export async function readWorkerHistory(input: { packageRoot: string; home: string; daemonId: string }): Promise<string[]> {
  return retainedWorkerHistory(join(input.home, 'receipts'), input.daemonId, { files: limits.receiptScan, bytes: limits.receiptBytes }); }
