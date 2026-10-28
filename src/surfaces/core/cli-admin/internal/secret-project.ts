import { ErrorRegistry, emit, t, terminalSafeText, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { SecretGrantState, SecretInventory, SecretInventoryFinding, SecretInventoryRow } from '#engine/index.js';
import { cliMode, cliTableStyle, renderCliTable, scopeNotice, type ScopeResolution } from '#surfaces/core/cli-human/index.js';
import type { AdminCommandContext } from './context.js';
import { adminInteractive, adminSinks, askAdminCard, confirmOptions } from './io.js';

/** PRE-8 v2: the one inventory (`secret list [--all]`, the terminal provider panel): names and metadata only, never a value. */
export interface SecretInventoryView extends SecretInventory { readonly schemaVersion: 1; readonly project: string | null; readonly mainStore: string; readonly all: boolean }
export type SecretInventoryHandler = (root: string, input: { readonly scopeId: string; readonly all: boolean }, options: ConfigLoadOptions) => Promise<SecretInventoryView>;
export interface SecretGrantView { readonly name: string; readonly project: string; readonly granted: boolean; readonly revision: number }
/** `secret grant|revoke` in this process at the person's terminal (witnessed, decided on `secret`/`set`, sealed before the grant record). */
export type SecretGrantHandler = (root: string, input: { readonly scopeId: string; readonly name: string; readonly action: 'grant' | 'revoke' }, options: ConfigLoadOptions) => Promise<SecretGrantView>;
/** `secret set|delete --project`: the project's own vault, in this process at the person's terminal (value null: delete). */
export type ProjectSecretHandler = (root: string, input: { readonly scopeId: string; readonly name: string; readonly value: string | null }, options: ConfigLoadOptions)
  => Promise<{ readonly name: string; readonly project: string; readonly removed: boolean }>;
export type SecretHandoverHandler = (root: string, input: { readonly scopeId: string }, options: ConfigLoadOptions) => Promise<{ readonly project: string; readonly handedOverAtMs: number | null }>;

type Sinks = ReturnType<typeof adminSinks> & { readonly json: boolean };
/** The authority commands need a person's terminal before anything is read (the composition checks the witness again). */
export function requirePersonTerminal(context: AdminCommandContext, operation: string): void {
  if (cliMode(context).mode !== 'interactive') throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation } });
}

/** KER-17: one user of a key in words: `mcp:<server>` is a personal-file MCP server naming it as `$DECK:`, anything else a provider profile. */
export const secretUserText = (user: string, locale: Locale): string => user.startsWith('mcp:')
  ? t('cli.secret.usedBy.mcp', { server: terminalSafeText(user.slice(4)) }, locale) : t('cli.secret.usedBy.profile', { profile: terminalSafeText(user) }, locale);
/** KER-17: who uses main key NAME in this project (provider profiles, MCP servers), from the one inventory; empty when it cannot be read. */
export async function projectKeyUsers(context: AdminCommandContext, root: string, scopeId: string, name: string, options: ConfigLoadOptions, locale: Locale): Promise<string[]> {
  const view = await context.inspectSecretInventory?.(root, { scopeId, all: false }, options).catch(() => null);
  return (view?.rows.find(row => row.name === name && row.vault === 'main')?.usedBy ?? []).map(user => secretUserText(user, locale));
}
/** `deckent secret grant|revoke <NAME> --scope <S>`: lend (or take back) a main-vault key to this project. A person's card on a terminal first. */
export async function secretGrantCommand(context: AdminCommandContext, root: string, options: ConfigLoadOptions, locale: Locale, sinks: Sinks,
  input: { readonly scope: ScopeResolution; readonly name: string; readonly action: 'grant' | 'revoke' }): Promise<'cancelled' | void> {
  if (!context.changeSecretGrant) throw ErrorRegistry.createError('CLI_USAGE');
  if (adminInteractive(context, sinks.json)) {
    const params = { name: input.name, project: terminalSafeText(root) }, users = input.action === 'revoke' ? await projectKeyUsers(context, root, input.scope.scopeId, input.name, options, locale) : [];
    const revokeUsers = async () => users.length ? [t('cli.secret.card.revokeUsers', { users: users.join(', ') }, locale)] : [];
    const answer = await askAdminCard(context, locale, { title: input.action === 'grant' ? t('cli.secret.card.grantTitle', params, locale) : t('cli.secret.card.revokeTitle', params, locale),
      body: [t('cli.secret.card.grantBody', {}, locale), ...await revokeUsers()], options: confirmOptions(locale) });
    if (answer !== 'apply') return 'cancelled';
  }
  const view = await context.changeSecretGrant(root, { scopeId: input.scope.scopeId, name: input.name, action: input.action }, options);
  if (!sinks.json) emit(scopeNotice(input.scope, locale), adminSinks(context));
  const params = { name: view.name, project: terminalSafeText(view.project) };
  emit(view, { ...sinks, render: () => view.granted ? t('cli.secret.done.granted', params, locale) : t('cli.secret.done.revoked', params, locale) });
}

