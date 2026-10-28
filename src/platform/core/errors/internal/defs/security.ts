import { t } from '#platform/core/i18n/index.js';
import type { ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `security` family (i18n `locales/<locale>/security.json`); texts live in that family. */
export const securityErrors: ErrorDefinitions = Object.freeze({
  // SEC-3 (F33): config issue reasons; the text names no reference, secret name or value.
  SECRET_REFERENCE_PROJECT_LAYER: { category: 'config', render: (p, l) => ({ message: t('error.SECRET_REFERENCE_PROJECT_LAYER', p, l) }) },
  SECRET_REFERENCE_LEAVES_HOST: { category: 'config', render: (p, l) => ({ message: t('error.SECRET_REFERENCE_LEAVES_HOST', p, l) }) },
  // SEC-1 (A48-D5, F32): an authority write without the service-held terminal witness, or from the MCP actor; nothing was written.
  // alpha.55.1: a protected config root (`config set|unset <key>` on any human surface) names the setting and the person's own terminal.
  // S-05 (2026-10-27): `models.create-budget|revise-budget|reconcile-spending` (surface) and `manageProviderSpend` (runtime service) name the spend command.
  AUTHORITY_WITNESS_REQUIRED: { category: 'error', render: (p, l) => {
    const config = typeof p['operation'] === 'string' ? /^config (?:set|unset) (\S+)$/u.exec(p['operation']) : null;
    // S-05: a budget change or held-spend reconciliation names the command to run at the person's own terminal.
    const spend = p['operation'] === 'manageProviderSpend' ? ['', 'revise-budget'] : typeof p['operation'] === 'string'
      ? /^models\.(create-budget|revise-budget|reconcile-spending)$/u.exec(p['operation']) : null;
    return { message: config ? t('security.witness.config', { key: config[1]! }, l) : spend ? t('security.witness.spending', { action: spend[1]! }, l) : p['operation'] === 'uninstall' ? t('security.witness.uninstall', {}, l) : t('error.AUTHORITY_WITNESS_REQUIRED', p, l) };
  } },
  // SEC-2 (F29, owner A48-D6): a trust record from before the move is re-approved on its card only; nothing is asked, audited or written.
  MCP_TRUST_NEEDS_CARD: { category: 'usage', render: (p, l) => ({ message: t('error.MCP_TRUST_NEEDS_CARD', p, l) }) },
});
