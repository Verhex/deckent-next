import { t, type Locale } from '#platform/index.js';
import type { WorklineStartup } from '#surfaces/core/terminal/index.js';

/** What the opening banner states (T2 T-STARTUP); every value is already display text (the mode as its catalog word). */
export interface StartupFacts {
  readonly version: string;
  readonly project: string;
  readonly path: string;
  readonly model: string;
  readonly mode: string;
}

/** The banner's catalog text (terminal.banner.*): the mark (Unicode or ASCII), the title, the facts, the hint and the one-line form. */
export function terminalStartupLabels(locale: Locale, facts: StartupFacts, ascii: boolean): Pick<WorklineStartup, 'logo' | 'lines' | 'compact'> {
  return {
    logo: (ascii ? t('terminal.banner.logoAscii', {}, locale) : t('terminal.banner.logo', {}, locale)).split('\n'),
    lines: [t('terminal.banner.title', { version: facts.version }, locale), t('terminal.banner.project', { name: facts.project, path: facts.path }, locale),
      t('terminal.banner.modelMode', { model: facts.model, mode: facts.mode }, locale), t('terminal.banner.hint', {}, locale)],
    compact: t('terminal.banner.compact', { version: facts.version, name: facts.project, mode: facts.mode }, locale),
  };
}
