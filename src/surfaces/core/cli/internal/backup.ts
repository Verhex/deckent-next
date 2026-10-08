import { emit, ErrorRegistry, formatValue, resolveLocale, t } from '#platform/index.js';
import { backupCommandSchema, type BackupCommand, type BackupResult } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';
import { readHidden, readPiped } from './secret.js';
export type BackupHandler = (root: string, command: BackupCommand, passphrase: string, options: import('#platform/index.js').ConfigLoadOptions) => Promise<BackupResult>;
export async function backupCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const action = argv[1];
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
    else throw ErrorRegistry.createError('CLI_USAGE');
  }
  const input = backupCommandSchema.safeParse({ schemaVersion: 1, action, set, scopeId,
    ...(target ? { target } : {}), ...(confirmTarget ? { confirmTarget } : {}) });
  if (!input.success || !context.executeBackup) throw ErrorRegistry.createError('CLI_USAGE');
  const locale = resolveLocale(language, context.env); context.onLocale?.(locale);
  const stdin = context.stdin ?? process.stdin;
  if (stdin.isTTY && !(stdin as { setRawMode?: unknown }).setRawMode) throw ErrorRegistry.createError('BACKUP_PASSPHRASE_INVALID');
  const passphrase = stdin.isTTY ? await readHidden(stdin, context.stderr ?? process.stderr, t('cli.backup.passphrase', {}, locale)) : await readPiped(stdin);
  const result = await context.executeBackup(context.root ?? process.cwd(), input.data, passphrase, { ...(context.env ? { env: context.env } : {}) });
  emit(result, { json, render: data => {
    const action = data.action === 'create' ? t('cli.backup.created', {}, locale)
      : data.action === 'verify' ? t('cli.backup.verified', {}, locale) : t('cli.backup.restored', {}, locale);
    return t('cli.backup.result', { action, set: data.set }, locale)
    + (data.relocation?.required ? '\n' + t('cli.backup.relocated', { target: data.relocation.target }, locale) : '')
    + (data.globalConfig?.added.length ? '\n' + t('cli.backup.globalAdded', { path: data.globalConfig.path, sections: data.globalConfig.added.join(', ') }, locale) : '')
    + (data.globalConfig?.kept.length ? '\n' + t('cli.backup.globalKept', { path: data.globalConfig.path, sections: data.globalConfig.kept.join(', ') }, locale) : '')
    + '\n' + formatValue(data); }, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
}
