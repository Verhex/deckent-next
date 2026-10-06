import { z } from 'zod';
import { identitySchema, counterSchema, immutableJsonObjectSchema, type JsonValue } from '#domain/core/primitives/index.js';
import { encodeDeckentJson } from '#domain/core/task-graph/index.js';
import { workClassRegistrySchema } from './work-class.js';
/** Registry entries are product data; installed implementations own parameter semantics. */
export const implementationReferenceSchema = z.object({ id: identitySchema, version: counterSchema.positive() }).strict().readonly();
export const executionProfileDefinitionSchema = z.object({ id: identitySchema, version: counterSchema.positive(),
  adapter: implementationReferenceSchema, parameters: immutableJsonObjectSchema,
}).strict().readonly();
export const evaluatorDefinitionSchema = z.object({ id: identitySchema, version: counterSchema.positive(),
  implementation: implementationReferenceSchema,
}).strict().readonly();
/** EXEC-RELEASE C2 (owner 2026-10-06, B): an explicit kind-level declaration that the kind's attempts deliver nothing from their workspace
 * (read-only analysis/review). Additive and optional within registry v1 / snapshot v1: absent means a workspace delivery may be owed, so
 * an unmarked attempt without a retained patch is never released (fail-closed). Admission copies it into the Run's frozen snapshot only
 * when present, so unmarked Runs keep their exact pre-existing snapshot bytes. */
export const workspaceDeliveryDeclarationSchema = z.literal('none');
export const executionRegistrySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema,
  workClasses: workClassRegistrySchema.optional(),
  profiles: z.array(executionProfileDefinitionSchema).min(1).readonly(),
  kinds: z.array(z.object({ kind: identitySchema, profile: implementationReferenceSchema, workspaceDelivery: workspaceDeliveryDeclarationSchema.optional() }).strict().readonly()).min(1).readonly(),
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
export const EXECUTION_PROFILE_ENCODING_VERSION = 1;
/** Deckent profile encoding v1: the criterion encoding v1 rules (sorted keys, JSON escaping, no whitespace) over a parsed
 * definition. Callers hash its UTF-8 bytes; equal encodings mean the same image, command and bounds for a task kind. */
export function encodeExecutionProfileDefinition(input: unknown): string {
  const definition = executionProfileDefinitionSchema.parse(input) as unknown as JsonValue;
  return encodeDeckentJson({ encodingVersion: EXECUTION_PROFILE_ENCODING_VERSION, definition });
}
export type ExecutionRegistry = z.infer<typeof executionRegistrySchema>;
export type ExecutionProfileDefinition = z.infer<typeof executionProfileDefinitionSchema>;
export type EvaluatorDefinition = z.infer<typeof evaluatorDefinitionSchema>;
/** The selected definitions belong to the Run, not the current installation config. */
export const runExecutionSnapshotSchema = z.object({ schemaVersion: z.literal(1), registryRevision: identitySchema,
  tasks: z.array(z.object({ taskId: identitySchema, profile: executionProfileDefinitionSchema, workspaceDelivery: workspaceDeliveryDeclarationSchema.optional() }).strict().readonly()).min(1).readonly(),
  criteria: z.array(z.object({ criterionId: identitySchema, evaluator: evaluatorDefinitionSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().readonly()).min(1).readonly(),
}).strict().readonly();
export type RunExecutionSnapshot = z.infer<typeof runExecutionSnapshotSchema>;
