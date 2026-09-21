import { z } from 'zod';
import { executionProfileDefinitionSchema } from '#domain/index.js';
import { compileNativeCodingDockerProfile, nativeCodingInvocationSchema } from '#adapters/index.js';
import { ErrorRegistry } from '#platform/index.js';

const requestSchema = z.object({ schemaVersion: z.literal(1), template: executionProfileDefinitionSchema,
  invocation: nativeCodingInvocationSchema }).strict();

/** Local authoring only: no config write, login, process launch or admission. */
export function prepareNativeCodingProfile(input: unknown) {
  const request = requestSchema.safeParse(input);
  if (!request.success) throw ErrorRegistry.createError('EXECUTION_PROFILE_INVALID');
  try {
    const profile = compileNativeCodingDockerProfile(request.data.template, request.data.invocation);
    return Object.freeze({ schemaVersion: 1 as const, profile, activation: 'not-activated' as const });
  } catch { throw ErrorRegistry.createError('EXECUTION_PROFILE_INVALID'); }
}
