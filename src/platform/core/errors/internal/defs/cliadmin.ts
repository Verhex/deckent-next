import { plainErrors, type ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `cliadmin` family (i18n `locales/<locale>/cliadmin.json`); texts live in that family. */
export const cliadminErrors: ErrorDefinitions = plainErrors('error.', {
  // BeUser S-04: `deckent audit show <n>` for a number the scope's log does not hold; names it and the list command.
  AUDIT_RECORD_NOT_FOUND: 'usage',
  // Owner CLI review 2026-10-19: `backup verify`/`restore` name why a set cannot be used, before any decryption (exit 78 like the family).
  BACKUP_SET_NOT_FOUND: 'config', BACKUP_SET_UNREADABLE: 'config', BACKUP_PASSPHRASE_REQUIRED: 'config',
  // C-ADMIN (owner CLI review 2026-10-19): verify/restore off a terminal without --set name the listed sets; a terminal that cannot hide typing
  // is its own cause (C-PRIO finding), never "wrong passphrase".
  BACKUP_SET_REQUIRED: 'usage', BACKUP_PASSPHRASE_PROMPT_UNAVAILABLE: 'config',
  // SEC-1 lead note: refused before stdin is read (the join reconciles it with SEC-1's AUTHORITY_WITNESS_REQUIRED at the service).
  SECRET_SET_TERMINAL_REQUIRED: 'error', SECRET_NAME_REQUIRED: 'usage', AUDIT_CHECKPOINT_EXPORT_EMPTY: 'error', AUDIT_CHECKPOINT_EXPORT_EXISTS: 'usage',
  AUDIT_CHECKPOINT_EXPORT_FAILED: 'error',
  // Off a terminal the governed stop built from the live descriptor carries the caller's reason (audited); a person confirms on a card.
  RUNTIME_SHUTDOWN_REASON_REQUIRED: 'usage',
});
