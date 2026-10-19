import { ErrorRegistry, emit, loadConfig, t, terminalSafeText, type Locale } from '#platform/index.js';
import type { PolicyAdministrationStatus } from '#engine/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { cliTableStyle, renderCliTable, resolveCommandScope, scopeLister, scopeNotice, type ScopeResolution } from '#surfaces/core/cli-human/index.js';
import type { ApprovalCommandContext } from './context.js';
import { sinksOf } from './io.js';

interface Flags { scope?: string; language?: string; json: boolean; verbose: boolean }
function flags(argv: readonly string[], allowVerbose: boolean): Flags {
  const parsed: Flags = { json: false, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json' && !parsed.json) parsed.json = true;
    else if (flag === '--verbose' && allowVerbose && !parsed.verbose) parsed.verbose = true;
    else if ((flag === '--scope' && parsed.scope === undefined) || (flag === '--lang' && parsed.language === undefined)) {
      const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      if (flag === '--scope') parsed.scope = value; else parsed.language = value;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (parsed.json && parsed.verbose) throw ErrorRegistry.createError('CLI_USAGE');
  return parsed;
}

/** One summary line that may fail on its own (a read the person lacks, a policy shape it cannot read): the rest of the summary still shows. */
async function soft(read: (() => Promise<string>) | undefined, locale: Locale): Promise<string | null> {
  if (!read) return null;
  try { return await read(); } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'error';
    return t('cli.policy.summary.unreadable', { code: terminalSafeText(code) }, locale);
  }
}

/**
 * `deckent policy` / `deckent policy status` (CLI review §policy): the default scope's policy summary — kind, administrators labelled, my standing
 * grants, the AI steps delegated and the MCP groups on, each with the command that shows it. Hashes only with `--verbose`; `--json` stays the
 * status view exactly as before (no new field).
 */
export async function policyStatusCommand(argv: readonly string[], context: ApprovalCommandContext): Promise<void> {
  const args = flags(argv, true), root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, config = await loadConfig(root, options);
  const locale = commandLocale(context, args.language);
  const configured = (config.terminal as { scopeId?: unknown } | undefined)?.scopeId, scopeId = args.scope ?? (typeof configured === 'string' ? configured : undefined);
  if (!scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  if (!context.inspectPolicyAdministration) throw ErrorRegistry.createError('CLI_USAGE');
  const view = await context.inspectPolicyAdministration(root, { schemaVersion: 1, scopeId }, options);
  if (args.json) { emit(view, { json: true, ...sinksOf(context) }); return; }
  const scope: ScopeResolution = { scopeId, source: args.scope ? 'flag' : 'default' }, on = (count: number, total: number) => t('cli.policy.summary.count', { on: count, total }, locale);
  const [grants, delegated, mcp] = await Promise.all([
    soft(context.listStandingGrants && (async () => t('cli.policy.summary.grants', { count: (await context.listStandingGrants!(root, scopeId, options)).length }, locale)), locale),
    soft(context.delegations && (async () => { const steps = (await context.delegations!.inspect(root, { schemaVersion: 1, scopeId, actor: 'mcp' }, options)).steps;
      return t('cli.policy.summary.delegations', { state: on(steps.filter(row => row.effective === 'allowed').length, steps.length) }, locale); }), locale),
    soft(context.mcpCapabilities && (async () => { const groups = (await context.mcpCapabilities!.inspectMcpCapabilities(root, scopeId, options)).groups;
      return t('cli.policy.summary.mcp', { state: on(groups.filter(state => state.effective === 'allowed').length, groups.length) }, locale); }), locale),
  ]);
  emit([scopeNotice(scope, locale), t('cli.policy.summary.kind', { kind: kindText(view, locale), count: view.usableAdminCount }, locale),
    ...view.admins.map(person => t('cli.policy.summary.admin', { person: terminalSafeText(`${person.issuer}/${person.subject}`) }, locale)),
    ...[grants, delegated, mcp].filter((line): line is string => line !== null),
    view.bootstrapRequired ? t('cli.policy.status.bootstrap', {}, locale) : view.recoveryRequired ? t('cli.policy.status.recovery', {}, locale) : t('cli.policy.status.ready', {}, locale),
    t('cli.policy.status.unverified', {}, locale),
    ...(args.verbose ? [t('cli.policy.summary.revision', { revision: terminalSafeText(view.revision) }, locale)] : [])].join('\n'), sinksOf(context));
}
const kindText = (view: PolicyAdministrationStatus, locale: Locale) => view.template.kind === 'first-run'
  ? t('cli.policy.status.first-run', { version: view.template.version ?? '-' }, locale) : view.template.kind === 'drift' ? t('cli.policy.status.drift', {}, locale) : t('cli.policy.status.hand-built', {}, locale);

/**
 * `deckent policy scopes` (the scope list path L-HELP reserved): the scopes this person may read — the same query `/config` uses for
 * `terminal.scopeId` — with the configured default marked. Read-only; `--json` is the plain id list.
 */
export async function policyScopesCommand(argv: readonly string[], context: ApprovalCommandContext): Promise<void> {
  const args = flags(argv, false); if (args.scope) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, locale = commandLocale(context, args.language);
  const scopes = await scopeLister(context, root, options)(), configured = ((await loadConfig(root, options)).terminal as { scopeId?: unknown } | undefined)?.scopeId;
  emit(scopes, { json: args.json, ...sinksOf(context), render: list => list.length ? [t('cli.policy.scopes.header', { count: list.length }, locale),
    ...list.map(id => `  ${terminalSafeText(id)}${id === configured ? ` ${t('cli.policy.scopes.default', {}, locale)}` : ''}`)].join('\n') : t('cli.policy.scopes.none', {}, locale) });
}

/** The default-scope read of the toggle commands off a terminal: the same rule as every read (flag, else configured default, named). */
export async function readScope(context: ApprovalCommandContext, locale: Locale, explicit: string | undefined, command: string): Promise<ScopeResolution> {
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  const configured = ((await loadConfig(root, options)).terminal as { scopeId?: unknown } | undefined)?.scopeId;
  return (await resolveCommandScope({ command, locale, explicit, configured: typeof configured === 'string' ? configured : undefined, mutating: false, interactive: false,
    listScopes: scopeLister(context, root, options) }))!;
}

/** `deckent policy vocabulary` for a person: a table (resource · actions) and the line that the vocabulary grants nothing; `--json` stays the matrix. */
export function vocabularyText(data: Readonly<{ schemaVersion: number; resources: readonly Readonly<{ kind: string; actions: readonly string[] }>[] }>, locale: Locale,
  env: NodeJS.ProcessEnv): string {
  return [renderCliTable([{ header: t('cli.policy.vocabulary.resource', {}, locale) }, { header: t('cli.policy.vocabulary.actions', {}, locale), shrink: true }],
    data.resources.map(resource => [resource.kind, resource.actions.join(', ')]), cliTableStyle({ env })),
  t('cli.policy.vocabulary.note', { count: data.resources.length, version: data.schemaVersion }, locale)].join('\n');
}
