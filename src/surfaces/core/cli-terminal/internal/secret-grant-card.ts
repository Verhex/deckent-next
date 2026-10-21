import type { SecretGrantCardPort } from '#surfaces/core/terminal-kit/index.js';
import { shortenHomePath } from '#surfaces/core/terminal-render/index.js';
import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';

/**
 * PRE-8 first-use card ports the executable wires (owner decisions 2026-10-21): `offer` is the composition's decision whether this terminal may be
 * asked (solo installation, attested human terminal); `grant` is the governed `secret grant` application with source `card`.
 */
export interface TerminalSecretGrantHandlers {
  offer(root: string, options: ConfigLoadOptions): Promise<boolean>;
  grant(root: string, scopeId: string, name: string, options: ConfigLoadOptions): Promise<void>;
  /** PRE-8 v2: the project credential decision for one name (typed refusal, no value read); `/provider` asks the card after storing a key. */
  check?(root: string, scopeId: string, name: string, options: ConfigLoadOptions): Promise<void>;
}
/** The workline's card port for this project and scope; its words come from the catalog (EN/TR) through the shared renderer. */
export function secretGrantCardPort(root: string, scopeId: string, options: ConfigLoadOptions, locale: Locale, handlers: TerminalSecretGrantHandlers,
  home?: string): SecretGrantCardPort {
  return {
    offer: () => handlers.offer(root, options),
    question: (name, project) => ({ title: t('tui.secretGrant.title', { name }, locale), prompt: t('tui.secretGrant.keys', {}, locale), lines: [
      { label: t('tui.secretGrant.label.project', {}, locale), text: shortenHomePath(project, home) },
      { label: t('tui.secretGrant.label.change', {}, locale), text: t('tui.secretGrant.change', {}, locale) },
      { label: t('tui.secretGrant.label.who', {}, locale), text: t('tui.secretGrant.who', {}, locale) },
      { label: t('tui.secretGrant.label.undo', {}, locale), text: t('tui.secretGrant.undo', { name, scope: scopeId }, locale) }] }),
    grant: name => handlers.grant(root, scopeId, name, options),
    ...(handlers.check ? { check: (name: string) => handlers.check!(root, scopeId, name, options) } : {}),
  };
}
