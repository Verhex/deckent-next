import { z } from 'zod';
import registry from '../../../../../assets/native-coding/commands.json' with { type: 'json' };
import { workspaceHiddenPathsSchema, type WorkspaceHiddenPaths } from '#domain/core/primitives/index.js';

/** Pure provider vocabulary from the versioned registry asset; no adapter dependency or I/O. */
export function providerIdSchema<const Id extends string>(ids: readonly Id[]) {
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error('PROVIDER_ID_VOCABULARY_INVALID');
  return z.enum(ids as [Id, ...Id[]]);
}
/** The vocabulary checks the registry envelope before startup derives ids; stale assets get the same typed refusal as capability loading. */
export class NativeCliRegistryError extends Error {
  readonly code = 'NATIVE_CLI_REGISTRY_INVALID';
  constructor() { super('NATIVE_CLI_REGISTRY_INVALID'); this.name = 'NativeCliRegistryError'; }
}
const vocabularyEnvelope = z.object({ schemaVersion: z.literal(3), adapters: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.unknown())
  .refine(value => Object.keys(value).length > 0), instructionSurface: z.object({ hiddenPaths: workspaceHiddenPathsSchema }).strict() }).strict();
export function nativeCliVocabulary(input: unknown): readonly string[] {
  const parsed = vocabularyEnvelope.safeParse(input);
  if (!parsed.success) throw new NativeCliRegistryError();
  return Object.freeze(Object.keys(parsed.data.adapters));
}
/** Registry-derived id (a string whose values come from the asset at load); the published declaration must not reference the JSON
 * module (consumers resolve our `.d.ts` with `resolveJsonModule: false`), so the type is the vocabulary's element type, not `keyof typeof`. */
export type NativeCliId = string;
export const nativeCliIds: readonly [NativeCliId, ...NativeCliId[]] = nativeCliVocabulary(registry) as readonly [NativeCliId, ...NativeCliId[]];
export const nativeCliIdSchema = providerIdSchema(nativeCliIds);
/**
 * G1 (alpha.53): the repository instruction surface, one registry list. A checkout-realised `disabled` worker (Cursor, C2) hides it unless its
 * template names its own set, and delivery refuses a change inside it that the task scope does not name explicitly, for every provider.
 */
export const INSTRUCTION_SURFACE_PATHS: WorkspaceHiddenPaths = vocabularyEnvelope.parse(registry).instructionSurface.hiddenPaths;
const frozenCheckoutSchema = z.object({ nativeSubscription: z.object({ checkout: z.object({ hiddenPaths: workspaceHiddenPathsSchema }).passthrough() }).passthrough() }).passthrough();
/** The instruction surface a Run's frozen profile was bound to: its pinned checkout set (per-template override, replay-exact), else the registry list. */
export function instructionSurfacePaths(profileParameters: unknown): WorkspaceHiddenPaths {
  const frozen = frozenCheckoutSchema.safeParse(profileParameters);
  return frozen.success ? frozen.data.nativeSubscription.checkout.hiddenPaths : INSTRUCTION_SURFACE_PATHS;
}
/** How a native CLI reports the model it ran: `session-events` = start model plus per-model usage (verifiable); `session-start-name` = only the
 * model's display name at session start, compared with the catalog's recorded reported names (never `verified`); `client-reported` = the model
 * the client resolved, read from the client's own session log, which the worker can rewrite (owner Q4 2026-10-23: never `verified`, a differing
 * name is held, never a substitution fail); `none` = no model evidence. */
export const modelUsageEvidenceSchema = z.enum(['session-events', 'session-start-name', 'client-reported', 'none']);
export type ModelUsageEvidence = z.infer<typeof modelUsageEvidenceSchema>;
/** Capabilities that existed before capability stamping; unstamped records were written under one of these. */
const LEGACY_MODEL_USAGE_EVIDENCE: readonly ModelUsageEvidence[] = Object.freeze(['session-events', 'none']);

/** Read migration only: profiles/records written before capability stamping retain the shipped registry behavior of that time. A capability
 * added after stamping (e.g. `session-start-name`) never applies to such a record: it was produced without that evidence, so it reads as `none`. */
export function readLegacyModelUsageEvidence(provider: NativeCliId): ModelUsageEvidence {
  const adapters: Record<string, { readonly capabilities?: { readonly modelUsageEvidence?: unknown } } | undefined> = registry.adapters;
  const entry = adapters[provider];
  if (!entry) throw new NativeCliRegistryError();
  const current = modelUsageEvidenceSchema.parse(entry.capabilities?.modelUsageEvidence);
  return LEGACY_MODEL_USAGE_EVIDENCE.includes(current) ? current : 'none';
}
