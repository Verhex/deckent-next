import { inspectProductLayout } from '#platform/core/host/index.js';
import { loadConfig, type ConfigLoadOptions } from './layers.js';

/** Read-only shared CLI/SDK query of the configured layout, with no config healing or relocation. */
export async function inspectProductPaths(projectRoot?: string, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  return inspectProductLayout(config.productLayout);
}
