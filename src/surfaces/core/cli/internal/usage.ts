import { ErrorRegistry, t, type Locale } from '#platform/index.js';

/** Only protocol command/flag names belong in diagnostics, never supplied values. */
export function cliUsage(family: 'run' | 'task', action: string | undefined, locale: Locale, flag?: string) {
  const known = family === 'run' ? ['create', 'reserve', 'inspect', 'cancel'] : ['execute', 'evaluate'];
  return ErrorRegistry.createError('CLI_USAGE', { params: {
    command: `deckent ${family}${action && known.includes(action) ? ` ${action}` : ''}`,
    usage: family === 'run' ? t('cli.help.run', {}, locale) : t('cli.help.task', {}, locale),
    ...(flag ? { flag } : {}),
  } });
}

export function shellIdentity(value: string | number): string {
  const text = String(value);
  return /^[A-Za-z0-9_./:-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}
