import type { ConfigLoadOptions, Locale } from '#platform/index.js';
import type { MonitorCommandContext } from './context.js';

/**
 * The CLI imports this unit at start-up for `workers`/`inventory`; the monitor's renderer and Ink view load only when a monitor runs
 * (the CLI keeps Ink out of every other command's start, like `terminal`).
 */
export async function monitorCommand(argv: readonly string[], context: MonitorCommandContext): Promise<void> {
  await (await import('./command.js')).runMonitorCommand(argv, context);
}
export async function monitorSlash(root: string, args: string, context: MonitorCommandContext, options: ConfigLoadOptions, locale: Locale,
  width: number): Promise<readonly string[]> {
  return (await import('./command.js')).runMonitorSlash(root, args, context, options, locale, width);
}
/** The renderers and the fullscreen view (tests, frame dumps, other surfaces); loading it loads Ink. */
export const loadMonitorSurface = () => import('./surface.js');
