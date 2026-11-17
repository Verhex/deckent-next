import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, firstRunExecutionRules, policyGrantSchema, type PolicyGrant } from '#domain/index.js';
import { t, terminalSafeText, type Locale } from '#platform/index.js';

/** The standing grant's breadth accompanies the actual cells, on fresh-install and upgrade previews. */
export function policyExecutionLines(rules: readonly unknown[], scope: string, locale: Locale, heldRules: readonly unknown[] = [], form: 'full' | 'short' = 'full'): string[] {
  const ids: readonly string[] = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS;
  const parse = (values: readonly unknown[]) => values.flatMap(value => { const parsed = policyGrantSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
  const grants = parse(rules).filter(rule => ids.includes(rule.id)), held = parse(heldRules);
  const actors = new Map(grants.flatMap(rule => rule.principals === 'all' ? [] : rule.principals.filter(actor => actor.issuer.endsWith('/mcp') && actor.issuer.length > '/mcp'.length).map(actor => [JSON.stringify(actor), actor] as const)));
  const same = (a: PolicyGrant, b: PolicyGrant) => JSON.stringify(policyGrantSchema.parse(a)) === JSON.stringify(policyGrantSchema.parse(b));
  return [...actors.values()].flatMap(actor => {
    const person = { issuer: actor.issuer.slice(0, -'/mcp'.length), subject: actor.subject };
    const expected = firstRunExecutionRules([], person, [scope]).wanted;
    const named = grants.filter(rule => rule.principals !== 'all' && rule.principals.some(value => value.issuer === actor.issuer && value.subject === actor.subject));
    // A genuine partial upgrade keeps its notice only when existing effective grants cover every omitted cell.
    const uncovered = firstRunExecutionRules(held, person, [scope]).wanted;
    if (!expected.length || named.some(rule => !expected.some(want => same(rule, want)))
      || !expected.every(want => named.some(rule => same(rule, want)) || held.some(rule => same(rule, want)) || !uncovered.some(rule => rule.id === want.id))) return [];
    const params = { actor: terminalSafeText(`${actor.issuer}/${actor.subject}`), scope: terminalSafeText(scope) };
    return [form === 'full' ? t('policy.aiExecution.preview', params, locale) : t('policy.aiExecution.previewShort', params, locale)];
  });
}
