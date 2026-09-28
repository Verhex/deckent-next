import { createInterface } from 'node:readline/promises';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t } from '#platform/index.js';
import type { CommandContext } from './kernel-commands.js';

/** A persisted standing approval as the CLI shows it (the engine's view; the surface owns no rule of its own). */
export interface StandingGrantRow { readonly id: string; readonly key: string; readonly tool: string; readonly kind: 'command' | 'directory' | 'unknown'; readonly text: string }
export type StandingGrantsHandler = (root: string, scopeId: string, options: { readonly env: NodeJS.ProcessEnv }) => Promise<readonly StandingGrantRow[]>;
export type StandingRevokeHandler = (root: string, input: { readonly scopeId: string; readonly id: string; readonly reason: string; readonly confirm: (grant: StandingGrantRow) => Promise<boolean> },
  options: { readonly env: NodeJS.ProcessEnv }) => Promise<{ readonly revoked: boolean; readonly grant: StandingGrantRow | null }>;

/**
 * `deckent policy grants --mine [--scope <id>] [--json]` lists the caller's own persisted standing approvals (read-only);
 * `deckent policy revoke <id> [--scope <id>] [--yes]` removes one through the same `policy.administer@1` operation that created it.
 * Until `/policy` exists (PERSISTENT-APPROVALS G6). A revoke asks `y/N` on a terminal; without one it needs an explicit `--yes`.
 */
export async function policyGrantsCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const action = argv[1]; let json = false, mine = false, yes = false, scope: string | undefined, language: string | undefined, id: string | undefined;
  if (action !== 'grants' && action !== 'revoke') throw ErrorRegistry.createError('CLI_USAGE');
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--json' && !json) json = true;
    else if (flag === '--mine' && !mine && action === 'grants') mine = true;
    else if (flag === '--yes' && !yes && action === 'revoke') yes = true;
    else if ((flag === '--scope' || flag === '--lang') && (flag === '--scope' ? scope : language) === undefined) {
      const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      if (flag === '--scope') scope = value; else language = value;
    } else if (!flag.startsWith('-') && action === 'revoke' && id === undefined) id = flag;
    else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if ((action === 'grants' && !mine) || (action === 'revoke' && !id)) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, options = { env };
  const config = await loadConfig(root, options);
  const locale = resolveLocale(language, env, config.language); context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  const configured = (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId;
  const scopeId = scope ?? (typeof configured === 'string' ? configured : undefined);
  if (!scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
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
