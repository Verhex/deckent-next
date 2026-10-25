import { lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { ErrorRegistry, writeJsonAtomic } from '#platform/index.js';
import { workerImageStateSchema, type WorkerImageState } from '#engine/index.js';
import { runNodeProcess, type WorkerImageBuildRunner } from '#adapters/index.js';
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
  if (dirname(context) !== join(home, 'builds')) throw ErrorRegistry.createError('WORKER_IMAGE_CONTEXT_UNSAFE');
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
