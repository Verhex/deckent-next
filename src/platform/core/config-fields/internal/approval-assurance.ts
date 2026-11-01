import { persistedString, persistedInteger } from '#platform/core/validate/index.js';
import { z } from 'zod';
/** Versioned selection; existing configurations retain the Core turn producer. Empty selection disables it, never its minimum. */
export const CORE_TURN_ASSURANCE_REFERENCE = Object.freeze({ id: 'core.turn-bound', version: 1 });
export const APPROVAL_ASSURANCE_SELECTION = z.array(z.strictObject({ id: persistedString(z.string().min(1).max(128)), version: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }))
  .max(128).refine(rows => new Set(rows.map(row => row.id)).size === rows.length).prefault([CORE_TURN_ASSURANCE_REFERENCE]);
