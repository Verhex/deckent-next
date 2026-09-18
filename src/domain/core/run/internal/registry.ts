import { z } from 'zod';
import { identitySchema, counterSchema, immutableJsonObjectSchema } from '#domain/core/primitives/index.js';
/** Registry entries are product data; installed implementations own parameter semantics. */
export const implementationReferenceSchema = z.object({ id: identitySchema, version: counterSchema.positive() }).strict().readonly();
export const executionProfileDefinitionSchema = z.object({ id: identitySchema, version: counterSchema.positive(),
  adapter: implementationReferenceSchema, parameters: immutableJsonObjectSchema,
}).strict().readonly();
export const evaluatorDefinitionSchema = z.object({ id: identitySchema, version: counterSchema.positive(),
  implementation: implementationReferenceSchema,
}).strict().readonly();
export const executionRegistrySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema,
  profiles: z.array(executionProfileDefinitionSchema).min(1).readonly(),
  kinds: z.array(z.object({ kind: identitySchema, profile: implementationReferenceSchema }).strict().readonly()).min(1).readonly(),
  evaluators: z.array(evaluatorDefinitionSchema).min(1).readonly(),
}).strict().superRefine((registry, context) => {
  const unique = (values: readonly string[], path: string) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: 'EXECUTION_REGISTRY_DUPLICATE' });
  };
  unique(registry.profiles.map(value => JSON.stringify([value.id, value.version])), 'profiles');
  unique(registry.kinds.map(value => value.kind), 'kinds');
  unique(registry.evaluators.map(value => JSON.stringify([value.id, value.version])), 'evaluators');
  registry.kinds.forEach((entry, index) => {
    if (!registry.profiles.some(profile => profile.id === entry.profile.id && profile.version === entry.profile.version)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['kinds', index, 'profile'], message: 'EXECUTION_PROFILE_NOT_REGISTERED' });
    }
  });
}).readonly();
export type ExecutionRegistry = z.infer<typeof executionRegistrySchema>;
export type ExecutionProfileDefinition = z.infer<typeof executionProfileDefinitionSchema>;
export type EvaluatorDefinition = z.infer<typeof evaluatorDefinitionSchema>;
/** The selected definitions belong to the Run, not the current installation config. */
export const runExecutionSnapshotSchema = z.object({ schemaVersion: z.literal(1), registryRevision: identitySchema,
  tasks: z.array(z.object({ taskId: identitySchema, profile: executionProfileDefinitionSchema }).strict().readonly()).min(1).readonly(),
  criteria: z.array(z.object({ criterionId: identitySchema, evaluator: evaluatorDefinitionSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().readonly()).min(1).readonly(),
}).strict().readonly();
export type RunExecutionSnapshot = z.infer<typeof runExecutionSnapshotSchema>;
