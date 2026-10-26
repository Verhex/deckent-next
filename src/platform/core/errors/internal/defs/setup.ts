import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `setup` family (i18n `locales/<locale>/setup.json`); texts live in that family. */
export const setupErrors: ErrorDefinitions = Object.freeze({
  SETUP_STAGE_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.SETUP_STAGE_INVALID', p, l) }) },
  SETUP_STAGE_SHADOW: { category: 'usage', render: (p, l) => ({ message: t('error.SETUP_STAGE_SHADOW', p, l) }) },
  SETUP_FAMILY_UNKNOWN: { category: 'usage', render: (p, l) => ({ message: t('error.SETUP_FAMILY_UNKNOWN', p, l) }) },
  SETUP_OBSERVATION_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.SETUP_OBSERVATION_INVALID', p, l) }) },
  SETUP_ANSWER_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.SETUP_ANSWER_INVALID', p, l) }) },
  // I-S4: `--yes` reached an eligible stage this build cannot apply (no apply owner wired yet); nothing was written.
  SETUP_APPLY_UNAVAILABLE: { category: 'config', render: (p, l) => ({ message: t('error.SETUP_APPLY_UNAVAILABLE', p, l) }) },
  // I-D2: the policy has no installation-wide grant for this person to install the execution environment; nothing ran (audited as refused).
  SETUP_INSTALL_DENIED: { category: 'config', render: (p, l) => ({ message: t('error.SETUP_INSTALL_DENIED', p, l) }) },
  // I-D2: detection could not tell whether the runtime is installed; an install is never offered or run on an unknown state.
  SETUP_INSTALL_STATE_UNKNOWN: { category: 'error', render: (p, l) => ({ message: t('error.SETUP_INSTALL_STATE_UNKNOWN', p, l) }) },
  // I-S3: a stage's owner refused (no terminal, no witness, no grant) in an unattended `deckent init --yes`; the stage is named, nothing after it ran.
  SETUP_STAGE_REFUSED: { category: 'usage', render: (p, l) => ({ message: t('error.SETUP_STAGE_REFUSED', p, l) }) },
  // BR1: the worker-image stage found no reachable Docker when the person confirmed; nothing was built or checked.
  SETUP_WORKER_DOCKER_UNAVAILABLE: { category: 'config', render: (p, l) => ({ message: t('error.SETUP_WORKER_DOCKER_UNAVAILABLE', p, l) }) },
  // alpha.56 U4-1c (coding.first-commit@1): the repository changed after the preview (a commit, staging, a Git lock, another file list); nothing written.
  SETUP_FIRST_COMMIT_CHANGED: { category: 'usage', render: (p, l) => ({ message: t('error.SETUP_FIRST_COMMIT_CHANGED', p, l) }) },
  // The candidate files exceed the card's bound (params observed, limit); nothing written, the person uses Git directly.
  SETUP_FIRST_COMMIT_TOO_LARGE: { category: 'usage', render: (p, l) => ({ message: t('error.SETUP_FIRST_COMMIT_TOO_LARGE', p, l) }) },
  // HEAD was committed but the index swap failed (params command: the recovery command).
  SETUP_FIRST_COMMIT_INDEX_PENDING: { category: 'error', render: (p, l) => ({ message: t('error.SETUP_FIRST_COMMIT_INDEX_PENDING', p, l) }) },
  // A step before the ref update failed (params step, detail: Git's redacted last stderr line or an errno code); HEAD and the index unchanged.
  SETUP_FIRST_COMMIT_FAILED: { category: 'error', render: (p, l) => ({ message: t('error.SETUP_FIRST_COMMIT_FAILED', p, l) }) },
  // alpha.56 U3-1a: an answer to a stage of the other phase (an onboarding stage given to `deckent init`); refused, never ignored.
  SETUP_STAGE_NOT_IN_PHASE: { category: 'usage', render: (p, l) => ({ message: t('error.SETUP_STAGE_NOT_IN_PHASE', p, l) }) },
});
