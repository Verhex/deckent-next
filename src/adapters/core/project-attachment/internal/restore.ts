import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifySharedAttachmentRestore } from '#engine/index.js';
import { FileProjectIdentityStore } from '#adapters/core/installation-files/index.js';
import { readLocalOsIdentity } from '#adapters/core/local-principal/index.js';
import type { VerifiedBackup } from '#adapters/core/backup-store/index.js';
import type { ConfigLoadOptions, ResolvedConfig } from '#platform/index.js';
import { FileProjectAttachmentStore } from './store.js';
export const verifySharedProjectRestore = (config: ResolvedConfig, backup: VerifiedBackup, target: string, scopeId: string, options: ConfigLoadOptions) =>
  verifySharedAttachmentRestore(config, backup.state, resolve(target), scopeId, { actor: readLocalOsIdentity(),
    registration: () => new FileProjectAttachmentStore(config.productLayout, options, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs).registration(),
    exists: path => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; }),
    projectId: async path => { const project = await new FileProjectIdentityStore(path, config.configFile.writeLockTimeoutMs).read(); return project.status === 'available' ? project.value.projectId : null; } });
