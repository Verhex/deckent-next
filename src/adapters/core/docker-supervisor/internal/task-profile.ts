import { z } from 'zod';
import { createHash } from 'node:crypto';
import { dockerOutputFilesSchema } from './output-files.js';
import { executionProfileDefinitionSchema, type ExecutionProfileDefinition } from '#domain/index.js';
import { DOCKER_EXECUTION_SETTINGS } from '#platform/index.js';
import { nativeSubscriptionSchema } from '#adapters/core/native-connection/index.js';

const dockerTaskProfileParametersSchema = DOCKER_EXECUTION_SETTINGS.omit({ executable: true }).extend({
  nativeSubscription: nativeSubscriptionSchema.optional(),
  outputFiles: dockerOutputFilesSchema.optional(),
  argv: z.array(z.string().refine(value => !value.includes(String.fromCharCode(0)))).min(1)
    .refine(argv => (argv[0]?.length ?? 0) > 0).readonly(),
}).strict().readonly();

export class DockerTaskProfileError extends Error {
  constructor(readonly code = 'DOCKER_TASK_PROFILE_INVALID') { super(code); this.name = 'DockerTaskProfileError'; }
}

/** Installed registry validator for task templates. Host executable, workspace and OS identity are
 * supplied later by trusted runtime composition and are never accepted as registry parameters. */
export function validateDockerTaskProfile(input: ExecutionProfileDefinition): undefined {
  resolveDockerTaskProfile(input);
  return undefined;
}

/** Materialize only pinned task data. Host executable and OS/workspace custody stay in composition. */
export function resolveDockerTaskProfile(input: ExecutionProfileDefinition) {
  const profile = executionProfileDefinitionSchema.safeParse(input);
  if (!profile.success || profile.data.adapter.id !== 'docker' || profile.data.adapter.version !== 2) {
    throw new DockerTaskProfileError();
  }
  const parsed = dockerTaskProfileParametersSchema.safeParse(profile.data.parameters);
  if (!parsed.success) throw new DockerTaskProfileError();
  const { argv, nativeSubscription, ...options } = parsed.data;
  if (nativeSubscription?.promptDelivery && nativeSubscription.promptDelivery.argvSha256
    !== createHash('sha256').update(JSON.stringify(argv)).digest('hex')) throw new DockerTaskProfileError();
  return Object.freeze({ argv, nativeSubscription, options: Object.freeze(options) });
}
