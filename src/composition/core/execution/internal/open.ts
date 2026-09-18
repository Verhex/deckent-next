import { userInfo } from 'node:os';
import { loadConfig, prepareProductDirectory, prepareProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { DockerSupervisor, validateDockerSupervisorProfile, GitWorkspaceBroker, FileArtifactStore, openSqliteAttemptStore } from '#adapters/index.js';
/** Single config/layout snapshot. The caller must authorize the source repository and install identity/policy
 * before admitting commands; these adapters alone never grant execution permission. */
export async function openConfiguredExecution(projectRoot: string, sourceRoot: string, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  if (!config.execution) throw new Error('EXECUTION_NOT_CONFIGURED');
  const layout = config.productLayout; const os = userInfo();
  if (os.uid <= 0 || os.gid < 0) throw new Error('EXECUTION_HOST_UNSUPPORTED');
  const workspaceRoot = await prepareProductDirectory(layout, 'workspaces');
  const artifactRoot = await prepareProductDirectory(layout, 'artifacts');
  const ledger = await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
  const supervisor = new DockerSupervisor({ ...config.execution.docker, workspaceRoot, uid: os.uid, gid: os.gid });
  const workspaces = new GitWorkspaceBroker({ ...config.execution.git, sourceRoot, workspaceRoot });
  const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: config.artifacts.maxBytes });
  const store = await openSqliteAttemptStore(ledger, config.storage.sqlite, 'allow', { validate: validateDockerSupervisorProfile });
  return Object.freeze({ layout, supervisor, workspaces, artifacts, store });
}
