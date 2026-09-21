import { taskInputBindingSchema } from '#engine/index.js';
import { z } from 'zod';
import { dockerOutputFilesSchema } from './output-files.js';
import { DOCKER_EXECUTION_SETTINGS } from '#platform/index.js';
import { dockerConnectionSchema } from './connection.js';
export const dockerSupervisorOptionsSchema = DOCKER_EXECUTION_SETTINGS.extend({ workspaceRoot: z.string().min(1),
  connection: dockerConnectionSchema.optional(),
  outputFiles: dockerOutputFilesSchema.optional(),
  inputs: z.array(taskInputBindingSchema.unwrap().extend({ path: z.string().min(1) }).strict().readonly()).readonly().optional(),
  uid: z.number().int().positive(), gid: z.number().int().nonnegative() }).strict().readonly();
export type DockerSupervisorOptions = z.infer<typeof dockerSupervisorOptionsSchema>;
