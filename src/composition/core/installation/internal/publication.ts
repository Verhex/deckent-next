import { dirname } from 'node:path';
import { inspectInstallationFile, publishInstallationFile, initializeInstallationLedger, verifyInstallationLedger } from '#adapters/index.js';
import { InstallationPublicationError, type PreparedInstallation, type InstallationPublishTarget } from '#engine/index.js';
import { validateConfig, versionedConfig, resolveProductLayout, inspectProductFile, ManagedFileError,
  getConfigFieldDefault } from '#platform/index.js';

/** Concrete publication ports. The application, not this wiring, decides ordering and commit. */
export function installationPublicationPorts(projectRoot: string, prepared: PreparedInstallation) {
  const config = validateConfig(versionedConfig(prepared.material.configuration)).config;
  const host = getConfigFieldDefault('installation');
  const maxBytes = Math.min(config.installation.profileMaxBytes, host.profileMaxBytes);
  const file = (target: InstallationPublishTarget) => ({ root: target.resource === 'config'
    ? dirname(prepared.material.layout.bootstrapConfigPath) : prepared.material.layout.root,
    path: target.path, maxBytes: target.resource === 'policy' ? Math.min(maxBytes, config.inspection.policyMaxBytes) : maxBytes });
  const layout = resolveProductLayout({ projectRoot,
    bootstrapConfigPath: prepared.material.layout.bootstrapConfigPath, root: prepared.material.layout.root, resources: config.layout.resources });
  async function ledgerPath(target: InstallationPublishTarget, transactionId: string, create: boolean) {
    try { return await inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']); }
    catch (error) {
      if (!create || !(error instanceof ManagedFileError) || error.code !== 'MANAGED_FILE_MISSING') throw error;
      await publishInstallationFile({ ...file(target), transactionId }, '');
      return inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
    }
  }
  const ledger = (target: InstallationPublishTarget) => JSON.parse(target.content) as { ownership: unknown; pool: unknown };
  return {
    async inspectPreimage(target: InstallationPublishTarget) { return (await inspectInstallationFile(file(target))).digest; },
    async publish(target: InstallationPublishTarget, transactionId: string) {
      if (target.resource === 'ledger') {
        const material = ledger(target);
        await initializeInstallationLedger(await ledgerPath(target, transactionId, true), config.storage.sqlite, material.ownership, material.pool);
      } else {
        const published = await publishInstallationFile({ ...file(target), transactionId }, target.content);
        if (published.digest !== target.digest) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
      }
    },
    async verify(target: InstallationPublishTarget, transactionId: string) {
      if (target.resource === 'ledger') {
        const material = ledger(target);
        await verifyInstallationLedger(await ledgerPath(target, transactionId, false), material.ownership, material.pool);
      } else if ((await inspectInstallationFile(file(target))).digest !== target.digest) {
        throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
      }
    },
  };
}
