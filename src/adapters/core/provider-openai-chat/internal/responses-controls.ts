import { persistedInteger } from '#domain/index.js';
import { z } from 'zod';
import asset from './responses-controls.json' with { type: 'json' };
const bound = persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
/** Policy is asset data; malformed bounds fail at load, never become an unbounded loop or a hidden fallback. */
export const RESPONSES_CONTROLS = Object.freeze(z.strictObject({ schemaVersion: z.literal(1), source: z.string().min(1),
  continuationMaxEntries: bound, continuationMaxBytes: bound, continuationTtlMs: bound, errorMessageMaxChars: bound }).parse(asset));
