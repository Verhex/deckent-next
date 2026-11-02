import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { attachmentFailure, assertAuthorityWitness, type ProjectAttachmentPorts } from '#engine/index.js';
import { FileProjectIdentityStore, FileInstallationIdentityStore, readInstallationFile } from '#adapters/core/installation-files/index.js';
import { readLocalOsIdentity, localPrincipalChannel, localPrincipalPeer, attestLocalInteractiveTerminal } from '#adapters/core/local-principal/index.js';
import { automationMarker, productResourcePath, type ResolvedConfig, type ConfigLoadOptions } from '#platform/index.js';
import { readAttachmentBootstrapConfig } from './bootstrap.js';
import { FileProjectAttachmentStore, captureAttachmentLocation } from './store.js';

/** Only metadata/bootstrap ports. Provider, policy and config mutation stay with their existing applications. */
export function localProjectAttachmentPorts(config: ResolvedConfig, options: ConfigLoadOptions, store: FileProjectAttachmentStore): Pick<ProjectAttachmentPorts, 'actor' | 'authorize' | 'target' | 'ensureProject'> {
  const root = config.projectRoot, { issuer, subject } = readLocalOsIdentity();
  return { actor: { issuer, subject },
    async authorize() {
      const env = options.env ?? process.env;
      await assertAuthorityWitness('project.attach', localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), { attest: async () =>
        !automationMarker(process.env, config.cli.agentEnvironment) && !automationMarker(env, config.cli.agentEnvironment) && await attestLocalInteractiveTerminal() });
      await FileInstallationIdentityStore.assertTransferAllowed();
    },
    async target() {
      const location = await captureAttachmentLocation(root), fresh = await readAttachmentBootstrapConfig(root, options);
      const project = await new FileProjectIdentityStore(root, config.configFile.writeLockTimeoutMs).read();
      const entry = (await store.registration())?.entries.find(item => item.attachment.location.canonicalRoot === location.canonicalRoot);
      const bytes = await Promise.all((['config', 'policy', 'bindings', 'projectAttachment'] as const).map(resource => {
        const path = productResourcePath(fresh.productLayout, resource);
        return readInstallationFile({ root: dirname(path), path, maxBytes: config.installation.profileMaxBytes });
      }));
      if (!entry && bytes.some(value => value !== null)) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
      if (await lstat(productResourcePath(fresh.productLayout, 'installationIdentity')).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
      return { location, projectId: project.status === 'available' ? project.value.projectId : null, companyId: fresh.company.id,
        configDigest: createHash('sha256').update(JSON.stringify([fresh.productLayout.revision, bytes])).digest('hex') };
    },
    async ensureProject(projectId) {
      const project = await new FileProjectIdentityStore(root, config.configFile.writeLockTimeoutMs, projectId).loadOrCreate();
      if (project.projectId !== projectId) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    },
  };
}
