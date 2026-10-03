import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { exactModelIdSchema, REASONING_EFFORTS } from '#domain/core/provider-catalog/index.js';

/** Owner 2026-09-30 K3 = A: the typed input of one coding task (task graph v3). A registry TEMPLATE supplies everything else;
 * admission compiles template + input once into the Run's frozen execution snapshot. Task text never lives in the registry. */
export const WORK_INPUT_SCHEMA_VERSION = 1;
export const WORK_INPUT_TEXT_MAX_BYTES = 16_384;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const workText = z.string().min(1).refine(value => value.trim().length > 0 && !value.includes('\0') && bytes(value) <= WORK_INPUT_TEXT_MAX_BYTES);
/** Repository-relative POSIX path or glob; K6 enforces it later on patch preparation. No absolute, parent, empty or control segment. */
const scopePath = z.string().min(1).max(512).refine(value => value.trim() === value && !value.startsWith('/') && !value.includes('\\')
  && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'));
export const workInputSchema = z.object({
  schemaVersion: z.literal(WORK_INPUT_SCHEMA_VERSION),
  task: workText,
  scope: z.object({ paths: z.array(scopePath).min(1).max(64).readonly() }).strict().readonly(),
  acceptance: workText,
  /** Exact API model ids of a catalog channel; aliases are refused at admission, never resolved. */
  model: z.object({ channelId: identitySchema, modelId: exactModelIdSchema, auxiliaryModelIds: z.array(exactModelIdSchema).max(8).readonly() }).strict().readonly(),
  /** Catalog-validated explicit reasoning depth; admission compiles it into the frozen native command. */
  effort: z.enum(REASONING_EFFORTS).optional(),
  /** Optional class/load override from the versioned registry; independent of deadline and budget. */
  workClass: identitySchema.optional(),
  /** Overrides the template's turn limit when present; only CLIs with a turn-limit flag accept one. */
  maxTurns: z.number().int().positive().safe().optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.scope.paths).size !== value.scope.paths.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['scope', 'paths'], message: 'duplicate' });
}).readonly();
export type WorkInput = z.infer<typeof workInputSchema>;
