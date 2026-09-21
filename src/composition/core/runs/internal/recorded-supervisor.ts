import { DockerSupervisor } from '#adapters/index.js';
import { supervisorProfileSchema, type ExecutionSupervisor, type SupervisorProfileSource, type SupervisorProfile } from '#engine/index.js';

/** Management uses private persisted custody, not mutable execution configuration.
 * Restore is lazy so denied, prevented or already-terminal operations never contact the daemon.
 * Docker is the currently installed execution adapter; its restore rejects unknown adapter/version.
 */
export function recordedSupervisor(input: SupervisorProfile): ExecutionSupervisor & SupervisorProfileSource {
  const profile = supervisorProfileSchema.parse(input);
  let restored: Promise<DockerSupervisor> | undefined;
  const get = () => restored ??= DockerSupervisor.restoreProfile(profile);
  return {
    async captureProfile() { return profile; },
    async execute(request, signal) { return (await get()).execute(request, signal); },
    async observe(request) { return (await get()).observe(request); },
    async cancel(request) { return (await get()).cancel(request); },
    async collectOutputFiles(request) { return (await get()).collectOutputFiles(request); },
    async recoverOutput(request) { return (await get()).recoverOutput(request); },
    async release(request) { return (await get()).release(request); },
  };
}
