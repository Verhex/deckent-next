import { userInfo } from 'node:os';
import { policySchema, IdentityProfileError, identityPreviewRequestSchema } from '#domain/index.js';
import { IdentityProfileApplication, IdentityProfileRegistry, type IdentityPreviewSource } from '#engine/index.js';
import { readIdentityProfileConfig, readLocalOsIdentity } from '#adapters/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { resolveConfiguredScopeMembership } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
/** One read-only snapshot producer shared by drafts and governed distribution. No identity bootstrap or ledger writer. */
export async function identityProfileContext(root: string, packages: readonly unknown[], options: ConfigLoadOptions) {
  const config = await loadComposedConfig(root, { ...options, heal: false }), selection = readIdentityProfileConfig(config['identity']);
  const source: IdentityPreviewSource = { async load(scopes) {
    const identity = readLocalOsIdentity(), policy = policySchema.parse(await createLayoutPolicySource(config.productLayout, userInfo().uid, config.inspection.policyMaxBytes).load());
    const scopeIds = await resolveConfiguredScopeMembership(config, policy, identity, scopes, 'read');
    return { companyId: config.company.id, principal: { ...identity, scopeIds }, policy, projectScopeIds: scopeIds };
  } }; return { config, selection, source, registry: new IdentityProfileRegistry([...(selection?.packages ?? []), ...packages]) };
}
export function identityFailure(error: unknown): never { throw error instanceof IdentityProfileError ? ErrorRegistry.createError(error.code) : queryFailure(error); }
export async function previewConfiguredIdentityProfile(root: string, input: unknown, packages: readonly unknown[] = [], options: ConfigLoadOptions = {}) {
  try { const request = identityPreviewRequestSchema.safeParse(input); if (!request.success) throw new IdentityProfileError('IDENTITY_PREVIEW_INVALID');
    const { source, registry, selection } = await identityProfileContext(root, packages, options), profile = request.data.profile ?? selection?.profile;
    if (!profile) throw new IdentityProfileError('IDENTITY_PROFILE_INVALID');
    return await new IdentityProfileApplication(registry, source).preview({ ...request.data, profile });
  } catch (error) { return identityFailure(error); }
}
export function listIdentityProfiles(packages: readonly unknown[] = []) {
  try { return new IdentityProfileApplication(new IdentityProfileRegistry(packages), { load: async () => { throw new IdentityProfileError('IDENTITY_PREVIEW_UNAVAILABLE'); } }).profiles(); }
  catch (error) { return identityFailure(error); }
}
