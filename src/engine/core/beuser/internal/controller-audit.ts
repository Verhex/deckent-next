import type { ApprovalRecord, AuditRecord } from '#domain/index.js';
import { AUDIT_PAGE_MAX, type AuditApplication } from '#engine/core/audit/index.js';
import type { BeuserContext } from '#engine/core/beuser-contract/index.js';

export type BeuserControllerValidity = 'valid' | 'invalid' | 'unknown';
type Ports = { readonly audit: Pick<AuditApplication, 'list'>;
  readonly approvals: (afterId: string | null, limit: number) => readonly ApprovalRecord[] };
/** Controller A only. Verified pages and a shared byte/time bound; raw authority data never leaves the controller. */
async function snapshot(context: BeuserContext, ports: Ports) {
  const scopeId = context.binding.identity.scopeId, audit: AuditRecord[] = [], approvals: ApprovalRecord[] = [];
  let bytes = 0, sequence = 0;
  const bounded = (value: unknown) => { context.signal.throwIfAborted(); bytes += Buffer.byteLength(JSON.stringify(value));
    if (bytes > context.limits.maxArtifactBytes) throw new Error('BEUSER_LIMITS_UNAVAILABLE'); };
  while (true) {
    context.signal.throwIfAborted();
    const rows = ports.audit.list(scopeId, sequence, AUDIT_PAGE_MAX);
    for (const row of rows) { bounded(row); if (row.event.scopeId !== scopeId || row.sequence !== ++sequence) throw new Error('AUDIT_INTEGRITY'); audit.push(row); }
    if (rows.length < AUDIT_PAGE_MAX) break;
  }
  let afterId: string | null = null;
  while (true) {
    context.signal.throwIfAborted();
    const rows = ports.approvals(afterId, AUDIT_PAGE_MAX);
    for (const row of rows) { bounded(row); if (row.request.scopeId !== scopeId || afterId !== null && row.request.approvalId <= afterId) throw new Error('AUDIT_INTEGRITY');
      afterId = row.request.approvalId; approvals.push(row); }
    if (rows.length < AUDIT_PAGE_MAX) break;
  }
  return { audit, approvals, sequence };
}
export async function readBeuserControllerAudit(context: BeuserContext, ports: Ports): Promise<BeuserControllerValidity> {
  const principal = context.principal;
  const attributed = (actor: { readonly issuer: string; readonly subject: string } | null) => actor?.issuer === principal.issuer && actor.subject === principal.subject;
  const forbidden = ({ event }: AuditRecord) => {
    const subject = event.subject;
    if (subject.kind === 'authority-change') return attributed(event.principal) || 'decider' in subject && attributed(subject.decider)
      || 'installer' in subject && 'person' in subject.installer && attributed(subject.installer.person);
    if (subject.kind === 'authority-decision') return attributed(subject.envelope.principalRef)
      && subject.resource.kind === 'approval' && subject.action === 'decide' && subject.verdict.decision === 'allow';
    if (subject.kind === 'permission-mode-change') return attributed(event.principal) && subject.bindingsRevision.after !== null;
    if (subject.kind === 'permission-mode-session') return attributed(event.principal) && subject.decision.effect === 'allow';
    if (subject.kind === 'config-change') return attributed(event.principal) && subject.approvalId !== undefined;
    return subject.kind === 'standing-approval' && attributed(event.principal)
      || subject.kind === 'sandbox-write-approved' && attributed(event.principal);
  };
  try {
    const rows = await snapshot(context, ports);
    if (rows.audit.some(row => forbidden(row))
      || rows.approvals.some(row => row.decision && attributed(row.decision.actor))) return 'invalid';
    return 'valid';
  } catch { return 'unknown'; }
}
