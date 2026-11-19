import { delegationWithin, mcpPrincipalRef, type Policy, type VerifiedPrincipal, describePolicyGrants, FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, FIRST_RUN_PROPOSAL_UPGRADE_RULE_IDS, firstRunExecutionRules, policyGrantSchema, type PolicyGrant } from '#domain/index.js';
import { t, terminalRecordText, terminalSafeText, type Locale } from '#platform/index.js';

/** Describe the actual old rules removed by the change, without claiming that every other grant is revoked. */
export function policyExecutionWithdrawalLines(rules: readonly PolicyGrant[], locale: Locale): string[] {
  const removed = rules.filter(rule => [...FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, ...FIRST_RUN_PROPOSAL_UPGRADE_RULE_IDS].some(id => id === rule.id));
  return removed.map(rule => t('policy.aiExecution.withdraw', {
    id: terminalRecordText(rule.id), scopes: rule.scopes === 'all' ? t('policy.aiExecution.allScopes', {}, locale) : rule.scopes.map(terminalRecordText).join('\n') }, locale));
}

/** All-scope selection is separate from every explicit scope ID, including a literal star. */
export function policyExecutionScopeList(scopes: readonly string[], allScopes: boolean, locale: Locale): string {
  const params = { count: scopes.length, scopes: scopes.map(terminalRecordText).join('\n') };
  return [...(allScopes ? [t('policy.aiExecution.allScopes', {}, locale)] : []),
    ...(!allScopes || scopes.length ? [allScopes ? t('policy.aiExecution.rollbackNamedScopes', params, locale) : t('policy.aiExecution.rollbackScopes', params, locale)] : [])].join('\n');
}

/** The notice checks actual cells against the trusted planner's scopes; an arbitrary card defaults to its one scope. */
export function policyExecutionLines(rules: readonly unknown[], scope: string, locale: Locale, heldRules: readonly unknown[] = [], form: 'full' | 'short' = 'full', plannedScopes: readonly string[] = [scope]): string[] {
  const ids: readonly string[] = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS;
  const parse = (values: readonly unknown[]) => values.flatMap(value => { const parsed = policyGrantSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
  const grants = parse(rules).filter(rule => ids.includes(rule.id)), held = parse(heldRules);
  const actors = new Map(grants.flatMap(rule => rule.principals === 'all' ? [] : rule.principals.filter(actor => actor.issuer.endsWith('/mcp') && actor.issuer.length > '/mcp'.length).map(actor => [JSON.stringify(actor), actor] as const)));
  const same = (a: PolicyGrant, b: PolicyGrant) => JSON.stringify(policyGrantSchema.parse(a)) === JSON.stringify(policyGrantSchema.parse(b));
  return [...actors.values()].flatMap(actor => {
    const person = { issuer: actor.issuer.slice(0, -'/mcp'.length), subject: actor.subject };
    const expected = firstRunExecutionRules([], person, plannedScopes).wanted;
    const named = grants.filter(rule => rule.principals !== 'all' && rule.principals.some(value => value.issuer === actor.issuer && value.subject === actor.subject));
    // A genuine partial upgrade keeps its notice only when existing effective grants cover every omitted cell.
    const uncovered = firstRunExecutionRules(held, person, plannedScopes).wanted;
    if (!expected.length || named.some(rule => !expected.some(want => same(rule, want)))
      || !expected.every(want => named.some(rule => same(rule, want)) || held.some(rule => same(rule, want)) || !uncovered.some(rule => rule.id === want.id))) return [];
    const params = { actor: terminalSafeText(`${actor.issuer}/${actor.subject}`), scope: terminalSafeText(scope), scopes: terminalSafeText(plannedScopes.join(', ')) };
    return [form === 'full' ? t('policy.aiExecution.preview', params, locale) : t('policy.aiExecution.previewShort', params, locale)];
  });
}

/** Read-only coverage of the six standing actions. A restriction on even one id prevents scope-wide coverage. */
export function executionPermissionCoverage(document: Policy, principal: VerifiedPrincipal, scopeId: string) {
  const actor = mcpPrincipalRef(principal), rules = firstRunExecutionRules([], principal, [scopeId]).wanted;
  const cells = rules.flatMap(rule => rule.actions === 'all' ? [] : rule.actions.map(action =>
    delegationWithin(document, actor, [{ ...rule, actions: [action] }])));
  if (!cells.length) return null;
  return { actor: `${actor.issuer}/${actor.subject}`, total: cells.length, allowed: cells.filter(cell => cell.ok).length,
    restricted: cells.some(cell => !cell.ok && cell.reason !== 'no-grant') };
}

/** Installer previews share the domain description producer through the existing approval presentation seam. */
export function policyGrantDescription(rules: readonly unknown[]): string | null { return describePolicyGrants(rules); }
