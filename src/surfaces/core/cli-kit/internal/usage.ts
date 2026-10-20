import { ErrorRegistry, t, type Locale } from '#platform/index.js';
import { hasCliAction } from './command-catalog.js';

/** Only protocol command/flag names belong in diagnostics, never supplied values. */
export function cliUsage(family: 'run' | 'task' | 'do', action: string | undefined, locale: Locale, flag?: string) {
  // L-HELP J1b: the one catalog decides which action names a usage error may echo (no second hand-kept action list).
  return ErrorRegistry.createError('CLI_USAGE', { params: {
    command: `deckent ${family}${action && hasCliAction(family, action) ? ` ${action}` : ''}`,
    usage: family === 'do' ? t('cli.help.do', {}, locale) : family === 'run' ? t('cli.help.run', {}, locale) : t('cli.help.task', {}, locale),
    ...(flag ? { flag } : {}),
  } });
}

export function shellIdentity(value: string | number): string {
  const text = String(value);
  return /^[A-Za-z0-9_./:-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}
