import { createHash } from 'node:crypto';
import { inspectInstallationFile, publishInstallationFile } from './publication.js';
import { openSqliteLedger, openSqliteLedgerReadOnly, requireLedgerVersion, CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { InstallationPublicationError, type PolicyTemplatePublishTarget } from '#engine/index.js';
import { getConfigFieldDefault, inspectProductFile, prepareProductFile, productResourcePath, validateConfig, type ProductLayout } from '#platform/index.js';
const digest = (content: string) => createHash('sha256').update(content).digest('hex');
/** First-session material is data in the existing installer journal, never a second config writer or migration. */
export async function firstSessionTargets(layout: ProductLayout, scopeId: string, maxBytes: number, retained?: unknown): Promise<readonly PolicyTemplatePublishTarget[]> {
  if (retained !== undefined) {
    if (!Array.isArray(retained)) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
    const targets = retained as PolicyTemplatePublishTarget[];
    if (targets.some(target => !target || typeof target !== 'object' || !['config', 'ledger'].includes(target.resource) || target.path !== productResourcePath(layout, target.resource as 'config' | 'ledger')
      || typeof target.content !== 'string' || target.digest !== digest(target.content))) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
    for (const target of targets) {
      const material: unknown = JSON.parse(target.content);
      if (target.resource === 'config') validateConfig(material);
      else if (JSON.stringify(material) !== JSON.stringify({ schemaVersion: 1, ledgerVersion: CURRENT_LEDGER_VERSION })) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
    }
    return targets;
  }
  const targets: PolicyTemplatePublishTarget[] = [];
  const config = { schema_version: 4, cancellation: { maxConcurrentDeliveries: getConfigFieldDefault('service').maxConcurrentExecutions },
    cancellationRuntime: { scopeIds: [scopeId] }, terminal: { scopeId, chat: { schemaVersion: 1 } } };
  validateConfig(config);
  for (const resource of ['ledger', 'config'] as const) {
    const path = productResourcePath(layout, resource);
    if ((await inspectInstallationFile({ root: layout.root, path, maxBytes })).digest !== null) continue;
    const content = JSON.stringify(resource === 'config' ? config : { schemaVersion: 1, ledgerVersion: CURRENT_LEDGER_VERSION }) + '\n';
    targets.push(Object.freeze({ resource, path, content, digest: digest(content) }));
  }
  return Object.freeze(targets);
}

export function firstSessionPublication(layout: ProductLayout, maxBytes: number) {
  return {
    async publish(target: PolicyTemplatePublishTarget, transactionId: string) {
      if (target.resource === 'ledger') {
        // Managed-file custody creates the empty private file; the existing SQLite owner performs the migration.
        const path = await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
        const db = openSqliteLedger(path, getConfigFieldDefault('storage').sqlite, 'allow');
        db.close();
      } else await publishInstallationFile({ root: layout.root, path: target.path, maxBytes, transactionId }, target.content);
    },
    async verify(target: PolicyTemplatePublishTarget) {
      if (target.resource === 'ledger') {
        const path = await inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
        const db = openSqliteLedgerReadOnly(path, getConfigFieldDefault('storage').sqlite);
        try { requireLedgerVersion(db, CURRENT_LEDGER_VERSION); } finally { db.close(); }
      } else if ((await inspectInstallationFile({ root: layout.root, path: target.path, maxBytes })).digest !== target.digest) {
        throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
      }
    },
  };
}
