import { ErrorRegistry, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { terminalConfigWrite, type ConfigCommandContext } from '#surfaces/core/config/index.js';
import { TERMINAL_THEME_SETTINGS, terminalPalette, resolveTerminalTheme, type ColorTier, type TerminalThemeSetting } from '#surfaces/core/terminal-kit/index.js';
import type { SpanRole } from '#surfaces/core/terminal-render/index.js';
import type { ThemePanelPort } from '#surfaces/core/terminal-panels/index.js';

/** The host supplies its existing palette setter and probe result; this human surface only composes the existing governed config writer. */
export function themePanelPort(root: string, context: ConfigCommandContext, options: ConfigLoadOptions, locale: Locale,
  runtime: Readonly<{ setting: TerminalThemeSetting; capability: ColorTier; colorfgbg?: string | undefined;
    background: () => string | null; apply: (setting: TerminalThemeSetting) => void }>): ThemePanelPort {
  let current = runtime.setting;
  const settingOf = (id: string): TerminalThemeSetting => {
    const selected = TERMINAL_THEME_SETTINGS.find(setting => setting === id);
    if (!selected) throw ErrorRegistry.createError('CLI_USAGE');
    return selected;
  };
  const samples: readonly SpanRole[] = ['assistantLabel', 'assistant', 'link', 'code', 'chipOk', 'chipWarn', 'chipFail', 'stateConnected', 'stateDisconnected', 'diffAdded', 'diffRemoved', 'mutedId'];
  const names = { 'auto': t('tui.theme.name.auto', {}, locale), 'dark': t('tui.theme.name.dark', {}, locale), 'light': t('tui.theme.name.light', {}, locale), 'dark-daltonized': t('tui.theme.name.dark-daltonized', {}, locale), 'light-daltonized': t('tui.theme.name.light-daltonized', {}, locale), 'dark-ansi': t('tui.theme.name.dark-ansi', {}, locale), 'light-ansi': t('tui.theme.name.light-ansi', {}, locale), 'dark-high-contrast': t('tui.theme.name.dark-high-contrast', {}, locale), 'light-high-contrast': t('tui.theme.name.light-high-contrast', {}, locale), 'ansi': t('tui.theme.name.ansi', {}, locale) };
  const details = { 'dark': t('tui.theme.detail.dark', {}, locale), 'light': t('tui.theme.detail.light', {}, locale), 'dark-daltonized': t('tui.theme.detail.dark-daltonized', {}, locale), 'light-daltonized': t('tui.theme.detail.light-daltonized', {}, locale), 'dark-ansi': t('tui.theme.detail.dark-ansi', {}, locale), 'light-ansi': t('tui.theme.detail.light-ansi', {}, locale), 'dark-high-contrast': t('tui.theme.detail.dark-high-contrast', {}, locale), 'light-high-contrast': t('tui.theme.detail.light-high-contrast', {}, locale), 'ansi': t('tui.theme.detail.ansi', {}, locale) };
  const sources = { 'project': t('tui.theme.source.project', {}, locale), 'global': t('tui.theme.source.global', {}, locale), 'default': t('tui.theme.source.default', {}, locale), 'env': t('tui.theme.source.env', {}, locale) };
  const sampleWords = { 'assistantLabel': t('tui.theme.sample.assistantLabel', {}, locale), 'assistant': t('tui.theme.sample.assistant', {}, locale), 'link': t('tui.theme.sample.link', {}, locale), 'code': t('tui.theme.sample.code', {}, locale), 'chipOk': t('tui.theme.sample.chipOk', {}, locale), 'chipWarn': t('tui.theme.sample.chipWarn', {}, locale), 'chipFail': t('tui.theme.sample.chipFail', {}, locale), 'stateConnected': t('tui.theme.sample.stateConnected', {}, locale), 'stateDisconnected': t('tui.theme.sample.stateDisconnected', {}, locale), 'diffAdded': t('tui.theme.sample.diffAdded', {}, locale), 'diffRemoved': t('tui.theme.sample.diffRemoved', {}, locale), 'mutedId': t('tui.theme.sample.mutedId', {}, locale) };
  return {
    title: t('tui.theme.title', {}, locale), background: runtime.background,
    words: { hints: t('tui.theme.hints', {}, locale), current: t('tui.theme.current', {}, locale), preview: t('tui.theme.preview', {}, locale), contrast: t('tui.theme.contrast', {}, locale), inherited: t('tui.theme.inherited', {}, locale),
      noColor: t('tui.theme.noColor', {}, locale), sessionOnly: t('tui.theme.sessionOnly', {}, locale), samples: samples.flatMap(role => [{ role, text: sampleWords[role as keyof typeof sampleWords] }, ...(role === 'code' ? [{ role, text: t('tui.theme.sample.codeBlock', {}, locale) }] : [])]) },
    palette: setting => terminalPalette(settingOf(setting), runtime.capability, runtime.colorfgbg, runtime.background()),
    apply(id) { const setting = settingOf(id); runtime.apply(setting); current = setting; },
    async inspect() {
      const field = await context.configApplication!(root, options).explain({ keyPath: 'terminal.theme' });
      const shadow = field.source === 'project';
      const background = runtime.background();
      const tone = resolveTerminalTheme('auto', runtime.capability, runtime.colorfgbg, background).background;
      return { current, source: t('tui.theme.source', { value: String(field.value), source: sources[field.source] }, locale),
        notes: [[shadow ? t('tui.theme.shadow', {}, locale) : t('tui.theme.target', {}, locale), ...(runtime.capability === 'none' ? [t('tui.theme.noColor', {}, locale)] : [])].join(' '), t('tui.theme.scrollback', {}, locale)],
        choices: TERMINAL_THEME_SETTINGS.filter(id => id !== 'ansi' || current === 'ansi').map(id => ({ id, label: names[id],
          detail: id === 'auto' ? t('tui.theme.detected', { tone: tone === 'unknown' ? t('tui.theme.unknown', {}, locale) : names[tone], background: background ?? t('tui.theme.unknown', {}, locale) }, locale) : details[id] })) };
    },
    write: value => terminalConfigWrite(root, { action: 'set', keyPath: 'terminal.theme', value: settingOf(value), layer: 'global' }, context, options, locale),
  };
}
