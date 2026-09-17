import { z } from 'zod';
import { DOCKER_EXECUTION_SETTINGS } from '#platform/index.js';
export const dockerSupervisorOptionsSchema = DOCKER_EXECUTION_SETTINGS.extend({ workspaceRoot: z.string().min(1),
  uid: z.number().int().positive(), gid: z.number().int().nonnegative() }).strict().readonly();
export type DockerSupervisorOptions = z.infer<typeof dockerSupervisorOptionsSchema>;
