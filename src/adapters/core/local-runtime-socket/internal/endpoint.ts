import { createHash } from 'node:crypto';
import { lstat, realpath, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';

export type LocalRuntimeSocketErrorCode = 'LOCAL_RUNTIME_UNSUPPORTED' | 'LOCAL_RUNTIME_NATIVE_UNAVAILABLE' | 'LOCAL_RUNTIME_OPTIONS'
  | 'LOCAL_RUNTIME_SOCKET_PATH_TOO_LONG' | 'LOCAL_RUNTIME_ENDPOINT_UNSAFE' | 'LOCAL_RUNTIME_ALREADY_RUNNING' | 'LOCAL_RUNTIME_TRANSPORT' | 'LOCAL_RUNTIME_UNAVAILABLE';
/** Which custody check refused (alpha.56.1): a closed token for LOCAL_RUNTIME_ENDPOINT_UNSAFE, never a path or file content. */
export type LocalRuntimeUnsafeReason = 'parent-create' | 'parent-stat' | 'parent-type' | 'parent-link' | 'parent-owner' | 'parent-mode' | 'parent-realpath'
  | 'socket-stat' | 'socket-type' | 'socket-link' | 'socket-owner' | 'socket-mode' | 'ledger-lock' | 'endpoint-remove';
export class LocalRuntimeSocketError extends Error {
  constructor(readonly code: LocalRuntimeSocketErrorCode, options?: ErrorOptions, readonly path?: string, readonly reason?: LocalRuntimeUnsafeReason) { super(code, options); this.name = 'LocalRuntimeSocketError'; }
}
/** An unsafe-endpoint refusal naming the check that refused. */
export const unsafeEndpoint = (reason: LocalRuntimeUnsafeReason, cause?: unknown) => new LocalRuntimeSocketError('LOCAL_RUNTIME_ENDPOINT_UNSAFE', cause === undefined ? undefined : { cause }, undefined, reason);
/** The socket directory checks shared by every reader and the server: a private directory of this uid at its own real path. */
export function socketParentRefusal(stat: Readonly<{ isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number }>): LocalRuntimeUnsafeReason | null {
  return stat.isSymbolicLink() ? 'parent-link' : !stat.isDirectory() ? 'parent-type' : stat.uid !== process.getuid!() ? 'parent-owner' : (stat.mode & 0o777) !== 0o700 ? 'parent-mode' : null;
}
/** The published socket checks: a socket (not a link) of this uid with mode 0600. */
export function socketFileRefusal(stat: Readonly<{ isSocket(): boolean; isSymbolicLink(): boolean; uid: number; mode: number }>): LocalRuntimeUnsafeReason | null {
  return stat.isSymbolicLink() ? 'socket-link' : !stat.isSocket() ? 'socket-type' : stat.uid !== process.getuid!() ? 'socket-owner' : (stat.mode & 0o777) !== 0o600 ? 'socket-mode' : null;
}

export type LocalRuntimeSocketOptions = Readonly<{ endpoint: string; maxConnections: number; inputMaxBytes: number;
  responseMaxBytes: number; headerTimeoutMs: number; responseTimeoutMs: number; acceptRetryDelayMs: number; acceptRetryLimit: number }>;
/** `custodyId`: the digest naming this endpoint's custody (the guard socket is `\0deckent-<custodyId>`). */
export type ResolvedLocalRuntimeSocketOptions = LocalRuntimeSocketOptions & Readonly<{ custodyId: string; guardEndpoint: string }>;

function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
export function assertSocketPublicationBudget(endpoint: string): void {
  const parent = dirname(endpoint);
  // Native same-parent staging uses '/.sXXXXXX/s'; include the trailing NUL in sun_path's 108 bytes.
  if (Buffer.byteLength(parent === '/' ? '' : parent, 'utf8') + 11 >= 108) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_SOCKET_PATH_TOO_LONG', undefined, endpoint);
}
/** The parent's real path. A stop removes its empty directory between the caller's `lstat` and this call: that is a stopped service, not an unsafe endpoint. */
export async function resolveSocketParent(parent: string): Promise<string> {
  try { return await realpath(parent); }
  catch (error) { throw (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? new LocalRuntimeSocketError('LOCAL_RUNTIME_UNAVAILABLE', { cause: error }) : unsafeEndpoint('parent-realpath', error); }
}
export async function resolveSocketOptions(options: LocalRuntimeSocketOptions): Promise<ResolvedLocalRuntimeSocketOptions> {
  if (process.platform !== 'linux' || !process.getuid) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_UNSUPPORTED');
  if (options?.endpoint && Buffer.byteLength(options.endpoint, 'utf8') >= 108) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_SOCKET_PATH_TOO_LONG', undefined, options.endpoint);
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
  catch (error) {
    // A clean stop removes its own empty directory: a missing parent is a stopped service (as in assertOwnedSocket); any other failure stays a custody refusal.
    const missing = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
    throw missing ? new LocalRuntimeSocketError('LOCAL_RUNTIME_UNAVAILABLE', { cause: error }) : unsafeEndpoint('parent-stat', error);
  }
  const refused = socketParentRefusal(stat) ?? (await resolveSocketParent(parent) !== resolve(parent) ? 'parent-realpath' : null);
  if (refused) throw unsafeEndpoint(refused);
  const digest = createHash('sha256').update(`${options.endpoint}\0${process.getuid()}`).digest('hex');
  return Object.freeze({ ...options, custodyId: digest, guardEndpoint: `\0deckent-${digest}` });
}

export async function assertOwnedSocket(endpoint: string): Promise<void> {
  let stat;
  try { stat = await lstat(endpoint); }
  catch (error) {
    // No endpoint means no running service; any other failure stays a custody refusal.
    const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    throw missing ? new LocalRuntimeSocketError('LOCAL_RUNTIME_UNAVAILABLE', { cause: error }) : unsafeEndpoint('socket-stat', error);
  }
  const refused = process.getuid ? socketFileRefusal(stat) : 'socket-owner';
  if (refused) throw unsafeEndpoint(refused);
}

export async function removeOwnedSocket(endpoint: string, missingIsSafe: boolean): Promise<void> {
  let stat; try { stat = await lstat(endpoint); }
  catch (error) {
    if (missingIsSafe && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw unsafeEndpoint('socket-stat', error);
  }
  const refused = process.getuid ? socketFileRefusal(stat) : 'socket-owner';
  if (refused && refused !== 'socket-mode') throw unsafeEndpoint(refused); // a stale socket of any mode is still this uid's own
  await rm(endpoint);
}
/** Clean stop or release, under custody and after the socket file is gone: only this uid's own empty `/tmp/dk-<uid>-<sha256>` directory (runtimeSocketLocation) goes too; rmdir never removes content, other parents stay and the stop never fails here. */
export async function releaseRuntimeSocketDirectory(endpoint: string): Promise<void> {
  if (process.getuid && new RegExp(`^/tmp/dk-${process.getuid()}-[0-9a-f]{64}$`, 'u').test(dirname(endpoint))) await rmdir(dirname(endpoint)).catch(() => undefined);
}
