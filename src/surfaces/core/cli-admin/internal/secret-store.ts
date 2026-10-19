import { ErrorRegistry, EXIT_CODES, emit, loadConfig, t, terminalSafeText, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import { isSecretStoreDowngrade } from '#engine/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { resolveCommandScope, scopeLister, scopeNotice } from '#surfaces/core/cli-human/index.js';
import type { AdminCommandContext } from './context.js';
import { adminInteractive, adminSinks, askAdminCard, confirmOptions, reportCancelled } from './io.js';

/** The registered stores and the installation's selection, for the picker (store ids only; never a secret name or value). */
export interface SecretStoresView { readonly schemaVersion: 1; readonly current: string; readonly stores: readonly string[];
  readonly envGuard?: Readonly<Record<string, Readonly<{ names: readonly string[]; code: string | null }>>> }
export type SecretStoresHandler = (root: string, options: ConfigLoadOptions) => Promise<SecretStoresView>;
/** What the runtime service answers for a store switch (v24): store ids and counts only. */
export interface SecretStoreSwitchView {
  readonly schemaVersion: 1; readonly scopeId: string; readonly status: 'switched' | 'current'; readonly from: string; readonly to: string;
  readonly entries: number; readonly downgrade: boolean; readonly cleaned: boolean;
}
export type SecretStoreSwitchHandler = (root: string, input: { readonly schemaVersion: 1; readonly scopeId: string; readonly to: string; readonly confirmDowngrade: boolean; readonly confirmEnvMissing?: boolean },
  options: ConfigLoadOptions) => Promise<SecretStoreSwitchView>;

/** Core's stores by id, with a short human name and what it means for keys on disk; an extension's store keeps its id and a generic note. */
const coreStores = (locale: Locale): Readonly<Record<string, Readonly<{ name: string; note: string }>>> => ({
  'core.secret-store.env@1': { name: t('cli.secret.store.name.env', {}, locale), note: t('cli.secret.store.note.env', {}, locale) },
  'core.secret-store.file@1': { name: t('cli.secret.store.name.file', {}, locale), note: t('cli.secret.store.note.file', {}, locale) },
  'core.secret-store.encrypted-file@1': { name: t('cli.secret.store.name.encryptedFile', {}, locale), note: t('cli.secret.store.note.encryptedFile', {}, locale) } });
/** A store's short human name (owner CLI review 2026-10-19 `secret store`). */
export function storeLabel(id: string, locale: Locale): string { return Object.hasOwn(coreStores(locale), id) ? coreStores(locale)[id]!.name : terminalSafeText(id); }
const storeNote = (id: string, locale: Locale) => Object.hasOwn(coreStores(locale), id) ? coreStores(locale)[id]!.note : t('cli.secret.store.note.other', {}, locale);
/** The current store and every option, each with what it means for the keys on disk. */
function renderStores(view: SecretStoresView, locale: Locale): string {
  return [t('cli.secret.store.current', { store: storeLabel(view.current, locale), id: terminalSafeText(view.current) }, locale), t('cli.secret.store.options', {}, locale),
    ...view.stores.map(id => `  ${storeLabel(id, locale)}${id === view.current ? ` ${t('cli.secret.store.currentMark', {}, locale)}` : ''} — ${storeNote(id, locale)}`),
    t('cli.secret.store.howTo', {}, locale)].join('\n');
}

/**
 * `deckent secret store [--to <store>] [--confirm-downgrade] [--list] [--scope <id>] [--json]` (SECRET-STORE-SWITCH, owner 2026-10-08, option B):
 * moves every secret into another registered store and selects it, through the runtime service (`secret`/`switch` cell, audited). Owner CLI
 * review 2026-10-19: without `--to` off a terminal (or with `--list`) it shows the current store and the options explained; on a terminal the
 * store is picked on a card, a move to a weaker store needs a second, separate warning card, and the scope is never a silent default.
 * Off a terminal a downgrade still needs `--confirm-downgrade` and the scope `--scope`.
 */
export async function secretStoreCommand(argv: readonly string[], context: AdminCommandContext): Promise<void | ExitCode> {
  let json = false, list = false, confirm = false, confirmEnv = false, language: string | undefined, scope: string | undefined, to: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = () => { const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); return value; };
    if (flag === '--json' && !json) json = true;
    else if (flag === '--list' && !list) list = true;
    else if (flag === '--confirm-env-missing' && !confirmEnv) confirmEnv = true;
    else if (flag === '--confirm-downgrade' && !confirm) confirm = true;
    else if (flag === '--lang' && language === undefined) language = next();
    else if (flag === '--scope' && scope === undefined) scope = next();
    else if (flag === '--to' && to === undefined) to = next();
    else if (flag !== '--no-color') throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (list && (to !== undefined || confirm || confirmEnv)) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, options = { env }, locale = commandLocale(context, language);
  const sinks = { json, ...adminSinks(context) }, interactive = adminInteractive(context, json);
  if (!context.listSecretStores) throw ErrorRegistry.createError('CLI_USAGE');
  const view = await context.listSecretStores(root, options);
  if (list || (!interactive && to === undefined && !confirm && !confirmEnv)) { emit(view, { ...sinks, render: () => renderStores(view, locale) }); return; }
  if (!context.switchSecretStore || (!interactive && to === undefined)) throw ErrorRegistry.createError('CLI_USAGE');
  const cancelled = () => { reportCancelled(context, locale); return EXIT_CODES.error; };
  const target = to ?? await askAdminCard(context, locale, { title: t('cli.secret.store.pickTitle', { current: storeLabel(view.current, locale) }, locale),
    options: view.stores.map(id => ({ id, label: `${storeLabel(id, locale)}${id === view.current ? ` ${t('cli.secret.store.currentMark', {}, locale)}` : ''} — ${storeNote(id, locale)}` })),
    initial: view.current });
  if (target === null) return cancelled();
  if (!view.stores.includes(target)) throw ErrorRegistry.createError('SECRET_STORE_UNKNOWN', { params: { backend: target } });
  if (interactive && !confirm && target !== view.current && isSecretStoreDowngrade(view.current, target)) {
    // The separate warning card (owner review): only an explicit "apply" here confirms a move to weaker protection.
    const answer = await askAdminCard(context, locale, { title: t('cli.secret.store.downgradeTitle', {}, locale), body: [t('cli.secret.store.downgradePrompt',
      { from: storeLabel(view.current, locale), to: storeLabel(target, locale) }, locale), storeNote(target, locale)], options: confirmOptions(locale) });
    confirm = answer === 'apply';
    if (!confirm) throw ErrorRegistry.createError('SECRET_STORE_DOWNGRADE_UNCONFIRMED', { params: { from: view.current, to: target } });
  }
  const guard = view.envGuard?.[target];
  if (view.current === 'core.secret-store.env@1' && target !== view.current && guard) {
    if (guard.code) throw ErrorRegistry.createError(guard.code);
    if (guard.names.length && !confirmEnv) {
      const names = guard.names.join(', ');
      if (interactive) confirmEnv = await askAdminCard(context, locale, { title: t('cli.secret.store.envTitle', {}, locale),
        body: [t('cli.secret.store.envMissing', { to: storeLabel(target, locale), names }, locale)], options: confirmOptions(locale) }) === 'apply';
      if (!confirmEnv) throw ErrorRegistry.createError('SECRET_STORE_ENV_UNCONFIRMED', { params: { to: target, names } });
    }
  }
  const configured = await loadConfig(root, options).then(config => (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId, () => undefined);
  const resolved = await resolveCommandScope({ command: 'deckent secret store', locale, explicit: scope, configured: typeof configured === 'string' ? configured : undefined,
    mutating: true, interactive, listScopes: () => scopeLister(context, root, options)().catch(() => []), pick: request => askAdminCard(context, locale, request) });
  if (!resolved) return cancelled();
  if (!json) emit(scopeNotice(resolved, locale), adminSinks(context));
  emit(await context.switchSecretStore(root, { schemaVersion: 1, scopeId: resolved.scopeId, to: target, confirmDowngrade: confirm, ...(confirmEnv ? { confirmEnvMissing: true } : {}) }, options),
    { ...sinks, render: result => result.status === 'current' ? t('cli.secret.store.done.current', { store: storeLabel(result.to, locale) }, locale)
      : t('cli.secret.store.done.switched', { from: storeLabel(result.from, locale), to: storeLabel(result.to, locale), entries: result.entries,
        cleaned: result.cleaned ? t('cli.secret.store.done.cleaned', {}, locale) : t('cli.secret.store.done.notCleaned', {}, locale) }, locale) });
}
