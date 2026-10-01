import { emit, resolveLocale, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { MonitorCommandContext } from './context.js';

/**
 * The CLI imports this unit at start-up for `workers`/`inventory`; the monitor's renderer and Ink view load only when a monitor runs
 * (the CLI keeps Ink out of every other command's start, like `terminal`).
 */
export async function monitorCommand(argv: readonly string[], context: MonitorCommandContext): Promise<void> {
  // `monitor --help [--lang <l>]` answers as cheaply as every other command's help; anything else goes to the full parser.
  const help = (argv.length === 2 || (argv.length === 4 && argv[2] === '--lang' && !argv[3]!.startsWith('-'))) && ['--help', '-h'].includes(argv[1]!);
  if (help) {
    const locale = resolveLocale(argv[3], context.env); context.onLocale?.(locale);
    emit(t('cli.monitor.help', {}, locale), { ...(context.stdout ? { stdout: context.stdout } : {}) });
    return;
  }
  await (await import('./command.js')).runMonitorCommand(argv, context);
}
export async function monitorSlash(root: string, args: string, context: MonitorCommandContext, options: ConfigLoadOptions, locale: Locale,
  width: number): Promise<readonly string[]> {
  return (await import('./command.js')).runMonitorSlash(root, args, context, options, locale, width);
}
/** The renderers and the fullscreen view (tests, frame dumps, other surfaces); loading it loads Ink. */
export const loadMonitorSurface = () => import('./surface.js');
