import { recordedDockerSupervisor, validateDockerSupervisorProfile } from '#adapters/index.js';
import type { DispatchRecord } from '#engine/index.js';
import { recordedBeuserSupervisor } from './beuser-recorded.js';
import { beuserSupervisorProfileSchema } from './beuser-profile.js';

/** An unknown adapter/version has no management fallback. Opening a supervisor itself performs no effects. */
export function recordedExecutionSupervisor(recorded: DispatchRecord, input: Parameters<typeof recordedBeuserSupervisor>[1]) {
  if (beuserSupervisorProfileSchema.safeParse(recorded.profile).success) return recordedBeuserSupervisor(recorded, input);
  validateDockerSupervisorProfile(recorded.profile);
  return recordedDockerSupervisor(recorded.profile);
}
