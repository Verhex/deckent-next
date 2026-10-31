import { z } from 'zod';
import limits from '../../../../../assets/beuser/limits.json' with { type: 'json' };
import { field } from './field.js';

/** New config uses the newest versioned ceiling; retained profiles still resolve their own revision. */
const BEUSER_CONFIG_CEILING = Object.freeze(limits.profiles.at(-1)!);
const ceiling = BEUSER_CONFIG_CEILING;
const BEUSER_LIMIT_OVERRIDES = z.object({ maxWallMs: z.number().int().positive().safe().max(ceiling.maxWallMs).optional(),
  maxReruns: z.number().int().positive().safe().max(ceiling.maxReruns).optional(),
  maxSteps: z.number().int().positive().safe().max(ceiling.maxSteps).optional(),
  maxCost: z.number().positive().finite().max(ceiling.maxCost).optional() }).strict();
export const SETUP_FIELDS = Object.freeze({
  beuser: field('beuser.config.description', { state: 'bound', consumers: ['src/composition/core/beuser'] }, 'live',
    z.object({ limits: BEUSER_LIMIT_OVERRIDES.default({}) }).strict().default({})),
});
