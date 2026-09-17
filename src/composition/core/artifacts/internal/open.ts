import { loadConfig, prepareProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { FileArtifactStore } from '#adapters/index.js';
export async function openConfiguredArtifactStore(projectRoot: string, maxBytes: number, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const layout = config.productLayout;
  const path = await prepareProductDirectory(layout, 'artifacts');
  const store = new FileArtifactStore({ root: path, maxBytes });
  return Object.freeze({ store, layout, path });
}
