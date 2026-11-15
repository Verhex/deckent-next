import type { AuditEvent } from './contract.js';
/** A boundary refusal and a policy allow describe the same observed call, never two competing final verdicts. */
export function auditRefusalMatchesPolicy(refusal: AuditEvent, policy: AuditEvent): boolean {
  const boundary = refusal.subject, allowed = policy.subject;
  if (boundary.kind !== 'access-refusal-summary' || allowed.kind !== 'policy-turn' || refusal.scopeId !== policy.scopeId
    || refusal.principal.issuer !== policy.principal.issuer || refusal.principal.subject !== policy.principal.subject) return false;
  const calls = boundary.call ? [boundary.call, ...boundary.samples] : boundary.samples;
  return calls.some(call => call.turnId === allowed.turnId && allowed.allowed.calls.some(entry => entry.call.callId === call.callId
    && entry.call.round === call.round && entry.call.index === call.index));
}
