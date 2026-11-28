import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS } from '#domain/index.js';
import { t, terminalSafeText, type Locale } from '#platform/index.js';
import { askCliCard, cliMode, executionGrantDecision } from '#surfaces/core/cli-human/index.js';
import type { SetupCommandContext } from './contract.js';

export type ExecutionPermissionNotice = Readonly<{ key: string; params: Readonly<Record<string, string>>; interrupted?: boolean }>;
/** Surface-local offer only: the existing preview and witnessed apply own all authority and persistence. */
export async function offerExecutionPermission(context: SetupCommandContext, root: string, scopeId: string, locale: Locale, interactive: boolean): Promise<ExecutionPermissionNotice> {
  const env = context.env ?? process.env, stdin = context.stdin ?? process.stdin;
  const command = `deckent policy upgrade --template current --only ai-execution --scope ${scopeId} --preview`;
  const notice = (suffix: string, params: Record<string, string> = {}): ExecutionPermissionNotice => ({ key: `setup.aiExecution.${suffix}`, params: { command: suffix === 'unknown' ? `deckent policy status --scope ${scopeId}` : command, ...params } });
  if (!context.upgradePolicyTemplate) return notice('unknown');
  const request = { only: 'ai-execution' as const, reason: t('cli.policy.upgrade.reason', {}, locale) };
  try {
    const preview = await (context.previewSetupExecutionPermission?.(root, scopeId, { env })
      ?? context.upgradePolicyTemplate(root, scopeId, { ...request, mode: 'preview' }, { env }));
    if (preview.status === 'current' && !(preview.conflicts?.length)) return notice('covered', { sources: [...new Set([...(preview.held ?? []), ...(preview.covered ?? []).map(item => item.heldBy)])].join(', ') || scopeId });
    const lacking = (items: readonly string[]) => items.map(item => item === 'policy-administer' ? t('cli.policy.upgrade.missing.policyAdminister', {}, locale) : item === 'approval-decide' ? t('cli.policy.upgrade.missing.approvalDecide', {}, locale) : item === 'lockout' ? t('cli.policy.upgrade.missing.lockout', {}, locale) : t('cli.policy.upgrade.missing.delegation', {}, locale));
    const missing = lacking(preview.missing);
    if (preview.status !== 'preview' || !preview.rules?.length || missing.length || preview.conflicts?.length) return notice('blocked', { reason: [...missing, ...(preview.conflicts ?? []), ...(preview.reason ? [preview.reason] : [])].map(terminalSafeText).join(', ') || preview.status });
    if (!interactive || cliMode(context).mode !== 'interactive') return notice(cliMode(context).reason === 'agent' ? 'personRequired' : 'notAdded');
    const scopes = preview.executionScopes ?? [scopeId], actors = [...new Set(preview.rules.flatMap(rule => rule.principals && rule.principals !== 'all' ? rule.principals.map(actor => `${actor.issuer}/${actor.subject}`) : []))];
    const held = [...(preview.executionContext ?? []).flatMap(rule => typeof rule === 'object' && rule !== null && 'id' in rule && typeof rule.id === 'string' && FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.some(id => id === rule.id) ? [rule.id] : []), ...(preview.covered ?? []).map(item => `${item.ruleId}: ${item.heldBy}`)];
    const decision = executionGrantDecision(preview.executionHistory, locale);
    const body = [...(held.length ? [] : [t('setup.aiExecution.absent', {}, locale)]),
      ...(decision.reason ? [decision.reason] : []),
      t('setup.aiExecution.body', { actor: actors.join(', '), scopes: scopes.join(', ') }, locale),
      t('setup.aiExecution.change', { changes: preview.rules.map(rule => rule.id).join(', '), held: held.join(', ') || '-', conflicts: preview.conflicts?.join(', ') || '-' }, locale),
      `deckent policy upgrade --template current --scope ${scopeId} --rollback`, t('setup.aiExecution.revoke', { scopes: scopes.join(', ') }, locale),
      preview.revision, ...(preview.summary ?? '').split(/\r?\n/u)];
    const answer = await askCliCard({ title: t('setup.aiExecution.title', {}, locale), body, hints: t('setup.aiExecution.hints', {}, locale),
      initial: decision.initial, options: [
        { id: 'grant', label: t('setup.aiExecution.grant', {}, locale), role: 'yes' },
        { id: 'not-now', label: t('setup.aiExecution.notNow', {}, locale), role: 'no' }] },
      { locale, env, stdin, stdout: context.stdout ?? process.stdout, ...(context.signal ? { signal: context.signal } : {}), agentEnvironment: context.agentEnvironment });
    if (stdin.readableEnded || stdin.destroyed) return { ...notice('interrupted'), interrupted: true };
    if (context.signal?.aborted) return notice('skipped');
    if (answer !== 'grant') return notice(answer === null ? 'skipped' : 'notAdded');
    const applied = await context.upgradePolicyTemplate(root, scopeId, { ...request, mode: 'apply', expect: preview.revision }, { env });
    if (applied.status === 'conflict') return notice('drift');
    if (applied.status !== 'upgraded') return notice(applied.status === 'refused' ? 'blocked' : 'unknown', { reason: [...lacking(applied.missing), ...(applied.conflicts ?? []), applied.reason ?? ''].join(', ') });
    const fresh = await context.upgradePolicyTemplate(root, scopeId, { ...request, mode: 'preview' }, { env });
    return fresh.status === 'current' && !fresh.conflicts?.length ? notice('added', { scopes: scopes.join(', ') }) : notice('unknown');
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'AUTHORITY_WITNESS_REQUIRED' || code === 'APPROVAL_INTERACTIVE_REQUIRED' || code === 'TERMINAL_TTY_REQUIRED') return notice('personRequired');
    return notice(code === 'POLICY_CONFLICT' || code === 'AUTHORITY_CONFLICT' ? 'drift' : 'unknown');
  }
}
