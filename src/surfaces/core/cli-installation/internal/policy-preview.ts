import { formatValue, t, terminalSafeText, type Locale } from '#platform/index.js';

type Grant = { readonly id?: unknown; readonly actions?: unknown; readonly resource?: { readonly kind?: unknown; readonly ids?: unknown }; readonly effect?: unknown; readonly modeEligible?: unknown };
type Assurance = { readonly id?: unknown; readonly subject?: unknown; readonly cells?: unknown; readonly minimum?: unknown };
type Preview = {
  readonly scopeId: string; readonly principal?: { readonly issuer?: unknown; readonly subject?: unknown }; readonly template?: { readonly id?: unknown; readonly version?: unknown };
  readonly planDigest?: unknown; readonly paths?: { readonly policy?: unknown; readonly bindings?: unknown };
  readonly policy: { readonly grants: readonly Grant[]; readonly roles?: unknown; readonly restrictions?: unknown; readonly separationOfDuties?: unknown; readonly approvalAssurance?: unknown };
  readonly bindings?: { readonly bindings?: unknown };
};

const text = (value: unknown) => terminalSafeText(typeof value === 'string' || typeof value === 'number' ? String(value) : '-');
const list = (value: unknown) => Array.isArray(value) ? value.map(text).join(', ') : '-';
const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
const isPreview = (value: unknown): value is Preview => typeof value === 'object' && value !== null && typeof (value as Preview).scopeId === 'string'
  && typeof (value as Preview).policy === 'object' && (value as Preview).policy !== null && Array.isArray((value as Preview).policy.grants);

function effectWord(effect: unknown, locale: Locale): string {
  return effect === 'allow' ? t('cli.init.policyPreview.effect.allow', {}, locale) : effect === 'require-approval' ? t('cli.init.policyPreview.effect.requireApproval', {}, locale)
    : effect === 'deny' ? t('cli.init.policyPreview.effect.deny', {}, locale) : text(effect);
}

/**
 * `deckent init policy --preview` for a person (PRE-5): what would be written and where, every rule in words (effect, actions, resource,
 * ids or all), the approval cards, then the exact apply command and where the full plan is (`--json`, unchanged). Nothing is written by a
 * preview. An answer of another shape is shown as it is (formatValue), never guessed.
 */
export function policyPreviewText(value: unknown, locale: Locale): string {
  if (!isPreview(value)) return formatValue(value);
  const scope = text(value.scopeId), policy = value.policy;
  const rules = policy.grants.map(grant => t('cli.init.policyPreview.rule', { effect: effectWord(grant.effect, locale), id: text(grant.id), actions: list(grant.actions),
    kind: text(grant.resource?.kind), ids: Array.isArray(grant.resource?.ids) ? list(grant.resource.ids) : t('cli.init.policyPreview.all', {}, locale),
    mode: grant.modeEligible === true ? t('cli.init.policyPreview.modeEligible', {}, locale) : '' }, locale));
  const cards = (Array.isArray(policy.approvalAssurance) ? policy.approvalAssurance as readonly Assurance[] : []).map(card => t('cli.init.policyPreview.assurance',
    { id: text(card.id), subject: text(card.subject), cells: list(card.cells), minimum: text(card.minimum) }, locale));
  const digest = typeof value.planDigest === 'string' ? value.planDigest.slice(0, 8) : '-';
  return [
    t('cli.init.policyPreview.head', { scope }, locale),
    t('cli.init.policyPreview.template', { template: text(value.template?.id), version: text(value.template?.version),
      person: `${text(value.principal?.issuer)}/${text(value.principal?.subject)}`, plan: digest }, locale),
    t('cli.init.policyPreview.files', {}, locale),
    t('cli.init.policyPreview.policyFile', { path: text(value.paths?.policy) }, locale),
    t('cli.init.policyPreview.bindingsFile', { path: text(value.paths?.bindings), count: count(value.bindings?.bindings) }, locale),
    t('cli.init.policyPreview.rules', { count: rules.length }, locale), ...rules, ...cards,
    t('cli.init.policyPreview.extra', { restrictions: count(policy.restrictions), sod: count(policy.separationOfDuties), roles: count(policy.roles) }, locale),
    t('cli.init.policyPreview.next', { scope }, locale),
    t('cli.init.policyPreview.json', { scope }, locale),
  ].join('\n');
}
