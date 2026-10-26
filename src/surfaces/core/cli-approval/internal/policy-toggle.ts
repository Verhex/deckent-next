import { ErrorRegistry, emit, loadConfig, t, type Locale } from '#platform/index.js';
import type { DecisionDelegationView, McpCapabilityState, McpCapabilityView } from '#domain/index.js';
import { delegationWords, mcpCapabilityPreviewLines, mcpCapabilityWords } from '#surfaces/core/work-labels/index.js';
import { cliTableStyle, renderCliTable, resolveCommandScope, scopeLister, scopeNotice, type CliCardRequest, type ScopeResolution } from '#surfaces/core/cli-human/index.js';
import type { ApprovalCommandContext } from './context.js';
import { cardIo, sinksOf } from './io.js';

const LEAVE = '-leave', APPLY = 'apply', NO = 'no';
export type CardAsk = (request: CliCardRequest) => Promise<string | null>;
type Ask = CardAsk;
/** Plain on/off words (owner: "kapalı / açık"); a partial or conflicting state says so instead of guessing. */
const onOff = (state: 'allowed' | 'denied' | 'partial', locale: Locale) => state === 'allowed' ? t('cli.policy.on', {}, locale) : state === 'partial' ? t('cli.policy.partial', {}, locale) : t('cli.policy.off', {}, locale);
/** The preview card's title: what is switched, and which way. */
export const toggleTitle = (action: 'grant' | 'revoke' | 'narrow', what: string, locale: Locale) => action === 'narrow' ? t('policy.mcp.narrow', {}, locale) : action === 'grant' ? t('cli.policy.toggle.turnOn', { what }, locale) : t('cli.policy.toggle.turnOff', { what }, locale);
const applyOptions = (locale: Locale) => [{ id: APPLY, label: t('cli.policy.toggle.apply', {}, locale), key: 'y' }, { id: NO, label: t('cli.policy.toggle.no', {}, locale), key: 'n' }];

/**
 * The delegation preview card in plain words: whose AI actor, which scope, the step and the change (off → on), then every step's state and the
 * existing limit sentence. Hashes stay out of the card (the change itself binds the revision it re-read).
 */
export function delegationCardLines(view: DecisionDelegationView, step: string, action: 'grant' | 'revoke', locale: Locale): readonly string[] {
  const words = delegationWords(locale), label = (id: string) => words.step[id] ?? id;
  return [t('cli.policy.toggle.actor', { actor: `${view.principal.issuer}/${view.principal.subject}`, scope: view.scopeId, resource: view.resourceId ?? '*' }, locale),
    action === 'grant' ? t('cli.policy.toggle.becomesOn', { what: label(step) }, locale) : t('cli.policy.toggle.becomesOff', { what: label(step) }, locale),
    ...view.steps.map(row => `  ${label(row.step.id)} · ${row.managed === 'conflict' ? t('cli.policy.conflict', {}, locale) : onOff(row.effective, locale)}`),
    t('policy.delegate.limit', {}, locale)];
}
/** The AI delegation steps of one scope as a table: step · what it lets the AI do · on/off (the effective decision), a conflict named. */
export function delegationTable(view: DecisionDelegationView, locale: Locale, style: ReturnType<typeof cliTableStyle>): string {
  const words = delegationWords(locale);
  return renderCliTable([{ header: t('cli.policy.column.step', {}, locale) }, { header: t('cli.policy.column.label', {}, locale), shrink: true }, { header: t('cli.policy.column.ai', {}, locale) }],
    view.steps.map(row => [row.step.id, words.step[row.step.id] ?? row.step.id, row.managed === 'conflict' ? t('cli.policy.conflict', {}, locale) : onOff(row.effective, locale)]), style);
}
/** The MCP capability groups of one scope as a table: group · on/off/partial · a conflict named. */
export function mcpTable(view: McpCapabilityView, locale: Locale, style: ReturnType<typeof cliTableStyle>): string {
  const words = mcpCapabilityWords(locale);
  return renderCliTable([{ header: t('cli.policy.column.group', {}, locale) }, { header: t('cli.policy.column.label', {}, locale), shrink: true }, { header: t('cli.policy.column.mcp', {}, locale) }],
    view.groups.map(state => [state.group.id, words.label(state.group.labelKey, state.group.id), state.managed === 'conflict' ? t('cli.policy.conflict', {}, locale) : onOff(state.effective, locale)]), style);
}

export async function toggleScope(context: ApprovalCommandContext, locale: Locale, explicit: string | undefined, command: string, ask: Ask): Promise<ScopeResolution | null> {
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  const configured = ((await loadConfig(root, options)).terminal as { scopeId?: unknown } | undefined)?.scopeId;
  const listScopes = scopeLister(context, root, options);
  const scopes = !explicit && typeof configured !== 'string' ? await listScopes() : null;
  if (scopes?.length === 1) return { scopeId: scopes[0]!, source: 'default' };
  // This phase only reads. The eventual change has its own scope-bound, governed preview card.
  return resolveCommandScope({ command, locale, explicit, configured: typeof configured === 'string' ? configured : undefined, mutating: false, interactive: true,
    listScopes: scopes ? async () => scopes : listScopes, pick: ask });
}

