import { basename } from 'node:path';
import { loadConfigTerminalLaunch, uninstallRetired, colorCapability, resolveLocale, t, terminalSafeText, PACKAGE_VERSION, TERMINAL_SCOPE_ID_SCHEMA, type Locale } from '#platform/index.js';
import { openTerminalShell, STARTUP_BANNERS, type TerminalShell, type WorklineStartup } from '#surfaces/core/terminal-host/index.js';
import { resolveTerminalTheme, resolveWorklinePalette, TERMINAL_THEME_SETTINGS, type TerminalThemeSetting } from '#surfaces/core/terminal-theme/index.js';
import { prefersAsciiGlyphs, shortenHomePath } from '#surfaces/core/terminal-render/index.js';
import { terminalStartupLabels, worklineLabels } from '#surfaces/core/terminal-labels/index.js';
import type { CommandContext } from './kernel-commands.js';

type TerminalSection = Readonly<{ scopeId?: unknown; layout?: string; clearOnStart?: boolean; notify?: string; theme?: TerminalThemeSetting; banner?: WorklineStartup['banner'] }>;
/**
 * alpha.60 C (P4, owner 2026-10-31): the full window drawn before the host graph loads, only where the Workline will open in the full window
 * the same way: bare `deckent` or `deckent --scope <id>` on a TTY, a readable configuration with a scope, not the inline layout, not
 * `clearOnStart: false`, not a retired installation. Anything else (and any read that fails) returns null: the launch keeps its old path.
 * The shell reads the presentation layers only (`loadConfigTerminalLaunch`: no policy, identity, service, model or full configuration, which
 * the host's registrations validate later); its banner names no model until the Workline reads the chat plan.
 */
export async function openLaunchShell(words: readonly string[], language: string | undefined, context: CommandContext): Promise<TerminalShell | null> {
  const flagged = words.length === 2 && words[0] === '--scope' ? words[1] : undefined;
  if (words.length !== 0 && !flagged) return null;
  const env = context.env ?? process.env, root = context.root ?? process.cwd();
  const config = await loadConfigTerminalLaunch(root, { env }).catch(() => null), terminal = (config?.terminal ?? {}) as TerminalSection;
  // The shell draws before the host validates the configuration: every value it uses must pass the section's own rule (scope schema, the
  // banner and theme vocabularies) and render unchanged through the shared control-character projection; anything else takes the old path.
  const scopeId = TERMINAL_SCOPE_ID_SCHEMA.safeParse(flagged ?? terminal.scopeId).data, valid = (value: unknown, words: readonly string[]) => value === undefined || words.includes(value as string);
  if (!config || !scopeId || terminalSafeText(scopeId) !== scopeId || !valid(terminal.theme, TERMINAL_THEME_SETTINGS) || !valid(terminal.banner, STARTUP_BANNERS)
    || terminal.layout === 'inline' || terminal.clearOnStart === false || await uninstallRetired(config.dataRoot).catch(() => true)) return null;
  const locale: Locale = resolveLocale(language, env, config.language), ascii = prefersAsciiGlyphs(env), labels = worklineLabels(locale, '');
  const theme = resolveTerminalTheme(terminal.theme ?? TERMINAL_THEME_SETTINGS[0], colorCapability({ env, isTTY: true, argv: process.argv }), env['COLORFGBG']);
  const startup: WorklineStartup = { clear: true, banner: terminal.banner ?? STARTUP_BANNERS[0], ...terminalStartupLabels(locale,
    { version: PACKAGE_VERSION, project: basename(root), path: shortenHomePath(root, env['HOME'] ?? env['USERPROFILE']), model: t('terminal.shell.modelPending', {}, locale) }, ascii) };
  return openTerminalShell({ palette: resolveWorklinePalette(theme.tier, theme.theme), ascii, clearScreen: true, attention: terminal.notify !== 'off', startup,
    ...(context.stdin ? { stdin: context.stdin as NodeJS.ReadStream } : {}), ...(context.stdout ? { stdout: context.stdout as unknown as NodeJS.WriteStream } : {}), ...(context.signal ? { signal: context.signal } : {}),
    labels: { composer: labels.composer, prompt: labels.prompt, banner: labels.banner, hint: labels.hint, status: `${scopeId} · ${t('terminal.shell.preparing', {}, locale)}`,
      queued: t('terminal.shell.queued', {}, locale), dropped: t('terminal.shell.dropped', {}, locale) } });
}
