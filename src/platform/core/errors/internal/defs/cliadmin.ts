import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `cliadmin` family (i18n `locales/<locale>/cliadmin.json`); texts live in that family. */
export const cliadminErrors: ErrorDefinitions = Object.freeze({
  // Owner CLI review 2026-10-19: `backup verify`/`restore` name why a set cannot be used, before any decryption (exit 78 like the family).
  BACKUP_SET_NOT_FOUND: { category: 'config', render: (p, l) => ({ message: t('error.BACKUP_SET_NOT_FOUND', p, l) }) },
  BACKUP_SET_UNREADABLE: { category: 'config', render: (p, l) => ({ message: t('error.BACKUP_SET_UNREADABLE', p, l) }) },
  BACKUP_PASSPHRASE_REQUIRED: { category: 'config', render: (p, l) => ({ message: t('error.BACKUP_PASSPHRASE_REQUIRED', p, l) }) },
});
