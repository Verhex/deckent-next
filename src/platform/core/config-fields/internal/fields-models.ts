import { z } from 'zod';
import { field } from './field.js';

/** Config fields owned by the models lane (alpha.48: C-MODELS in W2). Declare each as `name: field(...)` (./field.js);
 * mergeConfigFields adds them to CONFIG_FIELDS and refuses a name already declared. */
export const MODEL_FIELDS = Object.freeze({
  /** C-MODELS (owner CLI review 2026-10-19, law 6): how many days before a switched-on model's announced retirement `deckent models` and
   * `doctor` warn. Display only: admission still refuses a retired model on its own day, whatever this says. */
  models: field('config.field.models', { state: 'bound', consumers: ['src/surfaces/core/cli-models'] }, 'live', z.object({
    retirementWarningDays: z.number().int().min(1).max(365).default(15),
    /** S3-3 (design §10): the installation owner's switch for preview connection kinds (the subscription Brain through the person's own CLI)
     * until isolation (S3-5) lands. Protected (AI floor); read from the user layer only; default off: the kind is refused typed. */
    headless: z.object({ preview: z.boolean().default(false) }).strict().default({}),
  }).strict().default({})),
});
