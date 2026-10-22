import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `clisetup` family (i18n `locales/<locale>/clisetup.json`); texts live in that family. */
export const clisetupErrors: ErrorDefinitions = Object.freeze({
  // C-SETUP: `config set <key>` without a value off a terminal; names the key and what it takes, exit 2, nothing written.
  // CONFIG-PARTIAL-CLI: params partial (time | size) and found when the listed values are partial; the sentence says which limit cut them.
  CLI_CONFIG_VALUE_MISSING: { category: 'usage', render: (p, l) => ({ message: [t('error.CLI_CONFIG_VALUE_MISSING', p, l),
    ...(p['partial'] === 'time' ? [t('error.CLI_CONFIG_VALUE_MISSING.partialTime', p, l)] : p['partial'] === 'size' ? [t('error.CLI_CONFIG_VALUE_MISSING.partialSize', p, l)] : [])].join(' ') }) },
  // C-SETUP: `coding template` without a provider or kind off a terminal; lists the admitted choices, exit 2.
  CLI_CODING_TEMPLATE_CHOICE_MISSING: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_CODING_TEMPLATE_CHOICE_MISSING', p, l) }) },
  // C-SETUP root cause of CODING_TEMPLATE_TOOLCHAIN_REQUIRED on a working installation: the configured image is not the image the admitted
  // profiles run on; names both and the command with an admitted image. Same category as the engine code (configuration, 78).
  CLI_CODING_TEMPLATE_IMAGE_UNADMITTED: { category: 'config', render: (p, l) => ({ message: t('error.CLI_CODING_TEMPLATE_IMAGE_UNADMITTED', p, l) }) },
  // C1 (owner 2026-10-23 Q2): `init registry` / `coding template` asked for `disabled` discovery on a CLI the registry has no verified
  // suppression for (no `disabledArgs`); names the CLI and the explicit `--discovery repository` choice. Configuration, 78; nothing written.
  CODING_DISCOVERY_UNSUPPORTED: { category: 'config', render: (p, l) => ({ message: t('error.CODING_DISCOVERY_UNSUPPORTED', p, l) }) },
  // C-SETUP: `coding prepare` input that is not the preparation document; names the first field that does not fit, exit 2.
  CLI_CODING_PREPARE_FIELD_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_CODING_PREPARE_FIELD_INVALID', p, l) }) },
  // C-SETUP: `operation inspect` of a command this scope has no record of: exit 1, like `run` (review §operation).
  CLI_OPERATION_NOT_FOUND: { category: 'error', render: (p, l) => ({ message: t('error.CLI_OPERATION_NOT_FOUND', p, l) }) },
  // C-SETUP: `operation execute|compensate` input that is not an effect command; names the field (was INVENTORY_QUERY_INVALID), exit 2.
  CLI_OPERATION_INPUT_INVALID: { category: 'usage', render: (p, l) => ({ message: t('error.CLI_OPERATION_INPUT_INVALID', p, l) }) },
});
