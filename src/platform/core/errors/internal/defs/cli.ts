import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `cli` family (i18n `locales/<locale>/cli.json`); texts live in that family. */
export const cliErrors: ErrorDefinitions = Object.freeze({
  // L-KIT scope rule: a state change without `--scope` off a terminal; names the valid scopes, exit 2 (usage), nothing written.
  CLI_SCOPE_REQUIRED: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_SCOPE_REQUIRED', p, l) }) },
  // L-KIT short ids (git-like prefixes over the `/runs` query).
  CLI_ID_AMBIGUOUS: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_ID_AMBIGUOUS', p, l) }) },
  CLI_ID_TOO_SHORT: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_ID_TOO_SHORT', p, l) }) },
  CLI_ID_UNKNOWN: { category: 'error', render: (p, l) => ({ message: t('error.CLI_ID_UNKNOWN', p, l) }) },
  // J2d (owner: `deckent init` is the one command): a scope picker on a terminal in a folder with no installation (no product directory or
  // no policy file) names only the setup command, exit 2 (usage) like the other "nothing here" answers; nothing is written.
  CLI_INSTALLATION_MISSING: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_INSTALLATION_MISSING', p, l) }) },
  // L-HELP (J1b lead decision): a family called without its action or required argument; names what is missing and the actions, exit 2.
  CLI_ARGUMENT_MISSING: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_ARGUMENT_MISSING', p, l) }) },
});
