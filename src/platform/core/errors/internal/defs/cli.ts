import { t } from '#platform/core/i18n/index.js';
import { errorTable, plainErrors, type ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `cli` family (i18n `locales/<locale>/cli.json`); texts live in that family. */
export const cliErrors: ErrorDefinitions = errorTable('cli', {
  // L-KIT scope rule: a state change without `--scope` off a terminal; names the valid scopes, exit 2 (usage), nothing written.
  // An empty list (a folder with no scope yet, `init --yes`) asks for a new name instead of listing "-".
  CLI_SCOPE_REQUIRED: { category: 'usage', render: (p, l) => ({ message: p['scopes'] === '' ? t('error.CLI_SCOPE_REQUIRED.none', p, l) : t('error.CLI_SCOPE_REQUIRED', p, l) }) },
  // BeUser KER-14: an unknown command word under `--json` is one typed envelope on stderr (exit 2), the same text as without it.
  CLI_COMMAND_UNKNOWN: { category: 'usage', render: (p, l) => ({ message: t('cli.unknownCommand', p, l) }) },
}, plainErrors('error.', {
  // L-KIT short ids (git-like prefixes over the `/runs` query).
  CLI_ID_AMBIGUOUS: 'usage', CLI_ID_TOO_SHORT: 'usage', CLI_ID_UNKNOWN: 'error',
  // J2d (owner: `deckent init` is the one command): a scope picker on a terminal in a folder with no installation (no product directory or
  // no policy file) names only the setup command, exit 2 (usage) like the other "nothing here" answers; nothing is written.
  CLI_INSTALLATION_MISSING: 'usage',
  // L-HELP (J1b lead decision): a family called without its action or required argument; names what is missing and the actions, exit 2.
  CLI_ARGUMENT_MISSING: 'usage',
}));
