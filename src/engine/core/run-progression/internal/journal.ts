import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/index.js';
export const progressionActorSchema = z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict();
export const progressionCursorSchema = z.object({ scopeId: identitySchema, runId: identitySchema }).strict();
export const progressionQuerySchema = z.object({ actor: progressionActorSchema,
  after: progressionCursorSchema.nullable(), limit: counterSchema.positive().max(2147483646),
  /** When set, only scopes registered to this company are listed (foreign and unregistered scopes are not this installation's work). */
  companyId: identitySchema.optional() }).strict();
export type ProgressionQuery = z.infer<typeof progressionQuerySchema>;
export type ProgressionCursor = z.infer<typeof progressionCursorSchema>;
export interface RunProgressionJournal {
  listRunProgression(query: ProgressionQuery): Promise<Readonly<{ items: readonly ProgressionCursor[]; next: ProgressionCursor | null }>>;
}
