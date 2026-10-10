import { AUTHORITY_DOCUMENT_TARGET_KIND, POLICY_ADMINISTER_OPERATION, authorityDocuments, delegationWithin, evaluatePolicy, isMcpPrincipal,
  identityDistributionSelectionSchema, identityDistributionSubmissionSchema, encodeIdentityProfile, IdentityProfileError, planPolicyChange, policySchema,
  type IdentityDistributionSubmission, type VerifiedPrincipal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import type { EffectStore } from '#engine/core/effect/index.js';
import type { PersistentStandingDependencies } from '#engine/core/approval/index.js';
import { IdentityProfileApplication, type IdentityPreviewSnapshot } from './application.js';
import { IdentityProfileRegistry } from './registry.js';

export interface IdentityPrincipalChoice {
  readonly id: string; readonly label: string; readonly kind: 'human' | 'machine' | 'agent';
  /** Produced by the installed verifier/directory port, never accepted from a persona or user-authored draft. */
  readonly principal: { readonly issuer: string; readonly subject: string };
}
/** Core port for an installed directory/IdP. The local composition only supplies its verified OS caller. */
export interface IdentityDistributionSource {
  load(projectScopeIds: readonly string[]): Promise<IdentityPreviewSnapshot & { readonly principals: readonly IdentityPrincipalChoice[] }>;
}
export interface IdentityDistributionDependencies extends Pick<PersistentStandingDependencies, 'administration'> {
  readonly effects: Pick<EffectStore, 'loadEffect'>;
}
const fail = (code: 'IDENTITY_PREVIEW_INVALID' | 'IDENTITY_PREVIEW_CONFLICT' | 'IDENTITY_PREVIEW_UNAVAILABLE' | 'IDENTITY_PREVIEW_SCOPE_DENIED'): never => { throw new IdentityProfileError(code); };
const equal = (left: unknown, right: unknown) => encodeIdentityProfile(left) === encodeIdentityProfile(right);
function admin(policy: ReturnType<typeof policySchema.parse>, principal: VerifiedPrincipal, scopeId: string) {
  if (isMcpPrincipal(principal) || principal.assurance !== 'os-user'
    || evaluatePolicy(policy, { principal, scopeId, action: 'execute', resource: { kind: 'operation', id: 'policy.administer' } }).decision === 'deny'
    || evaluatePolicy(policy, { principal, scopeId, action: 'decide', resource: { kind: 'approval', id: 'identity-profile' } }).decision !== 'allow') fail('IDENTITY_PREVIEW_SCOPE_DENIED');
}
/** Profile orchestration never writes documents: every effect and receipt belongs to policy.administer's existing C12/C11 path. */
export class IdentityProfileDistributionApplication {
  constructor(private readonly registry: IdentityProfileRegistry, private readonly source: IdentityDistributionSource,
    private readonly deps?: IdentityDistributionDependencies) {}
  async choices(scopeId: string) {
    const snapshot = await this.source.load([scopeId]);
    return { schemaVersion: 1 as const, profiles: this.registry.list(), principals: snapshot.principals,
      scopeIds: snapshot.projectScopeIds, bindings: snapshot.policy.schemaVersion === 2 ? snapshot.policy.bindings.entries : [] };
  }
  async preview(raw: unknown) {
    const parsed = identityDistributionSelectionSchema.safeParse(raw); if (!parsed.success) return fail('IDENTITY_PREVIEW_INVALID');
    const selection = parsed.data, scopes = [...new Set([selection.scopeId, ...selection.assignments.flatMap(item => item.scopeIds)])];
    const snapshot = await this.source.load(scopes), policy = policySchema.parse(snapshot.policy);
    admin(policy, snapshot.principal, selection.scopeId);
    if (policy.schemaVersion !== 2) return fail('IDENTITY_PREVIEW_UNAVAILABLE');
    const profile = this.registry.resolve(selection.profile);
    if (profile.definition.requires.length) return fail('IDENTITY_PREVIEW_UNAVAILABLE');
    const chosen = selection.assignments.map(item => snapshot.principals.find(choice => choice.id === item.principalId) ?? fail('IDENTITY_PREVIEW_INVALID'));
    const members = [...new Map(chosen.map(choice => [choice.id, choice])).values()].map(choice => ({
      id: `m-${sha256(choice.id).slice(0, 24)}`, principal: choice.principal, label: choice.label, kind: choice.kind,
    }));
    for (const id of selection.removeBindingIds) {
      const binding = policy.bindings.entries.find(item => item.id === id) ?? fail('IDENTITY_PREVIEW_INVALID');
      for (const ref of binding.principals) {
        const choice = snapshot.principals.find(item => equal(item.principal, ref)) ?? fail('IDENTITY_PREVIEW_SCOPE_DENIED');
        if (!members.some(member => equal(member.principal, ref))) members.push({ id: `m-${sha256(choice.id).slice(0, 24)}`, principal: ref, label: choice.label, kind: choice.kind });
      }
    }
    const assignments = selection.assignments.map((item, index) => {
      if (!profile.definition.roleTemplates.some(role => role.id === item.roleId)) return fail('IDENTITY_PREVIEW_INVALID');
      return { id: `ip-${sha256(encodeIdentityProfile({ profile: selection.profile, ...item })).slice(0, 24)}`,
        memberId: `m-${sha256(chosen[index]!.id).slice(0, 24)}`, roleId: item.roleId, scopeIds: item.scopeIds };
    });
    const preview = await new IdentityProfileApplication(this.registry, { load: async () => snapshot }).preview({ schemaVersion: 1, profile: selection.profile,
      scopeId: selection.scopeId, projectScopeIds: scopes, members, organization: [], assignments, removeBindingIds: selection.removeBindingIds });
    const changes = [...preview.draft.addedRoles.map(role => ({ kind: 'role.add' as const, role })),
      ...preview.draft.removedBindings.map(binding => ({ kind: 'binding.remove' as const, id: binding.id })),
      ...preview.draft.addedBindings.map(binding => ({ kind: 'binding.add' as const, binding }))];
    if (!changes.length) return fail('IDENTITY_PREVIEW_INVALID');
    const change = { schemaVersion: 2, changes, profile: { ...selection.profile, digest: profile.digest, registryDigest: this.registry.digest, previewDigest: preview.digest } };
    const files = authorityDocuments(policy), plan = planPolicyChange(files.policy, files.bindings, change);
    if (!delegationWithin(policy, snapshot.principal, plan.touched).ok) return fail('IDENTITY_PREVIEW_SCOPE_DENIED');
    const actor = { issuer: snapshot.principal.issuer, subject: snapshot.principal.subject };
    const commandId = sha256(encodeIdentityProfile({ kind: 'identity-distribution:1', actor, selection, change, revision: policy.revision }));
    const submission = identityDistributionSubmissionSchema.parse({ schemaVersion: 1, selection, registryDigest: this.registry.digest, previewDigest: preview.digest, actor,
      command: { schemaVersion: 1, commandId, scopeId: selection.scopeId, operation: POLICY_ADMINISTER_OPERATION.operation,
        target: { kind: AUTHORITY_DOCUMENT_TARGET_KIND, id: 'installation' }, idempotencyKey: commandId, input: change, expectedVersion: policy.revision } });
    return { schemaVersion: 1 as const, preview, submission, digest: sha256(encodeIdentityProfile(submission)) };
  }
  async validateSubmission(raw: unknown, expect: string) {
    const parsed = identityDistributionSubmissionSchema.safeParse(raw); if (!parsed.success) return fail('IDENTITY_PREVIEW_INVALID');
    const submission: IdentityDistributionSubmission = parsed.data;
    if (sha256(encodeIdentityProfile(submission)) !== expect) return fail('IDENTITY_PREVIEW_CONFLICT');
    const expectedId = sha256(encodeIdentityProfile({ kind: 'identity-distribution:1', actor: submission.actor, selection: submission.selection,
      change: submission.command.input, revision: submission.command.expectedVersion }));
    if (expectedId !== submission.command.commandId) return fail('IDENTITY_PREVIEW_CONFLICT');
    const snapshot = await this.source.load([submission.selection.scopeId]);
    admin(policySchema.parse(snapshot.policy), snapshot.principal, submission.selection.scopeId);
    if (!equal(submission.actor, { issuer: snapshot.principal.issuer, subject: snapshot.principal.subject })) return fail('IDENTITY_PREVIEW_SCOPE_DENIED');
    if (!this.deps) return fail('IDENTITY_PREVIEW_UNAVAILABLE');
    const previous = await this.deps.effects.loadEffect(submission.command.scopeId, submission.command.commandId);
    if (previous) {
      if (!equal(previous.intent.command, submission.command)) return fail('IDENTITY_PREVIEW_CONFLICT');
    } else {
      const fresh = await this.preview(submission.selection);
      if (!equal(fresh.submission, submission)) return fail('IDENTITY_PREVIEW_CONFLICT');
    }
    return submission.command;
  }
  async submit(raw: unknown, expect: string, credential?: unknown) {
    const command = await this.validateSubmission(raw, expect);
    // The caller must explicitly decide the exact pending card. No approval is manufactured here.
    return this.deps!.administration.submit(command, credential);
  }
  /** Called only after explicit human confirmation; the supplied decision port retains its session/SoD checks. */
  async applyConfirmed(raw: unknown, expect: string, approve: PersistentStandingDependencies['approve'], reason: string) {
    const command = await this.validateSubmission(raw, expect);
    let outcome = await this.submit(raw, expect);
    if (outcome.status === 'approval-pending') {
      await approve(outcome.approval, `${command.commandId}-approve`, reason);
      outcome = await this.submit(raw, expect);
    }
    return outcome;
  }
}
export type IdentityDistributionPreview = Awaited<ReturnType<IdentityProfileDistributionApplication['preview']>>;
