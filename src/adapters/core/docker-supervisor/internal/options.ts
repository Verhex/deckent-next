import { taskInputBindingSchema } from '#engine/index.js';
import { z } from 'zod';
import { artifactReceiptSchema } from '#capabilities/index.js';
import { dockerOutputFilesSchema } from './output-files.js';
import { DOCKER_EXECUTION_SETTINGS } from '#platform/index.js';
import { dockerConnectionSchema } from './connection.js';
import { dockerResolvedMountsSchema } from './mounts.js';
export const dockerSupervisorOptionsSchema = DOCKER_EXECUTION_SETTINGS.extend({ workspaceRoot: z.string().min(1),
  connection: dockerConnectionSchema.optional(),
  outputFiles: dockerOutputFilesSchema.optional(),
  readOnlyMounts: dockerResolvedMountsSchema.optional(),
  handoffInputs: z.array(z.object({ target: z.string().refine(value => value === '/deckent/inputs/_shared.json' || /^\/deckent\/inputs\/_handoff\/[A-Za-z0-9_%!~*().+-]+\.json$/.test(value)), receipt: artifactReceiptSchema, path: z.string().min(1) }).strict().readonly()).readonly().optional(),
  inputs: z.array(taskInputBindingSchema.unwrap().extend({ path: z.string().min(1) }).strict().readonly()).readonly().optional(),
  uid: z.number().int().positive(), gid: z.number().int().nonnegative() }).strict().readonly();
export type DockerSupervisorOptions = z.infer<typeof dockerSupervisorOptionsSchema>;
