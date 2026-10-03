import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { DeckentError, ErrorRegistry, redactSensitive } from '#platform/index.js';
import { isAbsolute, join } from 'node:path';
import { runNodeProcess, type ProcessCommand, type ProcessEvidence } from '#adapters/core/process-runner/index.js';

/** Only known builder reasons are promoted from stderr; arbitrary process output never becomes an error code. */
const BUILDER_REASONS = [
  'WORKER_VERSION_COUNTER_TAKEN', 'WORKER_VERSION_TAKEN', 'WORKER_IMAGE_COMMAND_FAILED',
  'WORKER_DAEMON_CHANGED', 'WORKER_IMAGE_ID_INVALID', 'WORKER_IMAGE_ID_MISMATCH',
  'WORKER_LABEL_MISMATCH', 'WORKER_TAG_MISMATCH', 'WORKER_RECEIPT_INVALID',
  'WORKER_RECEIPT_DIRECTORY_UNAVAILABLE', 'WORKER_HISTORY_COUNTER', 'WORKER_HISTORY_EMPTY',
  'WORKER_HISTORY_IDS', 'WORKER_HISTORY_LINE', 'WORKER_HISTORY_MISMATCH',
  'WORKER_HISTORY_ORDER', 'WORKER_RECIPE_INVALID', 'WORKER_RECIPE_PREVIOUS',
  'WORKER_RECIPE_REPOSITORY', 'WORKER_RECIPE_VERSION', 'WORKER_CLI_INCOMPATIBLE',
  'WORKER_VERSION_INVALID',
] as const;
export type WorkerImageBuildErrorCode = typeof BUILDER_REASONS[number] | 'WORKER_IMAGE_VERSION_CHECK_FAILED' | 'WORKER_IMAGE_VERSION_CHECK_TIMEOUT' | 'WORKER_IMAGE_SOURCE_INVALID' | 'WORKER_IMAGE_CONTEXT_EXISTS' | 'WORKER_IMAGE_CONTEXT_UNSAFE'
  | 'WORKER_IMAGE_BUILD_FAILED' | 'WORKER_IMAGE_BUILD_TIMEOUT' | 'WORKER_IMAGE_RECEIPT_MISSING';
/** Raw process evidence is retained for custody; the surface receives only a bounded redacted detail. */
export class WorkerImageBuildError extends DeckentError {
  readonly detail: string;
  constructor(override readonly code: WorkerImageBuildErrorCode, readonly evidence?: ProcessEvidence) {
    const detail = evidence ? failureDetail(evidence) : '';
    const localized = ErrorRegistry.createError(code, { params: { detail } });
    super(code, localized.message, localized.suggestion, localized.docLink, localized.whatHappened, localized.why,
      localized.howToFix, localized.category, undefined, localized.localize, localized.params);
    this.name = 'WorkerImageBuildError'; this.detail = detail;
  }
}
function errorLine(evidence: ProcessEvidence): string | undefined {
  return Buffer.from(evidence.stderrBase64, 'base64').toString('utf8').split('\n').find(line => /^Error: WORKER_[A-Z_]+(?::|$)/.test(line));
}
function failureDetail(evidence: ProcessEvidence): string {
  // Select the actual thrown reason rather than the echoed source line or stack. Redact before truncation.
  const text = errorLine(evidence) ?? Buffer.from(evidence.stderrBase64 || evidence.stdoutBase64, 'base64').toString('utf8').split('\n')[0] ?? '';
  const safe = redactSensitive(stripVTControlCharacters(text)).replace(/\p{Cc}/gu, ' ');
  return Buffer.from(safe).subarray(0, 512).toString('utf8').replace(/\uFFFD$/, '');
}
function processFailure(evidence: ProcessEvidence, fallback: WorkerImageBuildErrorCode): WorkerImageBuildError {
  const reason = /^Error: (WORKER_[A-Z_]+)(?::|$)/.exec(errorLine(evidence) ?? '')?.[1];
  const code = BUILDER_REASONS.find(code => code === reason) ?? fallback;
  return new WorkerImageBuildError(code, evidence);
}
const allowedEnvironment = (input: Readonly<Record<string, string | undefined>>) => Object.fromEntries(Object.entries(input)
  .filter((entry): entry is [string, string] => ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].includes(entry[0]) && typeof entry[1] === 'string'));
/** Checks the proposed counter against this repository's daemon tags through the installed builder's shared guard.
 * No build context, receipt, tag or image is created. A lagging lineage must be reconciled, never invented. */
export async function assertWorkerImageVersionAvailable(input: Readonly<{ packageRoot: string; imageVersion: string; timeoutMs: number; outputBytes: number; env?: Readonly<Record<string, string>> }>,
  runner: WorkerImageBuildRunner = runNodeProcess): Promise<void> {
  if (!isAbsolute(input.packageRoot) || !/^r[1-9][0-9]*-\d{8}$/.test(input.imageVersion)) throw new WorkerImageBuildError('WORKER_IMAGE_SOURCE_INVALID');
  const directory = join(input.packageRoot, WORKER_IMAGE_ASSET_DIRECTORY);
  const evidence = await runner({ schemaVersion: 1, requestId: randomUUID(), executable: process.execPath,
    args: [join(directory, 'build.mjs'), '--check-version', input.imageVersion], cwd: directory,
    env: allowedEnvironment(input.env ?? process.env), timeoutMs: input.timeoutMs, outputBytes: input.outputBytes });
  if (evidence.reason === 'timeout') throw new WorkerImageBuildError('WORKER_IMAGE_VERSION_CHECK_TIMEOUT', evidence);
  if (evidence.reason !== 'exit' || evidence.exitCode !== 0) throw processFailure(evidence, 'WORKER_IMAGE_VERSION_CHECK_FAILED');
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
  const env = allowedEnvironment(input.env ?? process.env);
  const command: ProcessCommand = { schemaVersion: 1, requestId: randomUUID(), executable: process.execPath, args: [join(input.context, 'build.mjs'), input.receiptPath],
    cwd: input.context, env, timeoutMs: input.timeoutMs, outputBytes: input.outputBytes };
  const evidence = await runner(command);
  if (evidence.reason === 'timeout') throw new WorkerImageBuildError('WORKER_IMAGE_BUILD_TIMEOUT', evidence);
  if (evidence.reason !== 'exit' || evidence.exitCode !== 0) throw processFailure(evidence, 'WORKER_IMAGE_BUILD_FAILED');
  let receipt: unknown;
  try { receipt = JSON.parse(await readFile(input.receiptPath, 'utf8')); } catch { throw new WorkerImageBuildError('WORKER_IMAGE_RECEIPT_MISSING', evidence); }
  return Object.freeze({ receipt, evidence });
}
