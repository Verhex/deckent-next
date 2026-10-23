import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
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
});
