import { ErrorRegistry, emit, formatValue, resolveLocale, t } from '#platform/index.js';
import type { InstallationPreview } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';

export interface InstallationPreviewInput { readonly profilePath: string; readonly allowShutdown: boolean }
export type InstallationPreviewHandler = (projectRoot: string, input: InstallationPreviewInput) => Promise<InstallationPreview>;

/** Preview is deliberately non-mutating. No surface invents profile data or policy grants. */
export async function initCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const action = argv[1]; let profilePath: string | undefined, language: string | undefined;
  let json = false, allowShutdown = false;
  if (!['preview', '--help', '-h'].includes(action ?? '')) throw ErrorRegistry.createError('CLI_USAGE');
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--allow-shutdown' && !allowShutdown) { allowShutdown = true; continue; }
    if (flag === '--no-color') continue;
    if (flag === '--profile' && profilePath === undefined) {
      profilePath = argv[++i];
      if (!profilePath || profilePath.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      continue;
    }
    if (flag === '--lang' && language === undefined) {
      language = argv[++i];
      if (!language || language.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      continue;
    }
    throw ErrorRegistry.createError('CLI_USAGE');
  }
  const locale = resolveLocale(language, context.env); context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (action === '--help' || action === '-h') {
    if (profilePath || allowShutdown || json) throw ErrorRegistry.createError('CLI_USAGE');
    emit(t('cli.help.initPreview', {}, locale), sinks); return;
  }
  if (!profilePath) throw ErrorRegistry.createError('INSTALL_PROFILE_REQUIRED');
  if (!context.previewInstallation) throw ErrorRegistry.createError('INSTALL_PREVIEW_UNAVAILABLE');
  const result = await context.previewInstallation(context.root ?? process.cwd(), { profilePath, allowShutdown });
  emit(result, { ...sinks, json, render: value => `${t('cli.init.previewOnly', {}, locale)}\n${formatValue(value)}` });
}
