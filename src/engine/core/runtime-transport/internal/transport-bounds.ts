import { isAbsolute, normalize } from 'node:path';
function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
/** Pure wire/path-shape validation. OS support, filesystem ownership and publication stay with the adapter. */
export function resolveSocketOptions(options: { endpoint: string; maxConnections: number; inputMaxBytes: number; responseMaxBytes: number; headerTimeoutMs: number; responseTimeoutMs: number; acceptRetryDelayMs: number; acceptRetryLimit: number }, refuse: (code: 'LOCAL_RUNTIME_SOCKET_PATH_TOO_LONG' | 'LOCAL_RUNTIME_OPTIONS', path?: string) => Error): void {
  if (options?.endpoint && Buffer.byteLength(options.endpoint, 'utf8') >= 108) throw refuse('LOCAL_RUNTIME_SOCKET_PATH_TOO_LONG', options.endpoint);
  if (!options || !isAbsolute(options.endpoint) || normalize(options.endpoint) !== options.endpoint
    || options.endpoint.includes('\0') || Buffer.byteLength(options.endpoint, 'utf8') >= 108
    || !positive(options.maxConnections) || !positive(options.inputMaxBytes) || options.inputMaxBytes > 0xffffffff
    || !positive(options.responseMaxBytes) || options.responseMaxBytes > 0xffffffff
    || !positive(options.headerTimeoutMs) || options.headerTimeoutMs > 0x7fffffff
    || !positive(options.responseTimeoutMs) || options.responseTimeoutMs > 0x7fffffff
    || !positive(options.acceptRetryDelayMs) || options.acceptRetryDelayMs > 0x7fffffff
    || !positive(options.acceptRetryLimit) || options.acceptRetryLimit > 0x7fffffff) {
    throw refuse('LOCAL_RUNTIME_OPTIONS');
  }
}
