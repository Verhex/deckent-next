import { persistedInteger } from '#platform/core/validate/index.js';
import { z } from 'zod';
import limits from '../../../../../assets/beuser/limits.json' with { type: 'json' };
import { field } from './field.js';

/** New config uses the newest versioned ceiling; retained profiles still resolve their own revision. */
const BEUSER_CONFIG_CEILING = Object.freeze(limits.profiles.at(-1)!);
const ceiling = BEUSER_CONFIG_CEILING;
const BEUSER_LIMIT_OVERRIDES = z.strictObject({ maxWallMs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).max(ceiling.maxWallMs).optional(),
  maxReruns: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).max(ceiling.maxReruns).optional(),
  maxSteps: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).max(ceiling.maxSteps).optional(),
  maxCost: z.number().positive().finite().max(ceiling.maxCost).optional() });
export const SETUP_FIELDS = Object.freeze({
  beuser: field('beuser.config.description', { state: 'bound', consumers: ['src/composition/core/beuser'] }, 'live',
    z.strictObject({ limits: BEUSER_LIMIT_OVERRIDES.prefault({}) }).prefault({})),
});
