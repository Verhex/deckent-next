import { z } from 'zod';
/** Required runtime capability settings; install/config composition supplies policy values. */
export const DOCKER_EXECUTION_SETTINGS = z.object({
  executable: z.string().min(1), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  memoryBytes: z.number().int().positive().safe(), pids: z.number().int().positive(), cpus: z.number().positive().finite(),
  logMaxSizeKiB: z.number().int().positive().safe(), logMaxFiles: z.number().int().positive().safe(),
  tmpBytes: z.number().int().positive().safe(), deadlineMs: z.number().int().positive().max(2_147_483_647),
  controlTimeoutMs: z.number().int().positive().max(2_147_483_647), outputBytes: z.number().int().positive().safe(),
}).strict();
/** outputBytes bounds one Git listing/blob read; the default fits repositories with tens of thousands of tracked paths. */
export const GIT_EXECUTION_SETTINGS = z.object({ gitExecutable: z.string().min(1),
  timeoutMs: z.number().int().positive().max(2_147_483_647), outputBytes: z.number().int().positive().safe().default(4_194_304) }).strict();
export const ARTIFACT_STORAGE_LIMITS = z.object({ maxBytes: z.number().int().positive().safe() }).strict();