/** `deckent secret handover --scope <S>`: a moved project takes its vault along (refused while the original folder still holds it). */
export async function secretHandoverCommand(context: AdminCommandContext, root: string, options: ConfigLoadOptions, locale: Locale, sinks: Sinks, scope: ScopeResolution): Promise<'cancelled' | void> {
  if (!context.handOverSecrets) throw ErrorRegistry.createError('CLI_USAGE');
  if (adminInteractive(context, sinks.json) && await askAdminCard(context, locale, { title: t('cli.secret.card.handoverTitle', { project: terminalSafeText(root) }, locale),
    options: confirmOptions(locale) }) !== 'apply') return 'cancelled';
  const view = await context.handOverSecrets(root, { scopeId: scope.scopeId }, options);
  emit(view, { ...sinks, render: () => t('cli.secret.done.handedOver', { project: terminalSafeText(view.project) }, locale) });
}

const vaultCell = (vault: SecretInventoryRow['vault'], locale: Locale) => vault === 'main' ? t('cli.secret.inventory.vault.main', {}, locale) : t('cli.secret.inventory.vault.project', {}, locale);
const deckCell = (deck: SecretInventoryRow['deck'], locale: Locale) => deck === null ? '-' : deck === 'main' ? t('cli.secret.inventory.deck.main', {}, locale)
  : deck === 'project' ? t('cli.secret.inventory.deck.project', {}, locale) : t('cli.secret.inventory.deck.undeclared', {}, locale);
const grantCell = (grant: SecretGrantState, locale: Locale) => grant.state === 'granted'
  ? t('cli.secret.inventory.grant.granted', { subject: terminalSafeText(grant.by.subject), at: new Date(grant.atMs).toISOString().slice(0, 10) }, locale)
  : grant.state === 'none' ? t('cli.secret.inventory.grant.none', {}, locale) : t('cli.secret.inventory.grant.notApplicable', {}, locale);
const presenceCell = (presence: SecretInventoryRow['presence'], locale: Locale) => presence === 'stored' ? t('cli.secret.inventory.presence.stored', {}, locale)
  : presence === 'missing' ? t('cli.secret.inventory.presence.missing', {}, locale) : t('cli.secret.inventory.presence.unverified', {}, locale);
const findingLine = (finding: SecretInventoryFinding, locale: Locale) => {
  const params = { name: finding.name, project: terminalSafeText(finding.project) };
  return finding.kind === 'grant-required' ? t('cli.secret.inventory.finding.grantRequired', params, locale)
    : finding.kind === 'undeclared-project-key' ? t('cli.secret.inventory.finding.undeclared', params, locale) : t('cli.secret.inventory.finding.declaredMissing', params, locale);
};
/** name · vault · project · used by · .deck · grant · stored, then the sync findings with their next command. Never a value. */
export function renderSecretInventory(view: SecretInventoryView, installationUsers: ReadonlyMap<string, readonly string[]>, locale: Locale, style: ReturnType<typeof cliTableStyle>): string {
  const rows = view.rows.map(row => [row.name, vaultCell(row.vault, locale), row.project === null ? '-' : terminalSafeText(row.project),
    [...row.usedBy.map(user => secretUserText(user, locale)), ...(row.vault === 'main' ? installationUsers.get(row.name) ?? [] : [])].join(', ')
      || t('cli.secret.usedBy.none', {}, locale), deckCell(row.deck, locale), grantCell(row.grant, locale), presenceCell(row.presence, locale)]);
  const columns = [t('cli.secret.list.column.name', {}, locale), t('cli.secret.inventory.column.vault', {}, locale), t('cli.secret.inventory.column.project', {}, locale),
    t('cli.secret.list.column.usedBy', {}, locale), t('cli.secret.inventory.column.deck', {}, locale), t('cli.secret.inventory.column.grant', {}, locale),
    t('cli.secret.inventory.column.stored', {}, locale)].map(header => ({ header }));
  const findings = view.findings.map(finding => `  ${findingLine(finding, locale)}`), params = { project: terminalSafeText(view.project ?? '-'), store: terminalSafeText(view.mainStore) };
  return [view.all ? t('cli.secret.inventory.titleAll', params, locale) : t('cli.secret.inventory.title', params, locale),
    ...(rows.length ? ['', renderCliTable(columns, rows, style)] : [t('cli.secret.list.empty', {}, locale)]),
    ...(findings.length ? ['', t('cli.secret.inventory.findings', {}, locale), ...findings] : []), '', t('cli.secret.inventory.never', {}, locale)].join('\n');
}
