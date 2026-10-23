import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
const brainTierRefusal = (p: Parameters<typeof t>[1], l: Parameters<typeof t>[2]) => {
  switch (p?.['reason']) {
    case 'model-unknown': return t('error.BRAIN_TIER_REFUSED.model-unknown', p, l);
    case 'tier': return t('error.BRAIN_TIER_REFUSED.tier', p, l);
    case 'role-not-held': return t('error.BRAIN_TIER_REFUSED.role-not-held', p, l);
    case 'exception-not-current': return t('error.BRAIN_TIER_REFUSED.exception-not-current', p, l);
    case 'exception-dropped': return t('error.BRAIN_TIER_REFUSED.exception-dropped', p, l);
    case 'role-unknown': return t('error.BRAIN_TIER_REFUSED.role-unknown', p, l);
    default: return t('error.BRAIN_TIER_REFUSED', p, l);
  }
};
/** Error codes owned by the `assignment` family (ATAMA-1 system worker assignment; i18n `locales/<locale>/assignment.json`). */
export const assignmentErrors: ErrorDefinitions = Object.freeze({
  // The detail (task, class, each skipped candidate with its reason) is response-only on a proposal; a replay renders the plain text.
  WORKER_ASSIGNMENT_NO_CANDIDATES: { category: 'error', render: (p, l) => ({ message: p['workClass'] === undefined ? t('error.WORKER_ASSIGNMENT_NO_CANDIDATES', {}, l)
    : t('error.WORKER_ASSIGNMENT_NO_CANDIDATES.detail', p, l) }) },
  WORKER_ASSIGNMENT_NONE: { category: 'error', render: (p, l) => ({ message: p['workClass'] === undefined ? t('error.WORKER_ASSIGNMENT_NONE', {}, l)
    : t('error.WORKER_ASSIGNMENT_NONE.detail', p, l) }) },
  WORKER_MODEL_UNASSIGNED: { category: 'error', render: (p, l) => ({ message: t('error.WORKER_MODEL_UNASSIGNED', p, l) }) },
  BRAIN_ASSIGNMENT_REFUSED: { category: 'error', render: (p, l) => ({ message: t('error.BRAIN_ASSIGNMENT_REFUSED', p, l) }) },
  WORK_CLASS_CANDIDATES_NOT_REGISTERED: { category: 'error', render: (p, l) => ({ message: t('error.WORK_CLASS_CANDIDATES_NOT_REGISTERED', p, l) }) },
  // S2 tier/role gate: the reason selects the next step; a reason this release does not know renders the plain refusal.
  BRAIN_TIER_REFUSED: { category: 'error', render: (p, l) => ({ message: brainTierRefusal(p, l) }) },
  MODEL_ROLE_NOT_REGISTERED: { category: 'error', render: (p, l) => ({ message: t('error.MODEL_ROLE_NOT_REGISTERED', p, l) }) },
  MODEL_ROLE_OVERRIDE_DENIED: { category: 'error', render: (p, l) => ({ message: t('error.MODEL_ROLE_OVERRIDE_DENIED', p, l) }) },
  MODEL_ROLE_TIER_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.MODEL_ROLE_TIER_INVALID', p, l) }) },
  MODEL_ROLE_REGISTRY_LIMIT: { category: 'error', render: (p, l) => ({ message: t('error.MODEL_ROLE_REGISTRY_LIMIT', p, l) }) },
  MODEL_ROLE_REVISION_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.MODEL_ROLE_REVISION_INVALID', p, l) }) },
  MODEL_ROLE_LAYER_INVALID: { category: 'error', render: (p, l) => ({ message: t('error.MODEL_ROLE_LAYER_INVALID', p, l) }) },
});
