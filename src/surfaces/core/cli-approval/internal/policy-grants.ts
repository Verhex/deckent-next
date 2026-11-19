import { FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, policyGrantSchema } from '#domain/index.js';
import { policyExecutionLines, policyExecutionScopeList } from '#engine/index.js';
import { createInterface } from 'node:readline/promises';
import type { PolicyTemplateUpgradePort, PolicyUpgradeView } from '#surfaces/core/cli-terminal/index.js';
import { optionalField, ErrorRegistry, emit, loadConfig, t, type Locale } from '#platform/index.js';
import { askCliCard, cliMode, executionGrantDecision } from '#surfaces/core/cli-human/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import type { ApprovalCommandContext } from './context.js';
import { policyMcpCommand } from './policy-mcp.js';
import { policyDelegationsCommand } from './policy-delegations.js';
import { policyStatusCommand } from './policy-summary.js';
import { policyGrantsAll } from './policy-grants-all.js';
import { policyRecoveryCommand } from './recovery.js';

/** A persisted standing approval as the CLI shows it (the engine's view; the surface owns no rule of its own). */
interface StandingGrantRow { readonly id: string; readonly key: string; readonly tool: string; readonly kind: 'command' | 'directory' | 'unknown'; readonly text: string }
export type StandingGrantsHandler = (root: string, scopeId: string, options: { readonly env: NodeJS.ProcessEnv }) => Promise<readonly StandingGrantRow[]>;
export type StandingRevokeHandler = (root: string, input: { readonly scopeId: string; readonly id: string; readonly reason: string; readonly confirm: (grant: StandingGrantRow) => Promise<boolean> },
  options: { readonly env: NodeJS.ProcessEnv }) => Promise<{ readonly revoked: boolean; readonly grant: StandingGrantRow | null }>;

/** The governed current first-run upgrade: the engine's result, which the surface only words (one shape with `/policy`'s AI proposals row). */
export type PolicyUpgradeHandler = PolicyTemplateUpgradePort;

/**
 * `deckent policy grants [--mine] [--scope <id>] [--json]` lists the caller's own persisted standing approvals (read-only); `--all [--after <mark>]` everyone's (CA-1);
 * `deckent policy revoke <id> [--scope <id>] [--yes]` removes one through the same `policy.administer@1` operation that created it.
 * A revoke asks `y/N` on a terminal; without one it needs an explicit `--yes`.
 */
