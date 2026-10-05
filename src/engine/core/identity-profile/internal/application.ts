import { companyIdSchema, policySchema, verifiedPrincipalSchema, evaluatePolicy, draftIdentityPolicy, validateIdentityDraft, identityPermissionDiff,
  identityPreviewInputSchema, encodeIdentityProfile, IdentityProfileError, type Policy, type VerifiedPrincipal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { IdentityProfileRegistry } from './registry.js';
export interface IdentityPreviewSnapshot {
  readonly companyId: string; readonly principal: VerifiedPrincipal; readonly policy: Policy;
  /** Existing, membership-checked project scopes only. No bootstrap, registration or future scopes. */
  readonly projectScopeIds: readonly string[];
}
/** Deliberately contains no policy writer, ledger, audit writer, effect broker or model port. */
export interface IdentityPreviewSource { load(projectScopeIds: readonly string[]): Promise<IdentityPreviewSnapshot> }
export class IdentityProfileApplication {
  constructor(private readonly registry: IdentityProfileRegistry, private readonly source: IdentityPreviewSource) {}
  profiles() { return Object.freeze({ schemaVersion: 1 as const, registryVersion: this.registry.version, registryDigest: this.registry.digest, profiles: this.registry.list() }); }
  async preview(raw: unknown) {
    const parsed = identityPreviewInputSchema.safeParse(raw);
    if (!parsed.success) throw new IdentityProfileError('IDENTITY_PREVIEW_INVALID');
    const input = parsed.data, profile = this.registry.resolve(input.profile), scopes = input.projectScopeIds ?? [input.scopeId];
    const snapshot = await this.source.load(scopes);
    const policy = policySchema.parse(snapshot.policy), principal = verifiedPrincipalSchema.parse(snapshot.principal), companyId = companyIdSchema.parse(snapshot.companyId);
    validateIdentityDraft(input, companyId, scopes);
    for (const scopeId of scopes) {
      if (!snapshot.projectScopeIds.includes(scopeId) || !principal.scopeIds.includes(scopeId)
        || evaluatePolicy(policy, { principal, scopeId, action: 'inspect', resource: { kind: 'scope', id: scopeId } }).decision !== 'allow') {
        throw new IdentityProfileError('IDENTITY_PREVIEW_SCOPE_DENIED');
      }
    }
    const planned = draftIdentityPolicy(input, profile.definition, policy, scopes);
    const differences = identityPermissionDiff(input, policy, planned.candidate, scopes);
    const draft = Object.freeze({ schemaVersion: 1 as const, state: 'draft' as const, grantsAuthority: false as const, canApply: false as const,
      source: 'deterministic-template' as const, validation: 'structurally-validated' as const, companyId, scopeId: input.scopeId, projectScopeIds: Object.freeze([...scopes]),
      profile: Object.freeze({ ...input.profile, digest: profile.digest }),
      members: Object.freeze(input.members.map(member => Object.freeze({ ...member, verification: 'unverified' as const }))),
      organization: input.organization, addedRoles: Object.freeze(planned.addedRoles), addedBindings: Object.freeze(planned.addedBindings), removedBindings: Object.freeze(planned.removedBindings),
      approvalPolicyTemplate: profile.definition.approvalPolicyTemplate,
      currentSeparationOfDuties: Object.freeze(policy.schemaVersion === 2 ? policy.separationOfDuties.filter(rule => rule.scopes === 'all' || rule.scopes.some(scope => scopes.includes(scope))) : []),
      futureProjects: Object.freeze({ requested: input.includeFutureProjects === true, applied: false as const }),
      unresolvedRequirements: profile.definition.requires,
      // No adapter/directory verifier is invoked by I1; requirements and organization are descriptive only.
      unsupportedHierarchyNodeIds: Object.freeze(input.organization.filter(node => !profile.definition.hierarchyOptions.nodeKinds.includes(node.kind)).map(node => node.id)),
      preserved: Object.freeze({ grants: true, restrictions: true, roles: true, permissionModes: true, separationOfDuties: true, approvalAssurance: true, otherBindings: true }),
    });
    const pins = Object.freeze({ registryVersion: this.registry.version, registryDigest: this.registry.digest,
      policyRevision: policy.schemaVersion === 2 ? policy.policyRevision : policy.revision,
      bindingsRevision: policy.schemaVersion === 2 ? policy.bindings.revision : null,
      effectivePolicyRevision: policy.revision, policyDigest: sha256(encodeIdentityProfile(policy)),
      inputDigest: sha256(encodeIdentityProfile(input)), actor: principal,
    });
    const result = { schemaVersion: 1 as const, draft, pins, differences,
      comparison: 'hypothetical-policy-cells' as const, unaffectedBindings: policy.schemaVersion === 2 ? policy.bindings.entries.filter(b => !input.removeBindingIds.includes(b.id)).length : 0 };
    let digest: string;
    try { digest = sha256(encodeIdentityProfile(result)); }
    catch { throw new IdentityProfileError('IDENTITY_PREVIEW_LIMIT'); }
    return Object.freeze({ ...result, digest });
  }
}
export type IdentityProfilePreview = Awaited<ReturnType<IdentityProfileApplication['preview']>>;
export type IdentityProfileListing = ReturnType<IdentityProfileApplication['profiles']>;
