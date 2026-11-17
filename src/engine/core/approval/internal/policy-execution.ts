import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS } from '#domain/index.js';
import { t, terminalSafeText, type Locale } from '#platform/index.js';

/** The standing grant's breadth accompanies the actual cells, on fresh-install and upgrade previews. */
export function policyExecutionLines(rules: readonly unknown[], scope: string, locale: Locale): string[] {
  const ids: readonly string[] = FIRST_RUN_CURRENT_UPGRADE_RULE_IDS;
  const grants = rules.filter((value): value is { id: string; principals: readonly { issuer: string; subject: string }[] } => {
    const rule = value as { id?: string; principals?: unknown } | null;
    return Boolean(rule && ids.includes(rule.id ?? '') && Array.isArray(rule.principals));
  });
  const actors = [...new Set(grants.flatMap(rule => rule.principals.map(person => terminalSafeText(`${person.issuer}/${person.subject}`))))];
  return actors.map(actor => t('policy.aiExecution.preview', { actor, scope: terminalSafeText(scope) }, locale));
}
