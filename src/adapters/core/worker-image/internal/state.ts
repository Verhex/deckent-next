import { setInterval } from 'node:timers/promises';
import { lstat, mkdir, open, readdir, realpath, rename, watch, readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { ErrorRegistry, writeJsonAtomic } from '#platform/index.js';
import { workerImageStateSchema, type WorkerImageState } from '#engine/index.js';
import { runNodeProcess } from '#adapters/core/process-runner/index.js';
import type { WorkerImageBuildRunner } from './build.js';
import limits from './limits.json' with { type: 'json' };
export async function readWorkerImageState(home: string): Promise<WorkerImageState | null> {
  const path = join(home, 'worker-image-state.json');
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.nlink !== 1 || info.size > limits.receiptBytes) throw ErrorRegistry.createError('WORKER_IMAGE_CONTEXT_UNSAFE');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return workerImageStateSchema.parse(JSON.parse(await file.readFile('utf8'))); } finally { await file.close(); }
}
export async function writeWorkerImageState(home: string, state: WorkerImageState): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(join(home, 'worker-image-state.json'), workerImageStateSchema.parse(state));
}
/** Only the private retained context and cidfiles of its labelled probes are reconciled; no images/tags are removed. */
export async function recoverWorkerImageContext(home: string, state: WorkerImageState, packageRoot: string,
  runner: WorkerImageBuildRunner = runNodeProcess, env: Readonly<Record<string, string>> = {}) {
  if (!state.context) return;
  const context = state.context;
  if (![join(home, 'builds'), join(home, 'adopted')].includes(dirname(context))) throw ErrorRegistry.createError('WORKER_IMAGE_CONTEXT_UNSAFE');
  const info = await lstat(context).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return;
  if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077 || await realpath(context) !== context) throw ErrorRegistry.createError('WORKER_IMAGE_CONTEXT_UNSAFE');
  const command = async (args: string[]) => {
    const result = await runner({ schemaVersion: 1, requestId: randomUUID(), executable: process.execPath,
      args: [join(packageRoot, 'assets/worker-image/recover.mjs'), context, state.daemonId ?? '', ...args], cwd: context, env: Object.fromEntries(Object.entries(env).filter(([key]) => ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].includes(key))), timeoutMs: limits.probeTimeoutMs, outputBytes: limits.probeOutputBytes });
    if (result.reason !== 'exit' || result.exitCode !== 0) throw ErrorRegistry.createError('WORKER_IMAGE_BUILD_INTERRUPTED');
  };
  const names = await readdir(context);
  if (names.some(name => /^probe-\d+\.cid$/u.test(name))) await command([]);
  await rename(context, `${context}.failed-${Date.now()}`);
}

/** Progress is observational; only the builder receipt settles acquisition. */
export async function observeWorkerImageProgress(context: string, providers: readonly string[], signal: AbortSignal, publish: (step: string) => Promise<void>) {
  try {
    for await (const event of watch(context, { signal })) {
      if (event.filename !== 'progress.json') continue;
      const path = join(context, 'progress.json'), info = await lstat(path);
      if (!info.isFile() || info.size > 4096) continue;
      const value = JSON.parse(await readFile(path, 'utf8')) as { step?: unknown };
      if (typeof value.step === 'string' && ['base', 'probe', ...providers.map(id => `layer:${id}`)].includes(value.step)) await publish(value.step);
    }
  } catch { /* The builder owns the result, including interruption. */ }
}
/** Watch before observing consent; only a Docker wait is retried on a tick, never a failed or interrupted build. */
export async function watchWorkerImageRequests(path: string, signal: AbortSignal, run: () => Promise<WorkerImageState | null>) {
  const stop = new AbortController(), bound = AbortSignal.any([signal, stop.signal]);
  const changes = watch(dirname(path), { signal: bound });
  const current: { state: WorkerImageState | null } = { state: null };
  const observe = async () => { current.state = await run(); };
  try {
    if (signal.aborted) return;
    await observe();
    await Promise.all([
      (async () => { for await (const event of changes) if (event.filename === basename(path) && !bound.aborted) await observe(); })(),
      (async () => { for await (const tick of setInterval(limits.dockerRedetectMs, undefined, { signal: bound, ref: false })) {
        void tick;
        if (current.state?.phase === 'waiting-docker' && !bound.aborted) await observe();
      } })(),
    ]);
  } catch (error) { if (!signal.aborted) throw error; }
  finally { stop.abort(); await changes.return?.(); }
}