export async function policyGrantsCommand(argv: readonly string[], context: ApprovalCommandContext): Promise<void> {
  if (['delegations', 'delegate', 'undelegate'].includes(argv[1] ?? '')) return policyDelegationsCommand(argv, context);
  if (argv[1] === 'status' || argv[1] === 'show') return policyStatusCommand(argv, context);
  if (argv[1] === 'mcp') return policyMcpCommand(argv, context);
  if (argv[1] === 'upgrade') return policyUpgradeCommand(argv, context);
  if (argv[1] === 'recovery') return policyRecoveryCommand(argv, context);
  const action = argv[1]; let json = false, mine = false, all = false, yes = false, scope: string | undefined, language: string | undefined, id: string | undefined, after: string | undefined;
  if (action !== 'grants' && action !== 'revoke') throw ErrorRegistry.createError('CLI_USAGE');
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--json' && !json) json = true;
    else if (flag === '--mine' && !mine && !all && action === 'grants') mine = true;
    else if (flag === '--all' && !all && !mine && action === 'grants') all = true;
    else if (flag === '--yes' && !yes && action === 'revoke') yes = true;
    else if ((flag === '--scope' || flag === '--lang' || (flag === '--after' && action === 'grants')) && (flag === '--scope' ? scope : flag === '--lang' ? language : after) === undefined) {
      const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      if (flag === '--scope') scope = value; else if (flag === '--lang') language = value; else after = value;
    } else if (!flag.startsWith('-') && action === 'revoke' && id === undefined) id = flag;
    else throw ErrorRegistry.createError('CLI_USAGE');
  }
  // C-APPROVE: `grants` lists the caller's own grants by default (`--mine` kept). CA-1: everyone's grants (`--all`) need the grantable read action
  // `policy inspect-standing-grants` (v13 first-run: the founding admin); the policy decides, never a hard-coded admin check. `--after` pages `--all`.
  if ((action === 'revoke' && !id) || (after !== undefined && !all)) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, options = { env };
  const config = await loadConfig(root, options);
  const locale = commandLocale(context, language);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  const configured = (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId;
  const scopeId = scope ?? (typeof configured === 'string' ? configured : undefined);
  if (!scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  if (all) return policyGrantsAll(context, { root, scopeId, flagged: scope !== undefined, json, locale, env, ...optionalField('after', after) });
  const row = (grant: StandingGrantRow) => t('cli.policy.grants.row', { id: grant.id, tool: grant.tool, kind: grant.kind, text: grant.text }, locale);
  if (action === 'grants') {
    if (!context.listStandingGrants) throw ErrorRegistry.createError('CLI_USAGE');
    const grants = await context.listStandingGrants(root, scopeId, options);
    emit(grants, { ...sinks, json, render: data => data.length === 0 ? t('cli.policy.grants.none', {}, locale) : [t('cli.policy.grants.header', { count: data.length }, locale), ...data.map(row)].join('\n') });
    return;
  }
  if (!context.revokeStandingGrant) throw ErrorRegistry.createError('CLI_USAGE');
  const stdin = context.stdin ?? process.stdin;
  const confirm = async (grant: StandingGrantRow) => {
    if (yes) return true;
    if (!stdin.isTTY) return false;
    const rl = createInterface({ input: stdin, output: process.stderr });
    try { return /^y(es)?$/iu.test((await rl.question(t('cli.policy.revoke.confirm', { row: row(grant) }, locale))).trim()); } finally { rl.close(); }
  };
  const result = await context.revokeStandingGrant(root, { scopeId, id: id!, reason: t('cli.policy.revoke.reason', {}, locale), confirm }, options);
  emit(result, { ...sinks, json, render: data => !data.grant ? t('cli.policy.revoke.notFound', { id: id! }, locale)
    : data.revoked ? t('cli.policy.revoke.done', { id: id! }, locale) : t('cli.policy.revoke.kept', { id: id! }, locale) });
}

/**
 * `deckent policy upgrade --template current`: preview writes nothing; apply and rollback use
 * `policy.administer@1` (I2, audit, archive). The deprecated `v5` selector uses the same current plan.
 */
async function policyUpgradeCommand(argv: readonly string[], context: ApprovalCommandContext): Promise<void> {
  let json = false, template: string | undefined, scope: string | undefined, language: string | undefined, expect: string | undefined, mode: 'preview' | 'apply' | 'rollback' | undefined, previewRollback = false, only: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--json' && !json) json = true;
    else if (!previewRollback && (flag === '--preview' && mode === 'rollback' || flag === '--rollback' && mode === 'preview')) { mode = 'preview'; previewRollback = true; }
    else if ((flag === '--preview' || flag === '--apply' || flag === '--rollback') && mode === undefined) mode = flag.slice(2) as 'preview' | 'apply' | 'rollback';
    else if (['--template', '--scope', '--lang', '--expect', '--only'].includes(flag)) {
      const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      if (flag === '--template' && template === undefined) template = value; else if (flag === '--scope' && scope === undefined) scope = value;
      else if (flag === '--lang' && language === undefined) language = value; else if (flag === '--expect' && expect === undefined) expect = value;
      else if (flag === '--only' && only === undefined) only = value;
      else throw ErrorRegistry.createError('CLI_USAGE');
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  // The proposal family remains v20 for preview, apply and rollback; the default rollback selects v21 execution.
  if ((template !== 'current' && template !== 'v5') || (expect !== undefined && mode !== 'apply' && mode !== 'rollback') || (only !== undefined && only !== 'ai-proposals' && only !== 'ai-execution') || !context.upgradePolicyTemplate) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, config = await loadConfig(root, { env });
  const locale = commandLocale(context, language);
  const configured = (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId;
  const scopeId = scope ?? (typeof configured === 'string' ? configured : undefined);
  if (!scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  if (template === 'v5') (context.stderr ?? process.stderr).write(`${t('cli.policy.upgrade.deprecated', { scope: scopeId }, locale)}\n`);
  const request = { reason: t('cli.policy.upgrade.reason', {}, locale), ...(expect ? { expect } : {}), ...(only ? { only: only as 'ai-proposals' | 'ai-execution' } : {}) };
  const invoke = async () => {
    if (mode === 'apply' && only !== 'ai-proposals' && !json && cliMode(context).mode === 'interactive') {
      const read = context.previewPersonPolicyUpgrade ?? context.upgradePolicyTemplate!;
      const preview = await read(root, scopeId, { ...request, mode: 'preview' }, { env });
      if (expect && expect !== preview.revision) return { ...preview, status: 'conflict', reason: 'revision-changed', rules: [], summary: null, conflicts: [], covered: [] };
      if (preview.status !== 'preview') return preview;
      const rules = preview.rules ?? [], execution = rules.filter(rule => FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.some(id => id === rule.id));
      if (!rules.length) return { ...preview, status: 'current' };
      if (execution.length) {
        if (preview.missing.length) return { ...preview, status: 'refused' };
        const mixed = execution.length !== rules.length, decision = executionGrantDecision(preview.executionHistory, locale, mixed);
        const selections = rules.flatMap(rule => {
          const grant = policyGrantSchema.safeParse(rule);
          return grant.success ? [grant.data.scopes] : [];
        });
        const scopes = [...new Set(selections.flatMap(selection => selection === 'all' ? [] : selection))];
        const held = [...(preview.covered ?? []).map(item => `${item.ruleId}: ${item.heldBy}`),
          ...(preview.executionContext ?? []).flatMap(rule => typeof rule === 'object' && rule !== null && 'id' in rule &&
            typeof rule.id === 'string' && !preview.conflicts?.includes(rule.id) && FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.some(id => id === rule.id) ? [rule.id] : [])];
        const answer = await askCliCard({
          title: mixed ? t('policy.aiExecution.applyTitle', {}, locale) : t('setup.aiExecution.title', {}, locale), initial: decision.initial,
          body: [...(decision.reason ? [decision.reason] : []),
            ...policyExecutionLines(rules, scopeId, locale, preview.executionContext, 'full', preview.executionScopes),
            ...(preview.summary ?? '').split('\n'), ...policyExecutionScopeList(selections.length ? scopes : preview.executionScopes ?? [scopeId], selections.includes('all'), locale).split('\n'),
            ...(held.length ? [t('policy.aiExecution.covered', { grants: held.join(', ') }, locale)] : []),
            ...(preview.conflicts?.length ? [t('cli.policy.upgrade.conflicts', { ids: preview.conflicts.join(', ') }, locale)] : []),
            preview.revision, `deckent policy upgrade --template current --scope ${scopeId}${only ? ` --only ${only}` : ''} --preview`],
          hints: t('setup.aiExecution.hints', {}, locale), options: [
            { id: 'grant', label: mixed ? t('policy.aiExecution.applyYes', {}, locale) : t('setup.aiExecution.grant', {}, locale), role: 'yes' },
            { id: 'not-now', label: mixed ? t('policy.aiExecution.applyNo', {}, locale) : t('setup.aiExecution.notNow', {}, locale), role: 'no' }] },
        { ...context, locale, env });
        if (answer !== 'grant') return { ...preview, status: 'cancelled', rules: [], summary: null, covered: [], conflicts: [] };
      }
      // Even a non-execution plan can widen between read and write. Never publish that unseen replacement.
      return context.upgradePolicyTemplate!(root, scopeId, { ...request, mode, expect: preview.revision }, { env });
    }
    if (mode === 'rollback' && !json && cliMode(context).mode === 'interactive') {
      const preview = await context.upgradePolicyTemplate!(root, scopeId, { ...request, mode: 'preview', previewRollback: true }, { env });
      if (preview.status !== 'preview') return preview;
      const scopes = preview.executionScopeSelection?.ids ?? preview.executionScopes ?? [];
      (context.stdout ?? process.stdout).write(`${policyExecutionScopeList(scopes, preview.executionScopeSelection?.all === true, locale)}\n`);
      const answer = await askCliCard({ title: t('policy.aiExecution.rollbackTitle', {}, locale), body: (preview.summary ?? '').split('\n'),
        initial: 'no', options: [{ id: 'yes', label: t('policy.aiExecution.rollbackYes', {}, locale), role: 'yes' },
          { id: 'no', label: t('policy.aiExecution.rollbackNo', {}, locale), role: 'no' }] },
      { locale, env, stdin: context.stdin ?? process.stdin, stdout: context.stdout ?? process.stdout, ...(context.signal ? { signal: context.signal } : {}) });
      if (answer !== 'yes') return { ...preview, status: 'cancelled', summary: null, rules: [] };
      return context.upgradePolicyTemplate!(root, scopeId, { ...request, mode: 'rollback', expect: preview.revision }, { env });
    }
    return context.upgradePolicyTemplate!(root, scopeId, { ...request, mode: mode ?? 'preview', ...(previewRollback ? { previewRollback: true } : {}) }, { env });
  };
  const result = await invoke();
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  const missing = (view: PolicyUpgradeView) => view.missing.map(item => item === 'policy-administer' ? t('cli.policy.upgrade.missing.policyAdminister', {}, locale)
    : item === 'approval-decide' ? t('cli.policy.upgrade.missing.approvalDecide', {}, locale) : item === 'lockout' ? t('cli.policy.upgrade.missing.lockout', {}, locale)
    : t('cli.policy.upgrade.missing.delegation', {}, locale));
  emit(result, { ...sinks, json, render: view => {
    const head = view.status === 'cancelled' ? (mode === 'apply' ? t('cli.init.policyModes.cancelled', {}, locale) : t('policy.aiExecution.rollbackKept', {}, locale)) : view.status === 'preview' && previewRollback ? t('policy.aiExecution.rollbackPreview', { revision: view.revision }, locale) : view.status === 'preview' ? t('policy.aiExecution.upgradePreview', { revision: view.revision, scope: scopeId, selector: only ? ` --only ${only}` : '' }, locale)
      : view.status === 'upgraded' ? t('cli.policy.upgrade.upgraded', { scope: scopeId }, locale) : view.status === 'current' ? t('cli.policy.upgrade.current', {}, locale)
      : view.status === 'refused' ? t('cli.policy.upgrade.refused', {}, locale) : view.status === 'conflict' ? t('cli.policy.upgrade.conflict', { revision: view.revision }, locale)
      : view.status === 'rolled-back' ? t('cli.policy.upgrade.rolledBack', { ids: view.reason ?? '-' }, locale)
      // J3: a fresh first-run install has no upgrade to undo; a rollback without archived history is refused — neither is "not a first-run policy".
      : view.status === 'nothing-to-roll-back' ? view.reason === 'no-upgrade-recorded' ? t('cli.policy.upgrade.noUpgradeRecorded', { scope: scopeId }, locale) : t('cli.policy.upgrade.nothing', {}, locale)
      : view.reason === 'history-unavailable' ? t('cli.policy.upgrade.historyMissing', { scope: scopeId }, locale)
      : t('cli.policy.upgrade.unavailable', { reason: upgradeReason(view.reason, locale) }, locale);
    // A preview that would be refused says so before anything is tried.
    const lacking = missing(view), lack = view.status === 'preview' && lacking.length ? [t('cli.policy.upgrade.wouldRefuse', {}, locale), ...lacking] : view.status === 'refused' ? lacking : [];
    return [head, ...((view.status === 'rolled-back' || previewRollback) && view.executionScopes ? [policyExecutionScopeList(view.executionScopeSelection?.ids ?? view.executionScopes, view.executionScopeSelection?.all === true, locale)] : []), ...(previewRollback ? [] : policyExecutionLines(view.rules ?? [], scopeId, locale, view.executionContext, 'full', view.executionScopes)), ...(view.covered?.length ? [t('policy.aiExecution.covered', { grants: [...new Set(view.covered.map(item => item.heldBy))].join(', ') }, locale)] : []), ...(view.conflicts?.length ? [t('cli.policy.upgrade.conflicts', { ids: view.conflicts.join(', ') }, locale)] : []), ...(view.summary ? [view.summary] : []), ...lack].join('\n');
  } });
}

/** The engine's reason id for an unavailable first-run upgrade, in words (`not-first-run` → "elle kurulmuş politika"); an unknown id stays visible. */
const upgradeReason = (reason: string | null, locale: Locale) => reason === 'not-first-run' ? t('cli.policy.upgrade.reason.notFirstRun', {}, locale)
  : reason === 'not-this-person' ? t('cli.policy.upgrade.reason.notThisPerson', {}, locale) : reason === 'invalid' ? t('cli.policy.upgrade.reason.invalid', {}, locale) : reason ?? '-';
