import { lstat } from 'node:fs/promises';
import { createInstallationSecretCustody, createInstallationSecretStoreSelection, ENCRYPTED_FILE_SECRET_STORE_ID, isRegisteredSecretStore, openRegisteredSecretStore } from '#adapters/index.js';
import { policySecretStoreSwitchAuthorization, SecretStoreSwitch, type SecretChangeAudit } from '#engine/index.js';
import type { AuditEvent } from '#domain/index.js';
import { normalizeGlobalScopePlatform, productResourcePath, resolveProductLayout, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { missingEnvironmentReferenceNames } from '#composition/core/secrets/index.js';
import { applyPolicyTemplateInstallation } from './policy-template.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { registerFreshInstallation } from './attachment.js';
/** A refused secret-store default leaves the installation standing; a successful switch carries its own record. */
export type InstallationSecretStoreDefault = Readonly<{ status: 'set' | 'kept' | 'platform' | 'not-set'; backend: string | null; code?: string; path?: string;
  record?: Readonly<{ policyRevision: string; atMs: number; subject: AuditEvent['subject'] }> }>;
export async function applyPolicyTemplateInstallationWithSecretDefault(projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}) {
  // Keep the installer's process environment and layout fallback; options select the secret-store default.
  const layout = await loadComposedConfig(projectRoot, { heal: false, force: true }).then(config => config.productLayout, () => resolveProductLayout({ projectRoot }));
  const absent = (resource: 'policy' | 'installationIdentity') => lstat(productResourcePath(layout, resource)).then(() => false, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return true; throw error; });
  const fresh = await absent('policy'), newIdentity = fresh && await absent('installationIdentity'), result = await applyPolicyTemplateInstallation(projectRoot, scopeId);
  if (!fresh || result.status !== 'installed') return result;
  const secretStore = await defaultSecretStore(projectRoot, scopeId, options);
  return Object.freeze({ ...result, secretStore, ...(newIdentity ? { registration: await registerFreshInstallation(projectRoot, scopeId, {}) } : {}) });
}
class KeptSelection { constructor(readonly store: string) {} }
export async function defaultSecretStore(projectRoot: string, scopeId: string, options: ConfigLoadOptions, audit?: SecretChangeAudit): Promise<InstallationSecretStoreDefault> {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform;
  try {
    if (normalizeGlobalScopePlatform(platform, env) === 'win32') return Object.freeze({ status: 'platform', backend: null });
    const installation = createInstallationSecretStoreSelection(env, platform), selected = (await installation.read()).store;
    if (selected !== null) return Object.freeze({ status: 'kept', backend: selected });
    const context = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write'), clock = new SystemTrustedClock();
    const records: AuditEvent[] = []; // Re-read under custody: a concurrently chosen store is kept.
    const selection = { publish: installation.publish, read: async () => { const current = await installation.read(); if (current.store !== null) throw new KeptSelection(current.store); return current; } };
    await new SecretStoreSwitch({ has: isRegisteredSecretStore, open: id => openRegisteredSecretStore(id, env, platform), selection,
      authorize: policySecretStoreSwitchAuthorization(context.document, context.principal), audit: async event => { await audit?.(event); records.push(event); },
      now: () => clock.sample().wallMs, custody: createInstallationSecretCustody(env, platform), environmentReferences: target => missingEnvironmentReferenceNames(projectRoot, options, target) })
      .switch({ principal: { issuer: context.principal.issuer, subject: context.principal.subject }, scopeId, to: ENCRYPTED_FILE_SECRET_STORE_ID, confirmDowngrade: false });
    const record = records[0]!;
    return Object.freeze({ status: 'set', backend: ENCRYPTED_FILE_SECRET_STORE_ID, record: Object.freeze({ policyRevision: record.policyRevision, atMs: record.atMs, subject: record.subject }) });
  } catch (error) {
    if (error instanceof KeptSelection) return Object.freeze({ status: 'kept', backend: error.store });
    const { code, params } = (error ?? {}) as { code?: unknown; params?: { path?: unknown } }, path = params?.path;
    return Object.freeze({ status: 'not-set', backend: null, ...(typeof code === 'string' ? { code } : {}), ...(typeof path === 'string' && path ? { path } : {}) });
  }
}
