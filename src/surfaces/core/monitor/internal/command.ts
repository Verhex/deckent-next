import { configCommand } from '#surfaces/core/config/index.js';
import { createElement } from 'react';
import { render } from 'ink';
import { ErrorRegistry, colorTier, emit, loadConfig, resolveLocale, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { MonitorSnapshot } from '#engine/index.js';
import { resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { prefersAsciiGlyphs } from '#surfaces/core/terminal-render/index.js';
import type { MonitorCommandContext } from './context.js';
import { MonitorApp } from './app.js';
import { renderMonitorText } from './text.js';
import { filterSnapshot, type MonitorFilters } from './view.js';

/** The data lane's read (composition): every observed install as one observe-only MonitorSnapshot. */
export type MonitorHandler = (root: string, options: ConfigLoadOptions) => Promise<MonitorSnapshot>;
interface Parsed { once: boolean; json: boolean; help: boolean; noColor: boolean; install?: string; scope?: string; language?: string }
const DEFAULT_TEXT_WIDTH = 120;
const FLAGS = { '--help': 'help', '--once': 'once', '--json': 'json', '--no-color': 'noColor' } as const;
const VALUES = { '--install': 'install', '--scope': 'scope', '--lang': 'language' } as const;

function parse(argv: readonly string[], start: number): Parsed {
  const parsed: Parsed = { once: false, json: false, help: false, noColor: false };
  for (let index = start; index < argv.length; index++) {
    const arg = argv[index] === '-h' ? '--help' : argv[index]!;
    // Own keys only: `toString` and friends are not flags.
    const flag = Object.hasOwn(FLAGS, arg) ? FLAGS[arg as keyof typeof FLAGS] : undefined;
    if (flag) { if (parsed[flag]) throw ErrorRegistry.createError('CLI_USAGE'); parsed[flag] = true; continue; }
    const field = Object.hasOwn(VALUES, arg) ? VALUES[arg as keyof typeof VALUES] : undefined;
    const value = argv[++index];
    if (!field || !value || value.startsWith('-') || parsed[field] !== undefined) throw ErrorRegistry.createError('CLI_USAGE');
    parsed[field] = value;
  }
  if (parsed.help && argv.length - start > 1 + (parsed.language ? 2 : 0)) throw ErrorRegistry.createError('CLI_USAGE');
  return parsed;
}
const filtersOf = (parsed: Parsed): MonitorFilters => ({ ...(parsed.install ? { install: parsed.install } : {}), ...(parsed.scope ? { scope: parsed.scope } : {}) });

/** A typed failure in catalog words with its code; anything else is one fixed sentence (no transport or provider text on screen). */
export function monitorFailureText(error: unknown, locale: Locale): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ErrorRegistry.has(code)) {
    const params = (error as { params?: Readonly<Record<string, string | number>> }).params ?? {};
    return `${ErrorRegistry.get(code, locale, params)?.message ?? code} [${code}]`;
  }
  return t('monitor.live.failed', {}, locale);
}

function interactive(context: MonitorCommandContext): boolean {
  const stdin = context.stdin ?? process.stdin, stdout: unknown = context.stdout ?? process.stdout;
  return Boolean(stdin.isTTY) && Boolean((stdout as { isTTY?: boolean }).isTTY) && (context.env ?? process.env)['TERM'] !== 'dumb';
}
function textWidth(context: MonitorCommandContext): number {
  const stdout = (context.stdout ?? process.stdout) as { isTTY?: boolean; columns?: number };
  if (stdout.isTTY && stdout.columns) return stdout.columns;
  const columns = Number((context.env ?? process.env)['COLUMNS']);
  return Number.isSafeInteger(columns) && columns >= 20 ? columns : DEFAULT_TEXT_WIDTH;
}

/**
 * `deckent monitor` (MONITOR-SURFACE): on a real terminal without `--once`/`--json` the fullscreen live monitor (alternate screen, the
 * person's opt-in by running this command); otherwise one plain-text snapshot (`--once`, pipes, CI) or the snapshot as JSON (`--json`,
 * unchanged unless `--install`/`--scope` narrow it). Observe-only: nothing here claims, cancels or decides.
 */
export async function runMonitorCommand(argv: readonly string[], context: MonitorCommandContext): Promise<void> {
  if (argv.includes('--config')) {
    const flags = argv.filter((arg, i) => i > 0 && arg !== '--config' && arg !== '--once');
    if (flags.some(flag => !['--json', '--lang', 'en', 'tr', '--no-color', '--help', '-h'].includes(flag))) throw ErrorRegistry.createError('CLI_USAGE');
    await configCommand(['config', ...flags], context); return;
  }
  const parsed = parse(argv, 1), env = context.env ?? process.env;
  let locale = resolveLocale(parsed.language, env); context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (parsed.help) { emit(t('cli.monitor.help', {}, locale), sinks); return; }
  if (!context.inspectMonitor) throw ErrorRegistry.createError('MONITOR_UNAVAILABLE');
  const root = context.root ?? process.cwd(), options: ConfigLoadOptions = { env };
  const config = await loadConfig(root, { ...options, heal: false });
  locale = resolveLocale(parsed.language, env, config.language); context.onLocale?.(locale);
  const inspect = context.inspectMonitor, filters = filtersOf(parsed), ascii = prefersAsciiGlyphs(env);
  if (parsed.json) { emit(filterSnapshot(await inspect(root, options), filters), { ...sinks, json: true }); return; }
  if (parsed.once || !interactive(context)) {
    emit(await inspect(root, options), { ...sinks, render: snapshot => renderMonitorText(snapshot, { locale, width: textWidth(context), ascii, filters }) });
    return;
  }
  const palette = resolveWorklinePalette(colorTier({ env, isTTY: true, noColor: parsed.noColor }));
  const instance = render(createElement(MonitorApp, { load: () => inspect(root, options), intervalMs: config.inspection.workers.heartbeatMs, locale, ascii, palette, filters,
    ...(context.configApplication ? { loadConfigView: () => context.configApplication!(root, options).inspect() } : {}),
    errorText: (error: unknown) => monitorFailureText(error, locale) }), { alternateScreen: true, patchConsole: false,
    ...(context.stdout ? { stdout: context.stdout as unknown as NodeJS.WriteStream } : {}), ...(context.stdin ? { stdin: context.stdin as unknown as NodeJS.ReadStream } : {}) });
  const stop = () => instance.unmount();
  context.signal?.addEventListener('abort', stop, { once: true });
  try { await instance.waitUntilExit(); } finally { context.signal?.removeEventListener('abort', stop); }
}

/** `/monitor` in the interactive terminal: the same text snapshot as notice lines (`--install`/`--scope` accepted). */
export async function runMonitorSlash(root: string, args: string, context: MonitorCommandContext, options: ConfigLoadOptions, locale: Locale,
  width: number): Promise<readonly string[]> {
  const parsed = parse(['monitor', ...args.split(/\s+/).filter(Boolean)], 1);
  if (parsed.once || parsed.json || parsed.help || parsed.language || parsed.noColor) return [t('monitor.slash.usage', {}, locale)];
  if (!context.inspectMonitor) throw ErrorRegistry.createError('MONITOR_UNAVAILABLE');
  const snapshot = await context.inspectMonitor(root, options);
  return renderMonitorText(snapshot, { locale, width, ascii: prefersAsciiGlyphs(context.env ?? process.env), filters: filtersOf(parsed) }).split('\n');
}
