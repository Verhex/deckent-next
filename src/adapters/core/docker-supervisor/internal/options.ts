import { z } from 'zod';
export const dockerSupervisorOptionsSchema = z.object({
  executable: z.string().min(1), workspaceRoot: z.string().min(1),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  uid: z.number().int().positive(), gid: z.number().int().nonnegative(),
  memoryBytes: z.number().int().positive().safe(), pids: z.number().int().positive(), cpus: z.number().positive().finite(),
  logMaxSizeKiB: z.number().int().positive().safe(), logMaxFiles: z.number().int().positive().safe(),
  tmpBytes: z.number().int().positive().safe(), deadlineMs: z.number().int().positive().max(2_147_483_647),
  controlTimeoutMs: z.number().int().positive().max(2_147_483_647), outputBytes: z.number().int().positive().safe(),
}).strict().readonly();
export type DockerSupervisorOptions = z.infer<typeof dockerSupervisorOptionsSchema>;
