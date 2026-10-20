import { userInfo } from 'node:os';
import { existsSync } from 'node:fs';
import { loadConfig, prepareProductDirectory, productResourcePath, type ConfigLoadOptions } from '#platform/index.js';
import { DockerSupervisor } from '#adapters/index.js';
/** REVISE 2691: the service-start consumer of environment probes. No probe is live at a start, so every labelled probe container of this
 * installation (workspace root) is removed and observed absent; unproven ones are returned, never assumed gone. Null without execution
 * or before any workspace exists. */
export async function releaseConfiguredPreflightProbes(projectRoot: string, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false }), os = userInfo();
  // No workspaces directory: no probe ever ran here, and a start never creates it (the refresh gate precedes every write).
  if (!config.execution || os.uid <= 0 || os.gid < 0 || !existsSync(productResourcePath(config.productLayout, 'workspaces'))) return null;
  const workspaceRoot = await prepareProductDirectory(config.productLayout, 'workspaces');
  return new DockerSupervisor({ ...config.execution.docker, workspaceRoot, uid: os.uid, gid: os.gid }).releasePreflightProbes();
}
