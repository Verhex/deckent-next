import { loadConfig, prepareProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { GitWorkspaceBroker, type GitWorkspaceOptions } from '#adapters/index.js';

/** Host composition pins one layout snapshot; the broker receives no independently chosen data root. */
export async function openConfiguredWorkspaceBroker(projectRoot: string,
  execution: Omit<GitWorkspaceOptions, 'sourceRoot' | 'workspaceRoot'>, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const layout = config.productLayout;
  const path = await prepareProductDirectory(layout, 'workspaces');
  const broker = new GitWorkspaceBroker({ ...execution, sourceRoot: projectRoot, workspaceRoot: path });
  return Object.freeze({ broker, layout, path });
}
