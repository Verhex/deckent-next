import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `cliadmin` family (i18n `locales/<locale>/cliadmin.json`); texts live in that family. */
export const cliadminErrors: ErrorDefinitions = Object.freeze({
  // Owner CLI review 2026-10-19: `backup verify`/`restore` name why a set cannot be used, before any decryption (exit 78 like the family).
  BACKUP_SET_NOT_FOUND: { category: 'config', render: (p, l) => ({ message: t('error.BACKUP_SET_NOT_FOUND', p, l) }) },
  BACKUP_SET_UNREADABLE: { category: 'config', render: (p, l) => ({ message: t('error.BACKUP_SET_UNREADABLE', p, l) }) },
  BACKUP_PASSPHRASE_REQUIRED: { category: 'config', render: (p, l) => ({ message: t('error.BACKUP_PASSPHRASE_REQUIRED', p, l) }) },
  // C-ADMIN (owner CLI review 2026-10-19): verify/restore off a terminal without --set name the listed sets; a terminal that cannot hide typing
  // is its own cause (C-PRIO finding), never "wrong passphrase".
  BACKUP_SET_REQUIRED: { category: 'usage', render: (p, l) => ({ message: t('error.BACKUP_SET_REQUIRED', p, l) }) },
  BACKUP_PASSPHRASE_PROMPT_UNAVAILABLE: { category: 'config', render: (p, l) => ({ message: t('error.BACKUP_PASSPHRASE_PROMPT_UNAVAILABLE', p, l) }) },
  // SEC-1 lead note: refused before stdin is read (the join reconciles it with SEC-1's AUTHORITY_WITNESS_REQUIRED at the service).
  SECRET_SET_TERMINAL_REQUIRED: { category: 'error', render: (p, l) => ({ message: t('error.SECRET_SET_TERMINAL_REQUIRED', p, l) }) },
  SECRET_NAME_REQUIRED: { category: 'usage', render: (p, l) => ({ message: t('error.SECRET_NAME_REQUIRED', p, l) }) },
  AUDIT_CHECKPOINT_EXPORT_EMPTY: { category: 'error', render: (p, l) => ({ message: t('error.AUDIT_CHECKPOINT_EXPORT_EMPTY', p, l) }) },
  AUDIT_CHECKPOINT_EXPORT_EXISTS: { category: 'usage', render: (p, l) => ({ message: t('error.AUDIT_CHECKPOINT_EXPORT_EXISTS', p, l) }) },
  AUDIT_CHECKPOINT_EXPORT_FAILED: { category: 'error', render: (p, l) => ({ message: t('error.AUDIT_CHECKPOINT_EXPORT_FAILED', p, l) }) },
  // Off a terminal the governed stop built from the live descriptor carries the caller's reason (audited); a person confirms on a card.
  RUNTIME_SHUTDOWN_REASON_REQUIRED: { category: 'usage', render: (p, l) => ({ message: t('error.RUNTIME_SHUTDOWN_REASON_REQUIRED', p, l) }) },
});
