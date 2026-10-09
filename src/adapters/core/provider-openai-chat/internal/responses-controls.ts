import { z } from 'zod';
import asset from './responses-controls.json' with { type: 'json' };
const bound = z.number().int().positive().safe();
/** Policy is asset data; malformed bounds fail at load, never become an unbounded loop or a hidden fallback. */
export const RESPONSES_CONTROLS = Object.freeze(z.object({ schemaVersion: z.literal(1), source: z.string().min(1),
  continuationMaxEntries: bound, continuationMaxBytes: bound, continuationTtlMs: bound, errorMessageMaxChars: bound }).strict().parse(asset));
