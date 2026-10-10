import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ErrorRegistry } from '#platform/index.js';
import { SECRET_STORE_ID_PATTERN, SECRET_VALUE_MAX_BYTES, isSecretName, type SecretStoreContext, type SecretStoreFactory } from './port.js';
import type { SecretChangeDecision } from './administration.js';

/** Trusted distribution constants; configuration selects only the registered id. Command material must contain no credentials and live
 * outside worker-writable paths. The application authorization port binds the current verified principal, scope and policy on each read.
 */
export interface SecretHelperOptions {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Combined stdout + stderr bytes, including optional terminal CRLF. */
  readonly maxOutputBytes: number;
  readonly authorize: (request: Readonly<{ backend: string; name: string }>) => Promise<SecretChangeDecision>;
}
/** Internal I/O port: adapter must dispose pipes and kill the process group on abort. No secret output/raw exceptions in its errors. */
export type SecretHelperReadPort = (options: SecretHelperOptions, name: string, signal: AbortSignal) => Promise<string | undefined>;
const text = z.string().refine(value => !value.includes('\0'));
const definition = z.object({ id: z.string().regex(SECRET_STORE_ID_PATTERN).refine(id => !id.startsWith('core.')),
  executable: text.refine(isAbsolute), args: z.array(text), cwd: text.refine(isAbsolute),
  timeoutMs: z.number().int().positive().safe().max(2_147_483_647),
  maxOutputBytes: z.number().int().positive().max(SECRET_VALUE_MAX_BYTES + 2), authorize: z.custom<SecretHelperOptions['authorize']>(value => typeof value === 'function') }).strict();

/** One application owner for authorization, deadline and concurrency. All store instances of a factory share one admission slot.
 * Late authorization cannot execute after the deadline. No queue, retries, cached value or cross-store fallback.
 */
export function createSecretHelperBackend(input: SecretHelperOptions, read: SecretHelperReadPort, hostPlatform: string): SecretStoreFactory {
  const parsed = definition.safeParse(input);
  if (!parsed.success) throw ErrorRegistry.createError('SECRET_HELPER_INVALID');
  const options = Object.freeze({ ...parsed.data, args: Object.freeze([...parsed.data.args]) });
  let busy = false;
  const lookup = async (name: string) => {
    if (busy) throw ErrorRegistry.createError('SECRET_STORE_BUSY');
    busy = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(ErrorRegistry.createError('SECRET_HELPER_TIMEOUT')); }, options.timeoutMs);
      });
      const work = (async () => {
        let decision: SecretChangeDecision;
        try { decision = await options.authorize(Object.freeze({ backend: options.id, name })); }
        catch { throw ErrorRegistry.createError('SECRET_HELPER_DENIED'); }
        if (controller.signal.aborted) throw ErrorRegistry.createError('SECRET_HELPER_TIMEOUT');
        if (decision?.effect !== 'allow') throw ErrorRegistry.createError('SECRET_HELPER_DENIED');
        return read(options, name, controller.signal);
      })();
      return await Promise.race([work, timeout]);
    } finally { clearTimeout(timer); busy = false; }
  };
  return Object.freeze({ id: options.id, create: (context: SecretStoreContext) => {
    const supported = context.platform === hostPlatform && (context.platform === 'linux' || context.platform === 'darwin');
    const refuse = (code: 'SECRET_STORE_READ_ONLY' | 'SECRET_STORE_UNSUPPORTED') => Promise.reject(ErrorRegistry.createError(code, { params: { backend: options.id } }));
    return Object.freeze({ descriptor: Object.freeze({ id: options.id, writable: false, enumerable: false }),
      async get(name: string) {
        if (!isSecretName(name)) throw ErrorRegistry.createError('SECRET_NAME_INVALID');
        if (!supported) throw ErrorRegistry.createError('SECRET_STORE_UNAVAILABLE', { params: { backend: options.id } });
        return lookup(name);
      },
      set: () => refuse('SECRET_STORE_READ_ONLY'), delete: () => refuse('SECRET_STORE_READ_ONLY'), listNames: () => refuse('SECRET_STORE_UNSUPPORTED'),
      // Inspection proves no external credential availability; it never executes a command or authorization callback.
      inspect: async () => Object.freeze({ status: 'unavailable' as const, code: 'SECRET_STORE_UNAVAILABLE' as const }),
    });
  } });
}
