import { attestLocalInteractiveTerminal, installationSecretRoot, localPrincipalChannel, localPrincipalPeer, openConfiguredSecretStore, openLocalIntegrityAuthority, openSqliteAuditStore } from '#adapters/index.js';
import { assertAuthorityWitness, AuditApplication, type AuthorityWitness } from '#engine/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { defaultSecretStore } from '#composition/core/installation/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { changeProjectSecretGrant } from '#composition/core/secrets/index.js';
import { terminalSecretGrantOffer } from '#composition/core/terminal-chat/index.js';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

export type ProviderSecretStep = Readonly<{ state: 'ready' | 'stored' | 'granted' | 'refused' | 'admin' | 'skipped'; code?: string; path?: string }>;
export type ProviderCustodyResult = ProviderSecretStep & Readonly<{ backend: string | null }>;
export type ProviderSecretResult = Readonly<{ name: string; backend: string | null; custody: ProviderSecretStep; key: ProviderSecretStep; grant: ProviderSecretStep }>;
const witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() };
const refusal = (error: unknown): ProviderSecretStep => {
  const failure = queryFailure(error), path = failure.params?.['path'];
  return { state: 'refused', code: failure.code, ...(typeof path === 'string' ? { path } : {}) };
};

/** Before reading a key: retain explicit selections; retry the absent default through the same switch, with a durable audit this time. */
export async function prepareProviderSecret(projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}, authority: AuthorityWitness = witness): Promise<ProviderCustodyResult> {
  try {
    await assertAuthorityWitness('secretSet', localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), authority);
    const selected = await defaultSecretStore(projectRoot, scopeId, options, async event => {
      const context = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write');
      const store = await openSqliteAuditStore(await context.path(), context.config.storage.sqlite, 'forbid');
      try { new AuditApplication(store, await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true)).record(event); }
      finally { store.close(); }
    });
    if (selected.status === 'not-set') return { state: 'refused', backend: null, code: selected.code ?? 'SECRET_STORE_UNAVAILABLE', ...(selected.path ? { path: selected.path } : {}) };
    const config = await loadComposedConfig(projectRoot, { ...options, force: true, heal: false, secretResolver: async () => undefined });
    const store = openConfiguredSecretStore(config, options.env ?? process.env, options.platform);
    const health = await store.inspect();
    if (health.code) {
      const path = installationSecretRoot(options.env ?? process.env, options.platform);
      return { state: 'refused', backend: store.descriptor.id, code: health.code, ...(health.code === 'SECRET_STORE_UNSAFE' && path ? { path } : {}) };
    }
    if (!store.descriptor.writable) return { state: 'refused', backend: store.descriptor.id, code: 'SECRET_STORE_READ_ONLY' };
    return { state: 'ready', backend: store.descriptor.id };
  } catch (error) { return { ...refusal(error), backend: null }; }
}

/** Trusted code ports; never selectable through configuration or a surface request. */
export interface ProviderSecretHost {
  prepare(): Promise<ProviderCustodyResult>;
  set(name: string, value: string): Promise<Readonly<{ backend: string }>>;
  offer(): Promise<boolean>;
  grant(name: string): Promise<unknown>;
}
/** Custody → key → grant. A grant refusal preserves the stored key and its typed partial result. */
export async function connectProvider(projectRoot: string, input: Readonly<{ scopeId: string; name: string; value: string; grant: boolean }>, options: ConfigLoadOptions = {},
  host: ProviderSecretHost = { prepare: () => prepareProviderSecret(projectRoot, input.scopeId, options),
    set: (name, value) => createConfiguredRuntimeClient(projectRoot, options).setSecret({ schemaVersion: 1, scopeId: input.scopeId, name, value }),
    offer: () => terminalSecretGrantOffer(projectRoot, options),
    grant: name => changeProjectSecretGrant(projectRoot, input.scopeId, name, 'grant', 'card', options) }): Promise<ProviderSecretResult> {
  const custody = await host.prepare(), skipped: ProviderSecretStep = { state: 'skipped' };
  const result = { name: input.name, backend: custody.backend, custody, key: skipped, grant: skipped };
  if (custody.state !== 'ready') return result;
  let backend: string;
  try { backend = (await host.set(input.name, input.value)).backend; }
  catch (error) { return { ...result, key: refusal(error) }; }
  const stored = { ...result, backend, key: { state: 'stored' as const } };
  try {
    if (!input.grant || !await host.offer()) return { ...stored, grant: { state: 'admin', code: 'SECRET_GRANT_REQUIRED' } };
    await host.grant(input.name);
    return { ...stored, grant: { state: 'granted' } };
  } catch (error) { return { ...stored, grant: refusal(error) }; }
}
