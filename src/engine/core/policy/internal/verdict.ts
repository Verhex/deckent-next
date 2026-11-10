import type { DelegationVerdict, PolicyDecision } from '#domain/index.js';
/** C12 Q8: outside the operation catalog there is no approval broker yet; require-approval must not silently collapse into denial. The refusal code
 * of a non-allow verdict or delegation reason: `POLICY_APPROVAL_UNSUPPORTED` for require-approval, the caller's own `deny` code otherwise
 * (`deny`, `no-grant`, `mode-eligible`); null = allowed. */
export function policyVerdictRefusal<D extends string>(verdict: PolicyDecision['decision'] | Extract<DelegationVerdict, { ok: false }>['reason'], options: { readonly deny: D }): D | 'POLICY_APPROVAL_UNSUPPORTED' | null {
  return verdict === 'allow' ? null : verdict === 'require-approval' ? 'POLICY_APPROVAL_UNSUPPORTED' : options.deny;
}
