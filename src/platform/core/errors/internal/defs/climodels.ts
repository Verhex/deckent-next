import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `climodels` family (i18n `locales/<locale>/climodels.json`); texts live in that family. */
export const climodelsErrors: ErrorDefinitions = Object.freeze({
  // C-MODELS (owner A48-D5/D6): an MCP trust decision is a person's card on a real terminal; `--yes` no longer skips it (moved from the registry).
  MCP_APPROVAL_NEEDS_TERMINAL: { category: 'usage', render: (p, l) => ({ message: t('error.MCP_APPROVAL_NEEDS_TERMINAL', p, l) }) },
  // C-MODELS (owner CLI review 2026-10-19 `identity`): no profile is selected in this installation; the text names how to select one.
  IDENTITY_PROFILE_NOT_SELECTED: { category: 'usage', render: (p, l) => ({ message: t('error.IDENTITY_PROFILE_NOT_SELECTED', p, l) }) },
});
