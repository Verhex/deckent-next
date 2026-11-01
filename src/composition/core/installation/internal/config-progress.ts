import { inspectInstallationFile, openLocalIntegrityAuthority, openReadOnlyAuditStore } from '#adapters/index.js';
import { AuditApplication, InstallationPublicationError, publishedConfigProgress, type PolicyTemplatePublishTarget } from '#engine/index.js';
import { dirname } from 'node:path';
import { inspectProductFile, type ProductLayout, type ResolvedConfig } from '#platform/index.js';

/** A committed journal retains the initial config; later governed writes retain their own sealed digest chain. */
export async function committedConfigTarget(target: PolicyTemplatePublishTarget, scopeId: string, layout: ProductLayout, config: ResolvedConfig, maxBytes: number) {
  if (target.resource !== 'config') return target;
  const current = await inspectInstallationFile({ root: dirname(target.path), path: target.path, maxBytes });
  if (current.digest === target.digest) return target;
  if (current.digest === null) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
  const store = await openReadOnlyAuditStore(await inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']), config.storage.sqlite);
  try {
    const audit = new AuditApplication(store, await openLocalIntegrityAuthority(layout, config.approvals.keyFile));
    if (!store.snapshot(false, () => publishedConfigProgress(audit, scopeId, target.digest, current.digest!, config.audit))) {
      throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
    }
    // Recheck these exact bytes through the original custody port; the retained journal/content never changes.
    return { ...target, digest: current.digest };
  } finally { store.close(); }
}
