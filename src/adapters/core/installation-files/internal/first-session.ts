import { readableProjectAttachmentSchema, isNewAttachment, isNewerAttachmentVersion, type ReadableProjectAttachment as ProjectAttachment } from '#domain/index.js';
 import { lstat } from 'node:fs/promises'; import { dirname } from 'node:path';
import { inspectInstallationFile, publishInstallationFile, readInstallationFile } from './publication.js';
import { openSqliteLedger, openSqliteLedgerReadOnly, requireLedgerVersion, CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { InstallationPublicationError, type PolicyTemplatePublishTarget } from '#engine/index.js';
import { CodedError, sha256 as digest, getConfigFieldDefault, inspectProductFile, prepareProductFile, productDataRootIgnorePath, productResourcePath, PRODUCT_DATA_ROOT_IGNORE as IGNORE, validateConfig, type ProductLayout } from '#platform/index.js';
/** First-session material is data in the existing installer journal, never a second config writer or migration; v12: it names `service.identity`; G2-1: the data root's ignore rule when that name is free. */
export async function firstSessionTargets(layout: ProductLayout, scopeId: string, maxBytes: number, retained?: unknown, service: { readonly scopeId: string; readonly serviceId: string } | null = null, attachment?: ProjectAttachment): Promise<readonly PolicyTemplatePublishTarget[]> {
  if (retained !== undefined) {
    if (!Array.isArray(retained)) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
    const targets = retained as PolicyTemplatePublishTarget[];
    if (targets.some(target => !target || typeof target !== 'object' || !['config', 'ledger', 'gitignore', 'projectAttachment'].includes(target.resource) || target.path !== (target.resource === 'gitignore' ? productDataRootIgnorePath(layout)
      : productResourcePath(layout, target.resource as 'config' | 'ledger' | 'projectAttachment')) || typeof target.content !== 'string' || target.digest !== digest(target.content) || (target.resource === 'gitignore' && target.content !== IGNORE))) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
    for (const target of targets.filter(item => item.resource !== 'gitignore')) {
      const material: unknown = target.resource === 'projectAttachment' ? readAttachmentText(target.content) : JSON.parse(target.content);
      if (target.resource === 'config') validateConfig(material);
      else if (target.resource === 'projectAttachment') { if (JSON.stringify(readAttachmentReference(material)) !== JSON.stringify(attachment)) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID'); }
      else if (JSON.stringify(material) !== JSON.stringify({ schemaVersion: 1, ledgerVersion: CURRENT_LEDGER_VERSION })) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
    }
    return targets;
  }
  const retainedReference = await readInstallationFile({ root: dirname(productResourcePath(layout, 'projectAttachment')),
    path: productResourcePath(layout, 'projectAttachment'), maxBytes });
  if (retainedReference !== null) {
    if (isNewAttachment(readAttachmentText(retainedReference))) newerAttachmentRecord();
  }
  const ignore = productDataRootIgnorePath(layout), targets: PolicyTemplatePublishTarget[] = await lstat(ignore).then(() => [], (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID'); return [Object.freeze({ resource: 'gitignore' as const, path: ignore, content: IGNORE, digest: digest(IGNORE) })]; }); // an existing entry is never written over
  const config = { schema_version: attachment ? 6 : 4, ...(attachment ? { installation: { sharedRegistrationId: attachment.registrationId }, company: { id: attachment.companyId } } : {}), cancellation: { maxConcurrentDeliveries: getConfigFieldDefault('service').maxConcurrentExecutions },
    cancellationRuntime: { scopeIds: [scopeId] }, terminal: { scopeId, chat: { schemaVersion: 1 } }, ...(service ? { service: { identity: { scopeId: service.scopeId, serviceId: service.serviceId } } } : {}) };
  validateConfig(config);
  for (const resource of ['ledger', 'config'] as const) {
    const path = productResourcePath(layout, resource);
    if ((await inspectInstallationFile({ root: resource === 'config' ? dirname(path) : layout.root, path, maxBytes })).digest !== null) continue; // config: the bootstrap path, outside a moved root
    const content = JSON.stringify(resource === 'config' ? config : { schemaVersion: 1, ledgerVersion: CURRENT_LEDGER_VERSION }) + '\n';
    targets.push(Object.freeze({ resource, path, content, digest: digest(content) }));
  }
  if (isNewerAttachmentVersion(attachment, 2) || isNewAttachment(attachment)) newerAttachmentRecord();
  if (attachment) { const content = JSON.stringify(attachment) + '\n'; targets.push({ resource: 'projectAttachment', path: productResourcePath(layout, 'projectAttachment'), content, digest: digest(content) }); }
  return Object.freeze(targets);
}

export function firstSessionPublication(layout: ProductLayout, maxBytes: number) {
  return {
    async publish(target: PolicyTemplatePublishTarget, transactionId: string) {
      if (target.resource === 'projectAttachment') {
        if (isNewAttachment(readAttachmentText(target.content))) newerAttachmentRecord();
        const retained = await readInstallationFile({ root: dirname(target.path), path: target.path, maxBytes });
        if (retained !== null && isNewAttachment(readAttachmentText(retained))) newerAttachmentRecord();
      }
      if (target.resource === 'ledger') {
        // Managed-file custody creates the empty private file; the existing SQLite owner performs the migration.
        const path = await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
        const db = openSqliteLedger(path, getConfigFieldDefault('storage').sqlite, 'allow');
        db.close();
      } else await publishInstallationFile({ root: dirname(target.path), path: target.path, maxBytes, transactionId }, target.content);
    },
    async verify(target: PolicyTemplatePublishTarget) {
      if (target.resource === 'ledger') {
        const path = await inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
        const db = openSqliteLedgerReadOnly(path, getConfigFieldDefault('storage').sqlite);
        try { requireLedgerVersion(db, CURRENT_LEDGER_VERSION); } finally { db.close(); }
      } else if ((await inspectInstallationFile({ root: dirname(target.path), path: target.path, maxBytes })).digest !== target.digest) {
        throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
      }
    },
  };
}

function newerAttachmentRecord(): never { throw new CodedError('PROJECT_ATTACHMENT_NEWER_RECORD'); }

function readAttachmentReference(value: unknown) {
  if (isNewerAttachmentVersion(value, 2)) newerAttachmentRecord();
  const parsed = readableProjectAttachmentSchema.safeParse(value);
  if (!parsed.success) throw new CodedError('PROJECT_ATTACHMENT_INVALID');
  return parsed.data;
}

function readAttachmentText(text: string) {
  let value: unknown; try { value = JSON.parse(text); } catch { throw new CodedError('PROJECT_ATTACHMENT_INVALID'); }
  return readAttachmentReference(value);
}
