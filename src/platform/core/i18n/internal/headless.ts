import { t } from './t.js';
import type { Locale } from './types.js';

/** A shared explanation for the observed limit on a connected subscription sign-in. */
export function headlessGovernedUseText(locale: Locale, connection?: string): Readonly<{ text: string; next: string }> {
  return { text: t('headless.governedUse.blocked', {}, locale), next: t('headless.governedUse.next', { connection: connection ?? '<connection>' }, locale) };
}
