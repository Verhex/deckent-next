import type { AttemptWorkspaceCustody } from '#engine/index.js';
import { GitWorkspaceBroker, type GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { recordedDockerSupervisor, dockerProfileObservesWorker } from '#adapters/core/docker-supervisor/index.js';
/** EXEC-RELEASE: the Docker + Git custody the release application drives. Supervisors come from each record's persisted profile; the
 * clone broker uses the execution's own Git options (trusted composition only). */
export function gitDockerAttemptCustody(options: GitWorkspaceOptions) {
  const broker = new GitWorkspaceBroker(options);
  const workspaces: AttemptWorkspaceCustody = Object.freeze({ releaseAttempt: broker.releaseAttempt.bind(broker), holds: broker.holds.bind(broker),
    countDetached: broker.countDetached.bind(broker) });
  return Object.freeze({ supervisor: recordedDockerSupervisor, observed: dockerProfileObservesWorker, workspaces });
}
