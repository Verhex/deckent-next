import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { runNodeProcess, type ProcessCommand, type ProcessEvidence } from '#adapters/core/process-runner/index.js';

export type WorkerImageBuildErrorCode = 'WORKER_IMAGE_SOURCE_INVALID' | 'WORKER_IMAGE_CONTEXT_EXISTS' | 'WORKER_IMAGE_CONTEXT_UNSAFE'
  | 'WORKER_IMAGE_BUILD_FAILED' | 'WORKER_IMAGE_BUILD_TIMEOUT' | 'WORKER_IMAGE_RECEIPT_MISSING';
/** Bounded failure evidence; builder stdout/stderr stay in the returned process evidence, never in the message. */
export class WorkerImageBuildError extends Error {
  constructor(readonly code: WorkerImageBuildErrorCode, readonly evidence?: ProcessEvidence) { super(code); this.name = 'WorkerImageBuildError'; }
}
/** The builder reads its inputs from its own directory, so a build context is a private copy of exactly these files. */
export const WORKER_IMAGE_BUILDER_FILES = Object.freeze(['build.mjs', 'history.mjs', 'install.mjs', 'inspect.mjs'] as const);
export const WORKER_IMAGE_ASSET_DIRECTORY = 'assets/worker-image';

async function privateDirectory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) || await realpath(path) !== path) throw new WorkerImageBuildError('WORKER_IMAGE_CONTEXT_UNSAFE');
}
async function writeExclusive(path: string, text: string) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
}
/** Reads the shipped recipe and Dockerfile of the installed package without modifying them. */
export async function readWorkerImageSources(packageRoot: string) {
  if (!isAbsolute(packageRoot)) throw new WorkerImageBuildError('WORKER_IMAGE_SOURCE_INVALID');
  const directory = join(packageRoot, WORKER_IMAGE_ASSET_DIRECTORY);
  try {
    const recipe: unknown = JSON.parse(await readFile(join(directory, 'recipe.json'), 'utf8'));
    return Object.freeze({ directory, recipe, dockerfile: await readFile(join(directory, 'Dockerfile'), 'utf8') });
  } catch { throw new WorkerImageBuildError('WORKER_IMAGE_SOURCE_INVALID'); }
}
/** Creates `<parent>/<imageVersion>` exclusively, copies the builder files and writes the edited Dockerfile/recipe. Package bytes stay untouched. */
export async function prepareWorkerImageBuildContext(input: Readonly<{ packageRoot: string; parent: string; imageVersion: string; dockerfile: string; recipe: unknown }>) {
  if (!isAbsolute(input.parent) || !/^r[1-9][0-9]*-\d{8}$/.test(input.imageVersion)) throw new WorkerImageBuildError('WORKER_IMAGE_SOURCE_INVALID');
  const sources = await readWorkerImageSources(input.packageRoot);
  await mkdir(input.parent, { recursive: true, mode: 0o700 }); await privateDirectory(input.parent);
  const context = join(input.parent, input.imageVersion);
  try { await mkdir(context, { mode: 0o700 }); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new WorkerImageBuildError('WORKER_IMAGE_CONTEXT_EXISTS');
    throw error;
  }
  await privateDirectory(context);
  for (const name of WORKER_IMAGE_BUILDER_FILES) await copyFile(join(sources.directory, name), join(context, name), constants.COPYFILE_EXCL);
  await writeExclusive(join(context, 'Dockerfile'), input.dockerfile);
  await writeExclusive(join(context, 'recipe.json'), JSON.stringify(input.recipe, null, 2) + '\n');
  return Object.freeze({ context, files: [...WORKER_IMAGE_BUILDER_FILES, 'Dockerfile', 'recipe.json'] });
}
export type WorkerImageBuildRunner = (command: ProcessCommand) => Promise<ProcessEvidence>;
/** Runs the copied builder through the bounded process runner; the receipt file it writes is the only success evidence. */
export async function runWorkerImageBuild(input: Readonly<{ context: string; receiptPath: string; timeoutMs: number; outputBytes: number; env?: Readonly<Record<string, string>> }>,
  runner: WorkerImageBuildRunner = runNodeProcess) {
  if (!isAbsolute(input.context) || !isAbsolute(input.receiptPath)) throw new WorkerImageBuildError('WORKER_IMAGE_SOURCE_INVALID');
  await privateDirectory(input.context);
  const allowed = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'];
  const env = Object.fromEntries(Object.entries(input.env ?? process.env).filter(([key, value]) => allowed.includes(key) && typeof value === 'string')) as Record<string, string>;
  const command: ProcessCommand = { schemaVersion: 1, requestId: randomUUID(), executable: process.execPath, args: [join(input.context, 'build.mjs'), input.receiptPath],
    cwd: input.context, env, timeoutMs: input.timeoutMs, outputBytes: input.outputBytes };
  const evidence = await runner(command);
  if (evidence.reason === 'timeout') throw new WorkerImageBuildError('WORKER_IMAGE_BUILD_TIMEOUT', evidence);
  if (evidence.reason !== 'exit' || evidence.exitCode !== 0) throw new WorkerImageBuildError('WORKER_IMAGE_BUILD_FAILED', evidence);
  let receipt: unknown;
  try { receipt = JSON.parse(await readFile(input.receiptPath, 'utf8')); } catch { throw new WorkerImageBuildError('WORKER_IMAGE_RECEIPT_MISSING', evidence); }
  return Object.freeze({ receipt, evidence });
}
