import { userInfo } from 'node:os';
import { policySchema, IdentityProfileError, identityPreviewRequestSchema } from '#domain/index.js';
import { IdentityProfileApplication, IdentityProfileRegistry } from '#engine/index.js';
import { readIdentityProfileConfig, readLocalOsIdentity } from '#adapters/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { resolveConfiguredScopeMembership } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
/** Reads one resolved policy/bindings snapshot. Never calls the project identity bootstrap or opens a ledger writer. */
export async function previewConfiguredIdentityProfile(root: string, input: unknown, packages: readonly unknown[] = [], options: ConfigLoadOptions = {}) {
  try {
    const request = identityPreviewRequestSchema.safeParse(input);
    if (!request.success) throw new IdentityProfileError('IDENTITY_PREVIEW_INVALID');
    const config = await loadComposedConfig(root, { ...options, heal: false }), selection = readIdentityProfileConfig(config['identity']);
    const registry = new IdentityProfileRegistry([...(selection?.packages ?? []), ...packages]);
    const profile = request.data.profile ?? selection?.profile;
    if (!profile) throw new IdentityProfileError('IDENTITY_PROFILE_INVALID');
    return await new IdentityProfileApplication(registry, { async load(scopes) {
      const identity = readLocalOsIdentity();
      const policy = policySchema.parse(await createLayoutPolicySource(config.productLayout, userInfo().uid, config.inspection.policyMaxBytes).load());
      const scopeIds = await resolveConfiguredScopeMembership(config, policy, identity, scopes, 'read');
      return { companyId: config.company.id, principal: { ...identity, scopeIds }, policy, projectScopeIds: scopeIds };
    } }).preview({ ...request.data, profile });
  } catch (error) {
    if (error instanceof IdentityProfileError) throw ErrorRegistry.createError(error.code);
    throw queryFailure(error);
  }
}
export function listIdentityProfiles(packages: readonly unknown[] = []) {
  try {
    return new IdentityProfileApplication(new IdentityProfileRegistry(packages), { load: async () => { throw new IdentityProfileError('IDENTITY_PREVIEW_UNAVAILABLE'); } }).profiles();
  } catch (error) {
    if (error instanceof IdentityProfileError) throw ErrorRegistry.createError(error.code);
    throw queryFailure(error);
  }
}
