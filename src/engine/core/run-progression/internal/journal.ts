import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/index.js';
const progressionActorSchema = z.strictObject({ id: identitySchema, issuer: identitySchema, subject: identitySchema });
export const progressionCursorSchema = z.strictObject({ scopeId: identitySchema, runId: identitySchema });
export const progressionQuerySchema = z.strictObject({ actor: progressionActorSchema,
  after: progressionCursorSchema.nullable(), limit: counterSchema.positive().max(2147483646),
  /** When set, only scopes registered to this company are listed (foreign and unregistered scopes are not this installation's work). */
  companyId: identitySchema.optional() });
export type ProgressionQuery = z.infer<typeof progressionQuerySchema>;
export type ProgressionCursor = z.infer<typeof progressionCursorSchema>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export interface RunProgressionJournal {
  listRunProgression(query: ProgressionQuery): Promise<Readonly<{ items: readonly ProgressionCursor[]; next: ProgressionCursor | null }>>;
}
