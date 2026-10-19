import { t, type Locale } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
const problem = (id: unknown, locale: Locale) => id === 'missing' ? t('error.CLI_INPUT_FIELD_INVALID.missing', {}, locale)
  : id === 'unknown' ? t('error.CLI_INPUT_FIELD_INVALID.unknown', {}, locale) : t('error.CLI_INPUT_FIELD_INVALID.invalid', {}, locale);
/** Error codes owned by the `cliapproval` family (i18n `locales/<locale>/cliapproval.json`); texts live in that family. */
export const cliapprovalErrors: ErrorDefinitions = Object.freeze({
  // C-APPROVE: JSON input (`approval`, `decide`) checked against the application's own schema; names the first wrong field, exit 2 (usage).
  CLI_INPUT_FIELD_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_INPUT_FIELD_INVALID', { ...p,
    problem: problem(p['problem'], l) }, l) }) },
  // C-APPROVE: `policy grants --all` waits for its grantable read action (v13, I-POL); only the caller's own grants until then.
  CLI_POLICY_GRANTS_ALL_UNAVAILABLE: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_POLICY_GRANTS_ALL_UNAVAILABLE', p, l) }) },
});
