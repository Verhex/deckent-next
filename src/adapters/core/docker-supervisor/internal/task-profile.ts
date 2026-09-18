import { z } from 'zod';
import { executionProfileDefinitionSchema, type ExecutionProfileDefinition } from '#domain/index.js';
import { DOCKER_EXECUTION_SETTINGS } from '#platform/index.js';

const dockerTaskProfileParametersSchema = DOCKER_EXECUTION_SETTINGS.omit({ executable: true }).extend({
  argv: z.array(z.string().refine(value => !value.includes(String.fromCharCode(0)))).min(1)
    .refine(argv => (argv[0]?.length ?? 0) > 0).readonly(),
}).strict().readonly();

export class DockerTaskProfileError extends Error {
  constructor(readonly code = 'DOCKER_TASK_PROFILE_INVALID') { super(code); this.name = 'DockerTaskProfileError'; }
}

/** Installed registry validator for task templates. Host executable, workspace and OS identity are
 * supplied later by trusted runtime composition and are never accepted as registry parameters. */
export function validateDockerTaskProfile(input: ExecutionProfileDefinition): undefined {
  const profile = executionProfileDefinitionSchema.safeParse(input);
  if (!profile.success || profile.data.adapter.id !== 'docker' || profile.data.adapter.version !== 2
    || !dockerTaskProfileParametersSchema.safeParse(profile.data.parameters).success) {
    throw new DockerTaskProfileError();
  }
  return undefined;
}
