import { createHash } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, ModelCatalogError, policyResources,
  type AuditRecord, type ModelActivationCommand, type ModelCatalogCommand } from '#domain/index.js';
import { openReadOnlyAuditStore, openSqliteModelActivationReader, openSqliteModelCatalogReader } from '#adapters/index.js';
import { activationReceiptRead, ModelActivationPolicyAuthorization, ModelCatalogPolicyAuthorization, modelCatalogTargetId, catalogChildCommandId,
  readCatalogCascadeReceipts, type ModelCatalogChannelView, type ModelCatalogResult } from '#engine/index.js';
import { withScopeAudit } from '#composition/core/scoped-request/index.js';
import type { ActivationAuthority } from './activation-authority.js';

type Command = Exclude<ModelCatalogCommand, { action: 'register' }>;
type Context = Awaited<ReturnType<ActivationAuthority['write']>>;
type Child = ModelActivationCommand | Command;
type Channel = Extract<ModelCatalogChannelView, { access: 'allowed' }>;
export const activationReceiptOptions = (context: Context) => ({ busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs, [activationReceiptRead]: true as const });

function digest(tag: string, value: unknown): string {
  return createHash('sha256').update(JSON.stringify([tag, value])).digest('hex');
}

export function catalogEvidence(context: Context, authority: ActivationAuthority, command: Command) {
  const { scopeId, commandId, action, channelId, modelId, expectedRevision } = command;
  const { id, issuer, subject } = context.principal, principalRef = { id, issuer, subject };
  const idempotencyKeyHash = digest('catalog-cascade-id:1', commandId);
  const eventId = `catalog-cascade-${idempotencyKeyHash}`;
  const inputDigest = digest('catalog-cascade-input:1', { command, principalRef, assurance: context.principal.assurance });
  const basisDigest = (children: readonly Child[]) =>
    digest('catalog-cascade-children:1', [...children].sort((a, b) => a.commandId.localeCompare(b.commandId)));
  const read = async () => {
    // Historical parent receipts predate cascade evidence, and may predate the audit key too.
    const store = await openReadOnlyAuditStore(await context.path(), context.config.storage.sqlite);
    try { if (!store.load!(scopeId, eventId)) return null; } finally { store.close(); }
    return withScopeAudit(context, audit => verify(audit.load(scopeId, eventId)), false, 'read');
  };
  const verify = (row: AuditRecord | null) => {
    const record = row?.event.subject;
    if (!record || record.kind !== 'authority-decision' || record.inputDigest !== inputDigest)
      throw new ModelCatalogError('MODEL_CATALOG_COMMAND_CONFLICT');
    return record.basisDigest;
  };
  return {
    read, child: (id: string, stage: Parameters<typeof catalogChildCommandId>[2]) => catalogChildCommandId(commandId, id, stage),
    async settled(parent: ModelCatalogResult, channel: Channel) {
      const path = await context.path(), options = activationReceiptOptions(context), chat = await openSqliteModelActivationReader(path, options);
      try {
        const catalog = action === 'activate' ? await openSqliteModelCatalogReader(path, options) : null;
        try {
          const children = await readCatalogCascadeReceipts(command, parent.receipt.actor, channel.models.map(row => row.modelId),
            async id => catalog?.loadReceipt!(scopeId, id) ?? null, id => chat.loadReceipt!(scopeId, id));
          const source = { async load() { return context.document; } };
          for (const child of children) {
            if ('reference' in child) await new ModelActivationPolicyAuthorization(source).authorize('inspect', child, context.principal);
            else await new ModelCatalogPolicyAuthorization(source).authorize('inspect', scopeId,
              { channelId: child.channelId, modelId: child.modelId }, context.principal, 'scope');
          }
          return children;
        } finally { catalog?.close(); }
      } finally { chat.close(); }
    },
    matches(basis: string, children: readonly Child[]) { return basis === basisDigest(children); },
    async record(children: readonly Child[]) {
      const basis = basisDigest(children);
      const existing = await read();
      if (existing !== null) {
        if (existing !== basis) throw new ModelCatalogError('MODEL_CATALOG_REVISION_CONFLICT');
        return;
      }
      const resource = { kind: policyResources.modelActivation.kind, id: modelCatalogTargetId({ channelId, modelId }) };
      const authorization = await new ModelCatalogPolicyAuthorization({ async load() { return context.document; } })
        .authorize(action, scopeId, { channelId, modelId }, context.principal, 'scope');
      await withScopeAudit(await authority.write(), audit => {
        const kept = audit.load(scopeId, eventId);
        if (kept) {
          if (verify(kept) !== basis) throw new ModelCatalogError('MODEL_CATALOG_REVISION_CONFLICT');
          return;
        }
        audit.record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId, scopeId, principal: { issuer, subject }, atMs: Date.now(),
          policyRevision: authorization.revision, subject: { kind: 'authority-decision', schemaVersion: 1,
            envelope: { schemaVersion: 1, commandId, scopeId, principalRef, expectedRevision, idempotencyKeyHash },
            action, resource, inputDigest, basisDigest: basis, policyDigest: digest('policy:1', context.document),
            verdict: { decision: 'allow', revision: authorization.revision, reason: 'GRANTED', ruleId: authorization.ruleId } } });
      });
    },
  };
}
