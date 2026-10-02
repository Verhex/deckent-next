import { t, type Locale } from '#platform/index.js';
import { span, type MonitorLine, type MonitorRole } from './layout.js';

/** Row change marks of the fullscreen view (`+` new, `*` changed since the previous snapshot); the same in Unicode and ASCII. */
export const CHANGE_GLYPHS = { added: '+', changed: '*' } as const;

/**
 * The `?` page: keys, then every glyph → colour role → meaning. The glyph and the words carry the meaning, so it reads the same under NO_COLOR
 * and ASCII (the colour column names the role a colour terminal shows).
 */
export function legendLines(locale: Locale, ascii: boolean, config = false): MonitorLine[] {
  const colour = (role: MonitorRole) => ({ info: t('monitor.legend.colour.info', {}, locale), warning: t('monitor.legend.colour.warning', {}, locale),
    error: t('monitor.legend.colour.error', {}, locale), success: t('monitor.legend.colour.success', {}, locale), muted: t('monitor.legend.colour.muted', {}, locale),
    accent: t('monitor.legend.colour.accent', {}, locale), strong: t('monitor.legend.colour.accent', {}, locale) })[role];
  const rows: readonly (readonly [string, string, MonitorRole, string])[] = [
    ['▶', '>', 'info', t('monitor.legend.progressing', {}, locale)], ['~', '~', 'warning', t('monitor.legend.waiting', {}, locale)],
    ['!', '!', 'error', t('monitor.legend.blocked', {}, locale)], ['✓', '+', 'success', t('monitor.legend.accepted', {}, locale)],
    ['✗', 'x', 'error', t('monitor.legend.failed', {}, locale)], ['■', '-', 'muted', t('monitor.legend.cancelled', {}, locale)],
    ['●', '*', 'success', t('monitor.legend.installOn', {}, locale)], ['○', 'o', 'error', t('monitor.legend.installOff', {}, locale)],
    ['⚠', '!', 'warning', t('monitor.legend.warning', {}, locale)], ['›', '>', 'accent', t('monitor.legend.selected', {}, locale)],
    ['≈', '~=', 'muted', t('monitor.legend.approx', {}, locale)],
    [CHANGE_GLYPHS.added, CHANGE_GLYPHS.added, 'accent', t('monitor.legend.added', {}, locale)],
    [CHANGE_GLYPHS.changed, CHANGE_GLYPHS.changed, 'accent', t('monitor.legend.changed', {}, locale)],
  ];
  const width = Math.max(...rows.map(row => colour(row[2]).length));
  return [
    ...t('monitor.live.help', {}, locale).split('\n').map(text => [span(text)]),
    ...(config ? [[span(t('config.surface.monitorHelp', {}, locale))]] : []),
    [span('')], [span(t('monitor.legend.title', {}, locale), 'accent')],
    ...rows.map(([unicode, plain, role, meaning]): MonitorLine => [span(`  ${ascii ? plain : unicode}  `, role), span(colour(role).padEnd(width + 2), 'muted'), span(meaning)]),
  ];
}