/**
 * `deckent policy delegations` on a person's terminal (CLI review §policy): the steps with on/off → pick one → the governed change's own preview
 * (the view re-read inside the change, so the card shows exactly what is applied) → apply on "yes". Writes only through the existing delegation
 * change (`policy.administer`, attested terminal, audit); a declined or cancelled card changes nothing.
 */
export async function toggleDelegations(context: ApprovalCommandContext, locale: Locale, explicit: string | undefined, ttlMs: number,
  ask: Ask = cardIo(context, locale, ttlMs).ask): Promise<void> {
  const host = context.delegations; if (!host) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, print = (text: string) => emit(text, sinksOf(context));
  const scope = await toggleScope(context, locale, explicit, 'deckent policy delegations', ask); if (!scope) return;
  const query = { schemaVersion: 1 as const, scopeId: scope.scopeId, actor: 'mcp' as const }, view = await host.inspect(root, query, options), words = delegationWords(locale);
  print([scopeNotice(scope, locale), delegationTable(view, locale, cliTableStyle(context))].join('\n'));
  const step = await ask({ title: t('cli.policy.toggle.stepTitle', { scope: scope.scopeId }, locale), options: [...view.steps.filter(row => row.managed !== 'conflict').map(row => ({ id: row.step.id,
    label: `${words.step[row.step.id] ?? row.step.id} · ${onOff(row.effective, locale)}` })), { id: LEAVE, label: t('cli.policy.toggle.leave', {}, locale), key: 'q' }] });
  const row = view.steps.find(entry => entry.step.id === step); if (!row) return;
  const action = row.managed === 'granted' ? 'revoke' : 'grant';
  const result = await host.change(root, { ...query, step: row.step.id, action, expectedRevision: view.revision }, async reviewed =>
    (await ask({ title: toggleTitle(action, words.step[row.step.id] ?? row.step.id, locale),
      body: delegationCardLines(reviewed, row.step.id, action, locale), options: applyOptions(locale) })) === APPLY, options);
  print([words.result[result.status], delegationTable(result.view, locale, cliTableStyle(context))].join('\n'));
}

/**
 * `deckent policy mcp` on a person's terminal: the groups with on/off → pick one → the change's preview (rules, actor, missing authority) → apply
 * with that preview's digest on "yes". The same `changeMcpCapabilities` as `policy mcp grant|revoke --apply --expect` and the terminal's `/policy`.
 */
export async function toggleMcp(context: ApprovalCommandContext, locale: Locale, explicit: string | undefined, ttlMs: number,
  ask: Ask = cardIo(context, locale, ttlMs).ask): Promise<void> {
  const host = context.mcpCapabilities; if (!host) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, print = (text: string) => emit(text, sinksOf(context));
  const scope = await toggleScope(context, locale, explicit, 'deckent policy mcp', ask); if (!scope) return;
  const view = await host.inspectMcpCapabilities(root, scope.scopeId, options), words = mcpCapabilityWords(locale);
  print([scopeNotice(scope, locale), mcpTable(view, locale, cliTableStyle(context))].join('\n'));
  const picked = await ask({ title: t('cli.policy.toggle.groupTitle', { scope: scope.scopeId }, locale), options: [...view.groups.filter(state => state.managed !== 'conflict').map(state => ({
    id: state.group.id, label: `${words.label(state.group.labelKey, state.group.id)} · ${onOff(state.effective, locale)}` })), { id: LEAVE, label: t('cli.policy.toggle.leave', {}, locale), key: 'q' }] });
  const state: McpCapabilityState | undefined = view.groups.find(entry => entry.group.id === picked); if (!state) return;
  const action = state.managed === 'wider-earlier' ? 'narrow' : state.managed === 'granted' ? 'revoke' : 'grant', selection = { action, scopeId: scope.scopeId, groupId: state.group.id } as const;
  const preview = await host.changeMcpCapabilities(root, { ...selection, mode: 'preview' }, options);
  if (preview.status !== 'preview' || preview.missing.length) { print([words.result[preview.missing.length ? 'refused' : preview.status], ...mcpCapabilityPreviewLines(preview, locale)].join('\n')); return; }
  const answer = await ask({ title: toggleTitle(action, words.label(state.group.labelKey, state.group.id), locale),
    body: mcpCapabilityPreviewLines(preview, locale), options: applyOptions(locale) });
  if (answer !== APPLY) { print(t('cli.policy.toggle.unchanged', {}, locale)); return; }
  const result = await host.changeMcpCapabilities(root, { ...selection, mode: 'apply', expect: preview.digest }, options);
  print([words.result[result.status], ...(result.status === 'applied' ? [] : mcpCapabilityPreviewLines(result, locale))].join('\n'));
  if (result.status === 'conflict' || result.status === 'refused') throw ErrorRegistry.createError('POLICY_DENIED');
}
