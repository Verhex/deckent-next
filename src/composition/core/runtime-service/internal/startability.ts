import { inspectInstallationStartabilityFiles } from '#adapters/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
export async function inspectInstallationStartability(root: string, options: ConfigLoadOptions = {}) {
  return inspectInstallationStartabilityFiles(await loadComposedConfig(root, { ...options, heal: false }), options);
}
