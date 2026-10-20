import { ErrorRegistry, emit, t, type Locale } from '#platform/index.js';
import type { StandingGrantsPage } from '#engine/index.js';
import { cliTableStyle, formatClock, renderCliTable, safeCell, scopeNotice } from '#surfaces/core/cli-human/index.js';
import type { ApprovalCommandContext } from './context.js';

export type AllStandingGrantsHandler = (root: string, input: { readonly scopeId: string; readonly after?: string }, options: { readonly env: NodeJS.ProcessEnv }) => Promise<StandingGrantsPage>;

/**
 * CA-1 `deckent policy grants --all [--after <mark>]`: everyone's standing approvals in the scope, one page (person · rule · tool · pattern ·
 * scope · since). Allowed only when policy grants the caller `policy inspect-standing-grants`; a refusal is the typed
 * `CLI_POLICY_GRANTS_ALL_UNAVAILABLE` naming that permission and the next step. Text on a pipe too; JSON only with `--json`.
 */
export async function policyGrantsAll(context: ApprovalCommandContext, input: { readonly root: string; readonly scopeId: string; readonly flagged: boolean; readonly after?: string;
  readonly json: boolean; readonly locale: Locale; readonly env: NodeJS.ProcessEnv }): Promise<void> {
  const refuse = () => ErrorRegistry.createError('CLI_POLICY_GRANTS_ALL_UNAVAILABLE', { params: { scope: input.scopeId }, locale: input.locale });
  if (!context.listAllStandingGrants) throw refuse();
  let page: StandingGrantsPage;
  try { page = await context.listAllStandingGrants(input.root, { scopeId: input.scopeId, ...(input.after === undefined ? {} : { after: input.after }) }, { env: input.env }); }
  catch (error) { const code = (error as { code?: unknown } | null)?.code; if (code === 'POLICY_DENIED' || code === 'POLICY_APPROVAL_UNSUPPORTED') throw refuse(); throw error; }
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  emit(page, { ...sinks, json: input.json, render: view => standingGrantsAllText(view, input.flagged, input.locale, cliTableStyle(context), input.after !== undefined) });
}

/** The readable page: scope line, count (of this page when paged), table, and the since / next-page notes. Every cell goes through the table's redaction. */
export function standingGrantsAllText(view: StandingGrantsPage, flagged: boolean, locale: Locale, style: ReturnType<typeof cliTableStyle>, later = false): string {
  const head = scopeNotice({ scopeId: view.scopeId, source: flagged ? 'flag' : 'default' }, locale);
  if (view.rows.length === 0) return [head, t('cli.policy.grantsAll.none', {}, locale)].join('\n');
  const scopes = (value: 'all' | readonly string[]) => value === 'all' ? t('cli.policy.grantsAll.allScopes', {}, locale) : value.join(', ');
  const people = new Set(view.rows.flatMap(row => row.principals.map(person => `${person.issuer}/${person.subject}`)));
  const columns = [t('cli.policy.grantsAll.column.person', {}, locale), t('cli.policy.grantsAll.column.rule', {}, locale), t('cli.policy.grantsAll.column.tool', {}, locale),
    t('cli.policy.grantsAll.column.pattern', {}, locale), t('cli.policy.grantsAll.column.scope', {}, locale), t('cli.policy.grantsAll.column.since', {}, locale)];
  const since = view.since === 'partial' ? t('cli.policy.grantsAll.since.partial', {}, locale) : view.since === 'unavailable' ? t('cli.policy.grantsAll.since.unavailable', {}, locale)
    : t('cli.policy.grantsAll.since.complete', {}, locale);
  const table = renderCliTable(columns.map((header, index) => ({ header, shrink: index === 1 || index === 3 })),
    view.rows.map(row => [row.principals.length ? row.principals.map(person => `${person.issuer}/${person.subject}`).join(', ') : t('cli.policy.grantsAll.everyone', {}, locale),
      row.id, `${row.tool} (${row.kind})`, row.pattern, scopes(row.scopes), row.sinceMs === null ? '—' : formatClock(row.sinceMs, locale)]), style);
  return [head, (view.next || later ? t('cli.policy.grantsAll.headerPage', { count: view.rows.length, people: people.size }, locale) : t('cli.policy.grantsAll.header', { count: view.rows.length, people: people.size }, locale)), table,
    ...(view.since === 'complete' && view.rows.every(row => row.sinceMs !== null) ? [] : [since]),
    ...(view.next ? [t('cli.policy.grantsAll.more', { command: safeCell(`deckent policy grants --all --scope ${view.scopeId} --after ${view.next}`) }, locale)] : []),
    t('cli.policy.grantsAll.noValues', {}, locale)].join('\n');
}
