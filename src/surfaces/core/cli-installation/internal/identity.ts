import { ErrorRegistry, emit, loadConfigLanguage, resolveLocale, t } from '#platform/index.js';
import type { InstallationIdentityChoice } from '#domain/index.js';
import type { InstallationCommandContext } from './context.js';

/** Explicit local recovery in the existing init family; never inferred from a default or a prompt timeout. */
export async function identityCommand(argv: readonly string[], context: InstallationCommandContext): Promise<void> {
  let choice: InstallationIdentityChoice | undefined, language: string | undefined, json = false;
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index];
    if ((flag === '--keep' || flag === '--new') && choice === undefined) choice = flag === '--keep' ? 'keep' : 'new';
    else if (flag === '--json' && !json) json = true;
    else if (flag === '--no-color') continue;
    else if (flag === '--lang' && language === undefined) {
      language = argv[++index];
      if (!language || language.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  const root = context.root ?? process.cwd(), options = { ...(context.env ? { env: context.env } : {}), heal: false };
  const locale = resolveLocale(language, context.env, await loadConfigLanguage(root, options)); context.onLocale?.(locale);
  if (!choice) throw ErrorRegistry.createError('INSTALLATION_IDENTITY_RELOCATED');
  if (!context.resolveInstallationIdentity) throw ErrorRegistry.createError('CLI_USAGE');
  const result = await context.resolveInstallationIdentity(root, choice, options);
  emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}),
    render: value => t('cli.identity.resolved', { previous: value.previousInstallationId, current: value.installationId,
      choice: value.choice === 'keep' ? t('cli.identity.keep', {}, locale) : t('cli.identity.new', {}, locale) }, locale) });
}
