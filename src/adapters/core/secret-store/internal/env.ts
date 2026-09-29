import { ErrorRegistry, type Environment } from '#platform/index.js';
import type { SecretStore, SecretStoreContext, SecretStoreFactory } from '#engine/index.js';

export const ENV_SECRET_STORE_ID = 'core.secret-store.env@1';
/**
 * `core.secret-store.env@1` — the default backend and the behaviour every read site had before SECRET-K1: a reference resolves to the
 * caller's own environment property of that name. Read-only (Deckent cannot persist into a process environment) and not enumerable
 * (a list of environment variables is not a list of secrets).
 */
export function createEnvironmentSecretStore(env: Environment): SecretStore {
  const refuse = (code: 'SECRET_STORE_READ_ONLY' | 'SECRET_STORE_UNSUPPORTED') => Promise.reject(ErrorRegistry.createError(code, { params: { backend: ENV_SECRET_STORE_ID } }));
  return Object.freeze({
    descriptor: Object.freeze({ id: ENV_SECRET_STORE_ID, writable: false, enumerable: false }),
    get: async (name: string) => Object.hasOwn(env, name) ? env[name] : undefined,
    set: () => refuse('SECRET_STORE_READ_ONLY'),
    delete: () => refuse('SECRET_STORE_READ_ONLY'),
    listNames: () => refuse('SECRET_STORE_UNSUPPORTED'),
    inspect: async () => Object.freeze({ status: 'ready' as const, code: null }),
  });
}
export const environmentSecretStoreFactory: SecretStoreFactory = Object.freeze({ id: ENV_SECRET_STORE_ID, create: (context: SecretStoreContext) => createEnvironmentSecretStore(context.env) });
