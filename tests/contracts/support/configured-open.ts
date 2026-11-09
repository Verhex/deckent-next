import { loadConfig, prepareProductDirectory, prepareProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { FileArtifactStore, GitWorkspaceBroker, openSqliteAttemptStore, resolveGitWorkTarget, validateExecutionSupervisorProfile, type GitWorkspaceOptions } from '#adapters/index.js';

/** Test opener. The configured adapter is chosen here; application and domain never branch on database brand.
 * No command ingress is exposed: the caller still supplies a verified principal and policy to the application.
 * Fixed to the allow migration posture (production opens use forbid).
 */
export async function openConfiguredAttemptStore(projectRoot: string, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const layout = config.productLayout;
  const path = await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
  const store = await openSqliteAttemptStore(path, config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'allow', { validate: validateExecutionSupervisorProfile });
  return Object.freeze({ store, layout, path });
}

export async function openConfiguredArtifactStore(projectRoot: string, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const layout = config.productLayout;
  const path = await prepareProductDirectory(layout, 'artifacts');
  const store = new FileArtifactStore({ root: path, maxBytes: config.artifacts.maxBytes });
  return Object.freeze({ store, layout, path });
}

/** Pins one layout snapshot; the broker receives no independently chosen data root. */
export async function openConfiguredWorkspaceBroker(projectRoot: string,
  execution: Omit<GitWorkspaceOptions, 'sourceRoot' | 'workspaceRoot'>, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const layout = config.productLayout;
  const path = await prepareProductDirectory(layout, 'workspaces');
  const broker = new GitWorkspaceBroker({ ...execution, ...(await resolveGitWorkTarget(projectRoot, config.execution && { ...config.execution, git: execution }, layout)).git, workspaceRoot: path });
  return Object.freeze({ broker, layout, path });
}
