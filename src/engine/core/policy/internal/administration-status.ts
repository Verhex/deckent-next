import { z } from 'zod';
import { evaluatePolicy, identitySchema, matchFirstRunPolicyTemplate, policySchema, usablePolicyAdmins, type AdministrationAssurance, type VerifiedPrincipal } from '#domain/index.js';
import type { PolicySource } from './authorize.js';
import { PolicyAuthorizationError } from './authorize.js';

export const policyAdministrationQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema }).strict().readonly();
export type PolicyAdministrationQuery = z.infer<typeof policyAdministrationQuerySchema>;
export interface PolicyAdministrationStatus {
  readonly schemaVersion: 1; readonly scopeId: string; readonly revision: string;
  readonly admins: readonly { readonly issuer: string; readonly subject: string }[]; readonly usableAdminCount: number;
  readonly template: { readonly kind: 'first-run' | 'hand-built' | 'drift'; readonly version: number | null; readonly recognition: 'revision-only' };
  readonly bootstrapRequired: boolean; readonly recoveryRequired: boolean;
  /** Policy capability is exact; external identity activity, terminal presence and custody were not verified. */
  readonly identityReadiness: 'not-verified';
}
/** Shared observation only: scope inspectors or a usable administrator. No directory, ledger, healing, audit write or authority publication. */
export class PolicyAdministrationInspection {
  constructor(private readonly source: PolicySource, private readonly assurance?: AdministrationAssurance) {}
  async inspect(principal: VerifiedPrincipal, input: unknown): Promise<PolicyAdministrationStatus> {
    const query = policyAdministrationQuerySchema.parse(input), policy = policySchema.parse(await this.source.load());
    const admins = usablePolicyAdmins(policy, query.scopeId, this.assurance);
    const own = principal.scopeIds.includes(query.scopeId) && admins.some(ref => ref.issuer === principal.issuer && ref.subject === principal.subject);
    if (!own && evaluatePolicy(policy, { principal, scopeId: query.scopeId, action: 'inspect', resource: { kind: 'scope', id: query.scopeId } }).decision !== 'allow') {
      throw new PolicyAuthorizationError('POLICY_DENIED');
    }
    const revision = policy.schemaVersion === 2 ? policy.policyRevision : policy.revision;
    const template = matchFirstRunPolicyTemplate(revision);
    const anchored = policy.grants.some(rule => rule.id === 'first-run-read-tools');
    const administered = policy.schemaVersion === 2 && (policy.policyRevision.startsWith('a-') || policy.bindings.revision.startsWith('a-'));
    return Object.freeze({ schemaVersion: 1, scopeId: query.scopeId, revision: policy.revision, admins, usableAdminCount: admins.length,
      template: Object.freeze({ kind: template ? 'first-run' : anchored ? 'drift' : 'hand-built', version: template?.version ?? null, recognition: 'revision-only' }),
      bootstrapRequired: admins.length === 0 && !administered, recoveryRequired: admins.length === 0 && administered, identityReadiness: 'not-verified' });
  }
}
