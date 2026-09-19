import { createHash } from 'node:crypto';
import { lstat, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';

export type LocalRuntimeSocketErrorCode = 'LOCAL_RUNTIME_UNSUPPORTED' | 'LOCAL_RUNTIME_OPTIONS'
  | 'LOCAL_RUNTIME_ENDPOINT_UNSAFE' | 'LOCAL_RUNTIME_ALREADY_RUNNING' | 'LOCAL_RUNTIME_TRANSPORT';
export class LocalRuntimeSocketError extends Error {
  constructor(readonly code: LocalRuntimeSocketErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = 'LocalRuntimeSocketError';
  }
}

export type LocalRuntimeSocketOptions = Readonly<{ endpoint: string; maxConnections: number; inputMaxBytes: number;
  responseMaxBytes: number; headerTimeoutMs: number; responseTimeoutMs: number; acceptRetryDelayMs: number; acceptRetryLimit: number }>;
export type ResolvedLocalRuntimeSocketOptions = LocalRuntimeSocketOptions & Readonly<{ guardEndpoint: string }>;

function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
export async function resolveSocketOptions(options: LocalRuntimeSocketOptions): Promise<ResolvedLocalRuntimeSocketOptions> {
  if (process.platform !== 'linux' || !process.getuid) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_UNSUPPORTED');
  if (!options || !isAbsolute(options.endpoint) || normalize(options.endpoint) !== options.endpoint
    || options.endpoint.includes('\0') || Buffer.byteLength(options.endpoint, 'utf8') >= 108
    || !positive(options.maxConnections) || !positive(options.inputMaxBytes) || options.inputMaxBytes > 0xffffffff
    || !positive(options.responseMaxBytes) || options.responseMaxBytes > 0xffffffff
    || !positive(options.headerTimeoutMs) || options.headerTimeoutMs > 0x7fffffff
    || !positive(options.responseTimeoutMs) || options.responseTimeoutMs > 0x7fffffff
    || !positive(options.acceptRetryDelayMs) || options.acceptRetryDelayMs > 0x7fffffff
    || !positive(options.acceptRetryLimit) || options.acceptRetryLimit > 0x7fffffff) {
    throw new LocalRuntimeSocketError('LOCAL_RUNTIME_OPTIONS');
  }
  const parent = dirname(options.endpoint);
  let stat;
  try { stat = await lstat(parent); }
  catch (error) { throw new LocalRuntimeSocketError('LOCAL_RUNTIME_ENDPOINT_UNSAFE', { cause: error }); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700
    || await realpath(parent) !== resolve(parent)) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_ENDPOINT_UNSAFE');
  const digest = createHash('sha256').update(`${options.endpoint}\0${process.getuid()}`).digest('hex');
  return Object.freeze({ ...options, guardEndpoint: `\0deckent-${digest}` });
}

export async function assertOwnedSocket(endpoint: string): Promise<void> {
  let stat;
  try { stat = await lstat(endpoint); }
  catch (error) { throw new LocalRuntimeSocketError('LOCAL_RUNTIME_ENDPOINT_UNSAFE', { cause: error }); }
  if (!process.getuid || !stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o777) !== 0o600) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_ENDPOINT_UNSAFE');
}

export async function removeOwnedSocket(endpoint: string, missingIsSafe: boolean): Promise<void> {
  let stat;
  try { stat = await lstat(endpoint); }
  catch (error) {
    if (missingIsSafe && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new LocalRuntimeSocketError('LOCAL_RUNTIME_ENDPOINT_UNSAFE', { cause: error });
  }
  if (!process.getuid || !stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid()) {
    throw new LocalRuntimeSocketError('LOCAL_RUNTIME_ENDPOINT_UNSAFE');
  }
  await rm(endpoint);
}
