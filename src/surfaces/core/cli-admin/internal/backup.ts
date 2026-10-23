import { resolve } from 'node:path';
import { emit, ErrorRegistry, EXIT_CODES, loadConfig, loadConfigLanguage, t, terminalSafeText, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import { backupCommandSchema, type BackupCommand, type BackupResult } from '#engine/index.js';
import { commandLocale, resolveCliLocale } from '#surfaces/core/cli-kit/index.js';
import { cliTableStyle, formatAgo, formatBytes, formatClock, renderCliTable, resolveCommandScope, scopeLister, scopeNotice, type CliTableStyle } from '#surfaces/core/cli-human/index.js';
import type { AdminCommandContext } from './context.js';
import { adminInteractive, adminSinks, askAdminCard, confirmOptions, reportCancelled } from './io.js';
import { readHidden, readPiped } from './secret.js';
export type BackupHandler = (root: string, command: BackupCommand, passphrase: string, options: ConfigLoadOptions) => Promise<BackupResult>;
/** One recovery set as listed without the passphrase (composition reads the folder and the sealed backup audit). */
export interface BackupSetView { readonly path: string; readonly name: string; readonly kind: 'scheduled' | 'manual'; readonly createdAtMs: number; readonly bytes: number;
  readonly lastVerifiedAtMs: number | null }
export interface BackupSetsView { readonly schemaVersion: 1; readonly directory: string; readonly schedule: string; readonly retention: number;
  readonly passphraseStored: boolean | null; readonly sets: readonly BackupSetView[] }
export type BackupSetsHandler = (root: string, options: ConfigLoadOptions) => Promise<BackupSetsView>;

const kindText = (kind: BackupSetView['kind'], locale: Locale) => kind === 'scheduled' ? t('cli.backup.kind.scheduled', {}, locale) : t('cli.backup.kind.manual', {}, locale);
const setRow = (set: BackupSetView, locale: Locale, now: number) => [formatClock(set.createdAtMs, locale), formatBytes(set.bytes, locale),
  kindText(set.kind, locale), set.lastVerifiedAtMs === null ? t('cli.backup.list.neverVerified', {}, locale) : formatAgo(set.lastVerifiedAtMs, now, locale), set.name];
/** Owner CLI review 2026-10-19 (`backup`): schedule and retention on top, then date · size · kind · last verified · name, newest first. */
export function renderBackupSets(view: BackupSetsView, locale: Locale, style: CliTableStyle, now: number): string {
  const schedule = view.schedule === 'daily' ? t('cli.backup.schedule.daily', {}, locale) : view.schedule === 'before-upgrade' ? t('cli.backup.schedule.before-upgrade', {}, locale)
    : t('cli.backup.schedule.off', {}, locale);
  const lines = [t('cli.backup.list.title', { directory: terminalSafeText(view.directory) }, locale), t('cli.backup.list.schedule', { schedule, retention: view.retention }, locale)];
  if (view.passphraseStored) lines.push(t('cli.backup.list.passphraseHere', {}, locale));
  else if (view.passphraseStored === null) lines.push(t('cli.backup.list.passphraseUnknown', {}, locale));
  if (!view.sets.length) return [...lines, t('cli.backup.list.empty', {}, locale)].join('\n');
  const columns = [t('cli.backup.list.column.date', {}, locale), t('cli.backup.list.column.size', {}, locale), t('cli.backup.list.column.kind', {}, locale),
    t('cli.backup.list.column.verified', {}, locale), t('cli.backup.list.column.name', {}, locale)].map((header, index) => ({ header, ...(index === 1 ? { align: 'right' as const } : {}) }));
  return [...lines, '', renderCliTable(columns, view.sets.map(set => setRow(set, locale, now)), style), '', t('cli.backup.list.elsewhere', {}, locale)].join('\n');
}
function renderResult(data: BackupResult, locale: Locale): string {
  const set = terminalSafeText(data.set), made = formatClock(Date.parse(data.createdAt), locale);
  const lines = [data.action === 'create' ? t('cli.backup.done.create', { set, files: data.files, made }, locale)
    : data.action === 'verify' ? t('cli.backup.done.verify', { set, files: data.files, made }, locale) : t('cli.backup.done.restore', { set, made }, locale)];
  if (data.relocation?.required) lines.push(t('cli.backup.relocated', { target: terminalSafeText(data.relocation.target) }, locale));
  if (data.globalConfig?.added.length) lines.push(t('cli.backup.globalAdded', { path: terminalSafeText(data.globalConfig.path), sections: data.globalConfig.added.join(', ') }, locale));
  if (data.globalConfig?.kept.length) lines.push(t('cli.backup.globalKept', { path: terminalSafeText(data.globalConfig.path), sections: data.globalConfig.kept.join(', ') }, locale));
  if (data.preserved.length) lines.push(t('cli.backup.done.preserved', { paths: data.preserved.map(path => terminalSafeText(path)).join(', ') }, locale));
  return lines.join('\n');
}

/**
 * `deckent backup` (no action): the recovery sets (read). `deckent backup create|verify|restore [--scope <id>] [--set <path>] …`: the governed
 * backup application. Owner CLI review 2026-10-19: without `--set` a person on a terminal picks a listed set and a pipe gets the list with a
 * typed refusal (BACKUP_SET_REQUIRED, exit 2); a restore on a terminal shows target, service state and where replaced files go on a card
 * first. The passphrase is only read from a hidden prompt or stdin, never an argument; the scope rule applies (verify reads the default).
 */
export async function backupCommand(argv: readonly string[], context: AdminCommandContext): Promise<void | ExitCode> {
  const action = argv[1];
  if (action === undefined || action.startsWith('-')) return listCommand(argv, context);
  if (!['create', 'verify', 'restore'].includes(action ?? '')) throw ErrorRegistry.createError('CLI_USAGE');
  let set: string | undefined, scopeId: string | undefined, target: string | undefined, confirmTarget: string | undefined, language: string | undefined, json = false;
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = () => { const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); return value; };
    if (flag === '--set' && !set) set = next();
    else if (flag === '--scope' && !scopeId) scopeId = next();
    else if (flag === '--target' && !target && action === 'restore') target = next();
    else if (flag === '--confirm-target' && !confirmTarget && action === 'restore') confirmTarget = next();
    else if (flag === '--lang' && !language) language = next();
    else if (flag === '--json' && !json) json = true;
    else if (flag !== '--no-color') throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (!context.executeBackup) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, options = { env };
  // S1 O5: without a host-resolved locale, the installation's saved language (read without config admission, so a restore hold is reported in it).
  const saved = context.locale ? undefined : await loadConfigLanguage(root, { env }).catch(() => undefined);
  const locale = commandLocale(saved ? { ...context, locale: resolveCliLocale({ env, configLanguage: saved }) } : context, language);
  const interactive = adminInteractive(context, json), cancelled = () => { reportCancelled(context, locale); return EXIT_CODES.error; };
  const configured = await loadConfig(root, options).then(config => (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId, () => undefined);
  const scope = await resolveCommandScope({ command: `deckent backup ${action}`, locale, explicit: scopeId, configured: typeof configured === 'string' ? configured : undefined,
    mutating: action !== 'verify', interactive, listScopes: () => scopeLister(context, root, options)().catch(() => []), pick: request => askAdminCard(context, locale, request) });
  if (!scope) return cancelled();
  if (!set && action !== 'create') {
    const view = context.inspectBackupSets ? await context.inspectBackupSets(root, options).catch(() => undefined) : undefined;
    if (!interactive || !view?.sets.length) throw ErrorRegistry.createError('BACKUP_SET_REQUIRED', { params: { action,
      sets: view?.sets.slice(0, 5).map(item => terminalSafeText(item.path)).join(', ') || t('cli.backup.list.none', {}, locale) } });
    const now = Date.now();
    set = await askAdminCard(context, locale, { title: action === 'verify' ? t('cli.backup.card.pickVerify', {}, locale) : t('cli.backup.card.pickRestore', {}, locale),
      body: [t('cli.backup.list.title', { directory: terminalSafeText(view.directory) }, locale)],
      options: view.sets.map(item => ({ id: item.path, label: setRow(item, locale, now).slice(0, 4).join(' · ') })) }) ?? undefined;
    if (!set) return cancelled();
  }
  if (!set) throw ErrorRegistry.createError('CLI_USAGE');
  if (action === 'restore' && interactive) {
    // A running service holds the ledger: say so before the passphrase is typed (the store refuses it again under custody).
    if (context.describeRuntimeService && await context.describeRuntimeService(root, options).then(() => true, () => false)) throw ErrorRegistry.createError('BACKUP_SERVICE_RUNNING');
    target = resolve(target ?? root); // the card names the absolute target; Apply confirms that exact path
    const answer = await askAdminCard(context, locale, { title: t('cli.backup.card.restoreTitle', {}, locale), body: [t('cli.backup.card.restoreSet', { set: terminalSafeText(set) }, locale),
      t('cli.backup.card.restoreTarget', { target: terminalSafeText(target) }, locale), t('cli.backup.card.restoreService', {}, locale), t('cli.backup.card.restoreKept', {}, locale)],
    options: confirmOptions(locale) });
    if (answer !== 'apply') return cancelled();
    confirmTarget ??= target;
  }
  const input = backupCommandSchema.safeParse({ schemaVersion: 1, action, set, scopeId: scope.scopeId, ...(target ? { target } : {}), ...(confirmTarget ? { confirmTarget } : {}) });
  if (!input.success) throw ErrorRegistry.createError('CLI_USAGE');
  const stdin = context.stdin ?? process.stdin;
  // C-PRIO finding: a terminal that cannot hide typing is its own cause, never "wrong passphrase".
  if (stdin.isTTY && !(stdin as { setRawMode?: unknown }).setRawMode) throw ErrorRegistry.createError('BACKUP_PASSPHRASE_PROMPT_UNAVAILABLE');
  const passphrase = stdin.isTTY ? await readHidden(stdin, context.stderr ?? process.stderr, t('cli.backup.passphrase', {}, locale)) : await readPiped(stdin);
  const result = await context.executeBackup(root, input.data, passphrase, options);
  if (!json) emit(scopeNotice(scope, locale), adminSinks(context));
  emit(result, { json, render: data => renderResult(data, locale), ...adminSinks(context) });
  // S4B-4 §6.6: the purges recorded after this set are re-applied at the next start; an unreadable journal is named, never passed over.
  if (action === 'restore' && !json && context.countMemoryPurgesPending) {
    const pending = await context.countMemoryPurgesPending(root, options).catch(() => null);
    if (pending === null) emit(t('error.MEMORY_PURGE_REPLAY_HELD', {}, locale), { level: 'warning', ...adminSinks(context) });
    else if (pending) emit(t('backup.restore.memoryPurges', { count: pending }, locale), adminSinks(context));
  }
}

async function listCommand(argv: readonly string[], context: AdminCommandContext): Promise<void> {
  let json = false, language: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--json' && !json) json = true;
    else if (flag === '--lang' && language === undefined) { language = argv[++i]; if (!language || language.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); }
    else if (flag !== '--no-color') throw ErrorRegistry.createError('CLI_USAGE');
  }
  const locale = commandLocale(context, language);
  if (!context.inspectBackupSets) throw ErrorRegistry.createError('CLI_USAGE');
  const view = await context.inspectBackupSets(context.root ?? process.cwd(), { env: context.env ?? process.env });
  emit(view, { json, render: () => renderBackupSets(view, locale, cliTableStyle(context), Date.now()), ...adminSinks(context) });
}
