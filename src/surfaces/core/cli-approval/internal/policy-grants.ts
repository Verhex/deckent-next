import { createInterface } from 'node:readline/promises';
import { ErrorRegistry, emit, loadConfig, t, type Locale } from '#platform/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import type { ApprovalCommandContext } from './context.js';
import { policyMcpCommand } from './policy-mcp.js';
import { policyDelegationsCommand } from './policy-delegations.js';
import { policyStatusCommand } from './policy-summary.js';
import { policyGrantsAll } from './policy-grants-all.js';
import { policyRecoveryCommand } from './recovery.js';

/** A persisted standing approval as the CLI shows it (the engine's view; the surface owns no rule of its own). */
export interface StandingGrantRow { readonly id: string; readonly key: string; readonly tool: string; readonly kind: 'command' | 'directory' | 'unknown'; readonly text: string }
export type StandingGrantsHandler = (root: string, scopeId: string, options: { readonly env: NodeJS.ProcessEnv }) => Promise<readonly StandingGrantRow[]>;
export type StandingRevokeHandler = (root: string, input: { readonly scopeId: string; readonly id: string; readonly reason: string; readonly confirm: (grant: StandingGrantRow) => Promise<boolean> },
  options: { readonly env: NodeJS.ProcessEnv }) => Promise<{ readonly revoked: boolean; readonly grant: StandingGrantRow | null }>;

/** The governed current first-run upgrade: the engine's result, which the surface only words. */
export interface PolicyUpgradeView { readonly status: string; readonly revision: string; readonly summary: string | null; readonly missing: readonly string[]; readonly reason: string | null; readonly conflicts?: readonly string[] }
export type PolicyUpgradeHandler = (root: string, scopeId: string, input: { readonly mode: 'preview' | 'apply' | 'rollback'; readonly expect?: string; readonly reason: string },
  options: { readonly env: NodeJS.ProcessEnv }) => Promise<PolicyUpgradeView>;

/**
 * `deckent policy grants [--mine] [--scope <id>] [--json]` lists the caller's own persisted standing approvals (read-only); `--all [--after <mark>]` everyone's (CA-1);
 * `deckent policy revoke <id> [--scope <id>] [--yes]` removes one through the same `policy.administer@1` operation that created it.
 * Until `/policy` exists (PERSISTENT-APPROVALS G6). A revoke asks `y/N` on a terminal; without one it needs an explicit `--yes`.
 */
export async function policyGrantsCommand(argv: readonly string[], context: ApprovalCommandContext): Promise<void> {
  if (['delegations', 'delegate', 'undelegate'].includes(argv[1] ?? '')) return policyDelegationsCommand(argv, context);
  if (argv[1] === 'status') return policyStatusCommand(argv, context);
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
  if (all) return policyGrantsAll(context, { root, scopeId, flagged: scope !== undefined, json, locale, env, ...(after === undefined ? {} : { after }) });
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
  let json = false, template: string | undefined, scope: string | undefined, language: string | undefined, expect: string | undefined, mode: 'preview' | 'apply' | 'rollback' | undefined;
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--json' && !json) json = true;
    else if ((flag === '--preview' || flag === '--apply' || flag === '--rollback') && mode === undefined) mode = flag.slice(2) as 'preview' | 'apply' | 'rollback';
    else if (['--template', '--scope', '--lang', '--expect'].includes(flag)) {
      const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      if (flag === '--template' && template === undefined) template = value; else if (flag === '--scope' && scope === undefined) scope = value;
      else if (flag === '--lang' && language === undefined) language = value; else if (flag === '--expect' && expect === undefined) expect = value;
      else throw ErrorRegistry.createError('CLI_USAGE');
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if ((template !== 'current' && template !== 'v5') || (expect !== undefined && mode !== 'apply') || !context.upgradePolicyTemplate) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, config = await loadConfig(root, { env });
  const locale = commandLocale(context, language);
  const configured = (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId;
  const scopeId = scope ?? (typeof configured === 'string' ? configured : undefined);
  if (!scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  if (template === 'v5') (context.stderr ?? process.stderr).write(`${t('cli.policy.upgrade.deprecated', { scope: scopeId }, locale)}\n`);
  const result = await context.upgradePolicyTemplate(root, scopeId, { mode: mode ?? 'preview', reason: t('cli.policy.upgrade.reason', {}, locale), ...(expect ? { expect } : {}) }, { env });
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  const missing = (view: PolicyUpgradeView) => view.missing.map(item => item === 'policy-administer' ? t('cli.policy.upgrade.missing.policyAdminister', {}, locale)
    : item === 'approval-decide' ? t('cli.policy.upgrade.missing.approvalDecide', {}, locale) : item === 'lockout' ? t('cli.policy.upgrade.missing.lockout', {}, locale)
    : t('cli.policy.upgrade.missing.delegation', {}, locale));
  emit(result, { ...sinks, json, render: view => {
    const head = view.status === 'preview' ? t('cli.policy.upgrade.preview', { revision: view.revision, scope: scopeId }, locale)
      : view.status === 'upgraded' ? t('cli.policy.upgrade.upgraded', { scope: scopeId }, locale) : view.status === 'current' ? t('cli.policy.upgrade.current', {}, locale)
      : view.status === 'refused' ? t('cli.policy.upgrade.refused', {}, locale) : view.status === 'conflict' ? t('cli.policy.upgrade.conflict', { revision: view.revision }, locale)
      : view.status === 'rolled-back' ? t('cli.policy.upgrade.rolledBack', { ids: view.reason ?? '-' }, locale)
      // J3: a fresh first-run install has no upgrade to undo; a rollback without archived history is refused — neither is "not a first-run policy".
      : view.status === 'nothing-to-roll-back' ? view.reason === 'no-upgrade-recorded' ? t('cli.policy.upgrade.noUpgradeRecorded', { scope: scopeId }, locale) : t('cli.policy.upgrade.nothing', {}, locale)
      : view.reason === 'history-unavailable' ? t('cli.policy.upgrade.historyMissing', { scope: scopeId }, locale)
      : t('cli.policy.upgrade.unavailable', { reason: upgradeReason(view.reason, locale) }, locale);
    // A preview that would be refused says so before anything is tried.
    const lacking = missing(view), lack = view.status === 'preview' && lacking.length ? [t('cli.policy.upgrade.wouldRefuse', {}, locale), ...lacking] : view.status === 'refused' ? lacking : [];
    return [head, ...(view.conflicts?.length ? [t('cli.policy.upgrade.conflicts', { ids: view.conflicts.join(', ') }, locale)] : []), ...(view.summary ? [view.summary] : []), ...lack].join('\n');
  } });
}

/** The engine's reason id for an unavailable first-run upgrade, in words (`not-first-run` → "elle kurulmuş politika"); an unknown id stays visible. */
const upgradeReason = (reason: string | null, locale: Locale) => reason === 'not-first-run' ? t('cli.policy.upgrade.reason.notFirstRun', {}, locale)
  : reason === 'not-this-person' ? t('cli.policy.upgrade.reason.notThisPerson', {}, locale) : reason === 'invalid' ? t('cli.policy.upgrade.reason.invalid', {}, locale) : reason ?? '-';
