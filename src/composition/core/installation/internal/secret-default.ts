import { lstat } from 'node:fs/promises';
import { createInstallationSecretCustody, createInstallationSecretStoreSelection, ENCRYPTED_FILE_SECRET_STORE_ID, isRegisteredSecretStore, openRegisteredSecretStore } from '#adapters/index.js';
import { policySecretStoreSwitchAuthorization, SecretStoreSwitch, type SecretChangeAudit } from '#engine/index.js';
import type { AuditEvent } from '#domain/index.js';
import { normalizeGlobalScopePlatform, productResourcePath, resolveProductLayout, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { missingEnvironmentReferenceNames } from '#composition/core/secrets/index.js';
import { applyPolicyTemplateInstallation } from './policy-template.js';
import { loadComposedConfig } from '#composition/core/root/index.js';

/** What the first-run secret store default did: switched (with the switch's own record), kept (the installation config already selects a store),
 * not offered on this platform (native Windows until the OS keyring backend), or not done (a typed refusal; the installation itself stands). */
export type InstallationSecretStoreDefault = Readonly<{ status: 'set' | 'kept' | 'platform' | 'not-set'; backend: string | null; code?: string; path?: string;
  record?: Readonly<{ policyRevision: string; atMs: number; subject: AuditEvent['subject'] }> }>;

/** Fresh installer default via the governed store switch (owner 2026-10-08): the command result carries the switch record while no ledger exists.
 * Existing selections/installations and native Windows are kept; a refusal is visible without undoing the installation. */
export async function applyPolicyTemplateInstallationWithSecretDefault(projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}) {
  // The layout the installation writes (this process's config and environment; `options` only selects the store default below):
  // the configured data root, the default only when the config is unreadable.
  const policy = productResourcePath(await loadComposedConfig(projectRoot, { heal: false, force: true }).then(config => config.productLayout, () => resolveProductLayout({ projectRoot })), 'policy');
  const fresh = await lstat(policy).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  const result = await applyPolicyTemplateInstallation(projectRoot, scopeId);
  if (!fresh || result.status !== 'installed') return result;
  return Object.freeze({ ...result, secretStore: await defaultSecretStore(projectRoot, scopeId, options) });
}

/** The selection the switch found inside the custody section when one was already made (the default then keeps it). */
class KeptSelection { constructor(readonly store: string) {} }

export async function defaultSecretStore(projectRoot: string, scopeId: string, options: ConfigLoadOptions, audit?: SecretChangeAudit): Promise<InstallationSecretStoreDefault> {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform;
  try {
    if (normalizeGlobalScopePlatform(platform, env) === 'win32') return Object.freeze({ status: 'platform', backend: null });
    const installation = createInstallationSecretStoreSelection(env, platform), selected = (await installation.read()).store;
    if (selected !== null) return Object.freeze({ status: 'kept', backend: selected });
    const context = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write'), clock = new SystemTrustedClock();
    const records: AuditEvent[] = [];
    // The switch reads the selection again inside the custody section: a store chosen meanwhile is kept, never moved by this default.
    const selection = { read: async () => { const current = await installation.read(); if (current.store !== null) throw new KeptSelection(current.store); return current; },
      publish: installation.publish };
    await new SecretStoreSwitch({ has: isRegisteredSecretStore, open: id => openRegisteredSecretStore(id, env, platform), selection,
      authorize: policySecretStoreSwitchAuthorization(context.document, context.principal), audit: async event => { await audit?.(event); records.push(event); },
      now: () => clock.sample().wallMs, custody: createInstallationSecretCustody(env, platform),
      environmentReferences: target => missingEnvironmentReferenceNames(projectRoot, options, target) })
      .switch({ principal: { issuer: context.principal.issuer, subject: context.principal.subject }, scopeId, to: ENCRYPTED_FILE_SECRET_STORE_ID, confirmDowngrade: false });
    const record = records[0]!;
    return Object.freeze({ status: 'set', backend: ENCRYPTED_FILE_SECRET_STORE_ID,
      record: Object.freeze({ policyRevision: record.policyRevision, atMs: record.atMs, subject: record.subject }) });
  } catch (error) {
    if (error instanceof KeptSelection) return Object.freeze({ status: 'kept', backend: error.store });
    // U1 S1: the refused directory travels with the code (SECRET_STORE_UNSAFE names it), so init and doctor can say which one to make private.
    const { code, params } = (error ?? {}) as { code?: unknown; params?: { path?: unknown } }, path = params?.path;
    return Object.freeze({ status: 'not-set', backend: null, ...(typeof code === 'string' ? { code } : {}), ...(typeof path === 'string' && path ? { path } : {}) });
  }
}
