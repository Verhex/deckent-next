import { relocateInstallationProjectReference } from '#adapters/index.js';
import { inspectConfiguredInstallationSource } from '#composition/core/scoped-request/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
export const relocateConfiguredProjectAttachment = (root: string, scopeId: string, options: ConfigLoadOptions = {}, witnessed = false) =>
  relocateInstallationProjectReference(root, scopeId, options, (path, scope, actor, locked) => inspectConfiguredInstallationSource(path, scope, actor, options, locked), witnessed);
