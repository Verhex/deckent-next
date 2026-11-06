import { z } from 'zod';
import { identitySchema, counterSchema, immutableJsonObjectSchema, type JsonValue } from '#domain/core/primitives/index.js';
import { encodeDeckentJson } from '#domain/core/task-graph/index.js';
import { frozenWorkClassProfileSchema, taskAcceptanceReferenceSchema } from './acceptance.js';
import { workClassRegistrySchema } from './work-class.js';
import { workerAssignmentSchema } from './assignment.js';
import { runRecoveryPolicySchema } from '#domain/core/recovery/index.js';
import { taskAgentSealSchema } from '#domain/core/agent-catalog/index.js';
/** Registry entries are product data; installed implementations own parameter semantics. */
export const implementationReferenceSchema = z.strictObject({ id: identitySchema, version: counterSchema.positive() }).readonly();
export const executionProfileDefinitionSchema = z.strictObject({ id: identitySchema, version: counterSchema.positive(),
  adapter: implementationReferenceSchema, parameters: immutableJsonObjectSchema,
}).readonly();
export const evaluatorDefinitionSchema = z.strictObject({ id: identitySchema, version: counterSchema.positive(),
  implementation: implementationReferenceSchema,
}).readonly();
/** EXEC-RELEASE C2 (owner 2026-10-06, B): an explicit kind-level declaration that the kind's attempts deliver nothing from their workspace
 * (read-only analysis/review). Additive and optional within registry v1 / snapshot v1: absent means a workspace delivery may be owed, so
 * an unmarked attempt without a retained patch is never released (fail-closed). Admission copies it into the Run's frozen snapshot only
 * when present, so unmarked Runs keep their exact pre-existing snapshot bytes. */
export const workspaceDeliveryDeclarationSchema = z.literal('none');
export const executionRegistrySchema = z.strictObject({ schemaVersion: z.literal(1), revision: identitySchema,
  workClasses: workClassRegistrySchema.optional(),
  profiles: z.array(executionProfileDefinitionSchema).min(1).readonly(),
  kinds: z.array(z.strictObject({ kind: identitySchema, profile: implementationReferenceSchema, workspaceDelivery: workspaceDeliveryDeclarationSchema.optional() }).readonly()).min(1).readonly(),
  evaluators: z.array(evaluatorDefinitionSchema).min(1).readonly(),
}).superRefine((registry, context) => {
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
/** R3 (owner D4a): the silence policy frozen per watchable task at admission: warn and stop after this much host-observed silence, and at
 * most `maxRetries` automatic re-runs of a stalled Attempt. Absent (older Runs, unwatchable profiles): only the profile deadline bounds it. */
export const taskStallPolicySchema = z.strictObject({ warnAfterMs: counterSchema.positive(), stopAfterMs: counterSchema.positive(), maxRetries: counterSchema }).refine(value => value.warnAfterMs < value.stopAfterMs, 'WORKER_INACTIVITY_POLICY_INVALID').readonly();
export type TaskStallPolicy = z.infer<typeof taskStallPolicySchema>;
/** The selected definitions belong to the Run, not the current installation config. */
export const runExecutionSnapshotSchema = z.strictObject({ schemaVersion: z.literal(1), registryRevision: identitySchema,
  workClassProfiles: z.array(frozenWorkClassProfileSchema).max(256).readonly().optional(),
  tasks: z.array(z.strictObject({ taskId: identitySchema, acceptance: taskAcceptanceReferenceSchema.optional(), profile: executionProfileDefinitionSchema, workspaceDelivery: workspaceDeliveryDeclarationSchema.optional(), stall: taskStallPolicySchema.optional(),
    /** ATAMA-1: present only when the system assigned the worker (work input v2 without a model); older snapshots keep their exact bytes. */
    assignment: workerAssignmentSchema.optional(),
    /** S8-1b: the agent the system selected for a work-input task (persona and pinned skills in its prompt); absent = no eligible agent, exact older bytes. */
    agent: taskAgentSealSchema.optional() }).readonly()).min(1).readonly(),
  /** R9 (owner 2026-11-05): the mode shown on the plan card the person approved, a worker's ceiling (never full access); absent (an older,
   * card-less or AI-created Run) = the person's current mode alone, as before. Bound in the admission basis the card's approval seals. */
  workerMode: z.strictObject({ mode: z.enum(['standart', 'full-auto']), askEdits: z.boolean() }).readonly().optional(),
  /** S6R-4: the recovery bounds frozen at admission; absent (a Run admitted before the switch, or recovery off) = no automatic continuation ever. */
  recovery: runRecoveryPolicySchema.optional(),
  criteria: z.array(z.strictObject({ criterionId: identitySchema, evaluator: evaluatorDefinitionSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).readonly()).min(1).readonly(),
}).readonly();
export type RunExecutionSnapshot = z.infer<typeof runExecutionSnapshotSchema>;
