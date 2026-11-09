import { t } from '#platform/core/i18n/index.js';
import { errorTable, plainErrors, type ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `setup` family (i18n `locales/<locale>/setup.json`); texts live in that family. */
export const setupErrors: ErrorDefinitions = errorTable('setup', plainErrors('error.', { SETUP_STAGE_INVALID: 'usage', SETUP_STAGE_SHADOW: 'usage', SETUP_FAMILY_UNKNOWN: 'usage' }), {
  // The refused family and field (key path only) when known; a bare refusal keeps the generic sentence.
  SETUP_OBSERVATION_INVALID: { category: 'usage', render: (p, l) => ({ message: p['family'] && p['field'] ? t('error.SETUP_OBSERVATION_INVALID.field', p, l) : t('error.SETUP_OBSERVATION_INVALID', p, l) }) },
}, plainErrors('error.', {
  SETUP_ANSWER_INVALID: 'usage',
  // I-S4: `--yes` reached an eligible stage this build cannot apply (no apply owner wired yet); nothing was written.
  SETUP_APPLY_UNAVAILABLE: 'config',
  // I-D2: the policy has no installation-wide grant for this person to install the execution environment; nothing ran (audited as refused).
  SETUP_INSTALL_DENIED: 'config',
  // I-D2: detection could not tell whether the runtime is installed; an install is never offered or run on an unknown state.
  SETUP_INSTALL_STATE_UNKNOWN: 'error',
  // I-S3: a stage's owner refused (no terminal, no witness, no grant) in an unattended `deckent init --yes`; the stage is named, nothing after it ran.
  SETUP_STAGE_REFUSED: 'usage',
  // BR1: the worker-image stage found no reachable Docker when the person confirmed; nothing was built or checked.
  SETUP_WORKER_DOCKER_UNAVAILABLE: 'config',
  // alpha.56 U4-1c (coding.first-commit@1): the repository changed after the preview (a commit, staging, a Git lock, another file list); nothing written.
  SETUP_FIRST_COMMIT_CHANGED: 'usage',
  // The candidate files exceed the card's bound (params observed, limit); nothing written, the person uses Git directly.
  SETUP_FIRST_COMMIT_TOO_LARGE: 'usage',
  // HEAD was committed but the index swap failed (params command: the recovery command).
  SETUP_FIRST_COMMIT_INDEX_PENDING: 'error',
  // A step before the ref update failed (params step, detail: Git's redacted last stderr line or an errno code); HEAD and the index unchanged.
  SETUP_FIRST_COMMIT_FAILED: 'error',
  // alpha.56 U3-1a: an answer to a stage of the other phase (an onboarding stage given to `deckent init`); refused, never ignored.
  SETUP_STAGE_NOT_IN_PHASE: 'usage',
}));
