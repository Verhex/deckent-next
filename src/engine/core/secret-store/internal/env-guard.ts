import type { SecretStore } from './port.js';

export type SecretEnvironmentGuard = Readonly<Record<string, Readonly<{ names: readonly string[]; code: string | null }>>>;
/** Presence is tested through name metadata only. Unlistable/unsafe targets refuse, never appear empty. */
export async function missingSecretReferenceNames(names: readonly string[], target: SecretStore): Promise<readonly string[]> {
  if (!names.length) return names;
  const held = new Set(await target.listNames());
  return Object.freeze(names.filter(name => !held.has(name)));
}
/** Shared CLI/doctor preflight. Every failed target probe remains explicit; no secret value is read or retained. */
export async function inspectSecretEnvironmentGuard(names: readonly string[], stores: readonly SecretStore[]): Promise<SecretEnvironmentGuard> {
  const view: Record<string, { names: readonly string[]; code: string | null }> = Object.create(null) as Record<string, { names: readonly string[]; code: string | null }>;
  for (const store of stores) {
    try { view[store.descriptor.id] = { names: await missingSecretReferenceNames(names, store), code: null }; }
    catch (error) { const code = (error as { code?: unknown } | null)?.code;
      view[store.descriptor.id] = { names: [], code: typeof code === 'string' && /^SECRET_STORE_[A-Z_]+$/.test(code) ? code : 'SECRET_STORE_UNAVAILABLE' }; }
  }
  return Object.freeze(view);
}
