import { createHash, randomUUID } from 'node:crypto';
import { SystemTrustedClock } from '#platform/index.js';
import { AuditError } from '#domain/index.js';
import { AuditApplication, projectModelIngressField, type ModelIngressProjection } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteAuditStore } from '#adapters/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
/** Authenticated MCP scope audit; missing scope refuses without claiming a receipt. */
export async function recordConfiguredMcpIngress(root: string, notice: ModelIngressProjection, input: unknown): Promise<void> {
  if (notice.disposition === 'unchanged') return;
  const scopeId = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>)['scopeId'] : undefined;
  if (typeof scopeId !== 'string' || !scopeId || projectModelIngressField(scopeId).disposition !== 'unchanged') throw new AuditError('AUDIT_UNAVAILABLE');
  const context = await loadConfiguredScopeContext(root, scopeId, { heal: false }, 'read'), store = await openSqliteAuditStore(await context.path(), context.config.storage.sqlite, 'forbid');
  try {
    const audit = new AuditApplication(store, await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true));
    audit.record({ schemaVersion: 1, eventId: createHash('sha256').update(`model-ingress:mcp:1\0${randomUUID()}`).digest('hex'), scopeId,
      principal: { issuer: context.principal.issuer, subject: context.principal.subject }, policyRevision: context.document.revision, atMs: new SystemTrustedClock().sample().wallMs,
      subject: { kind: 'model-ingress', fieldDigest: notice.fieldDigest, projectedDigest: notice.projectedDigest, decodedDigest: notice.decodedDigest,
        codePoints: notice.codePoints, disposition: notice.disposition } });
  } finally { store.close(); }
}
