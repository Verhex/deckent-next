import { lstat } from 'node:fs/promises';
import { attachmentFailure, ProjectAttachmentRelocationApplication, type ProjectAttachmentPorts } from '#engine/index.js';
import { FileInstallationIdentityStore, FileProjectIdentityStore } from '#adapters/core/installation-files/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { FileProjectAttachmentStore, captureAttachmentLocation } from './store.js';
import { localProjectAttachmentPorts } from './local.js';
import { readAttachmentBootstrapConfig } from './bootstrap.js';
import { relocateProjectAttachment } from './relocate.js';
export async function relocateInstallationProjectReference(root: string, scopeId: string, options: ConfigLoadOptions, source: ProjectAttachmentPorts['source'], witnessed = false) {
  const config = await readAttachmentBootstrapConfig(root, options), store = new FileProjectAttachmentStore(config.productLayout, options, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs);
  const local = localProjectAttachmentPorts(config, options, store);
  return new ProjectAttachmentRelocationApplication({ config, store, actor: local.actor, authorize: local.authorize, source,
    location: () => captureAttachmentLocation(root), projectId: async () => { const project = await new FileProjectIdentityStore(root, config.configFile.writeLockTimeoutMs).read(); return project.status === 'available' ? project.value.projectId : null; },
    exists: path => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; }),
    publish: (before, after, settle) => relocateProjectAttachment(config, before, after, settle),
    async keepIdentity() { const identity = new FileInstallationIdentityStore(config.productLayout, config.configFile.writeLockTimeoutMs, undefined, config.installation);
      try { const current = await identity.read(); if (current.status !== 'available') return attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE'); return current.value.installationId; }
      catch (error) { if ((error as { code?: string }).code !== 'INSTALLATION_IDENTITY_RELOCATED') throw error; return (await identity.resolveRelocation('keep', local.actor)).installationId; } },
  }).apply(scopeId, witnessed);
}
