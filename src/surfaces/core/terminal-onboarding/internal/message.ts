import { headlessGovernedUseText, messageText, type Locale } from '#platform/index.js';
export function onboardingMessage(key: string, params: Readonly<Record<string, string | number>>, locale: Locale): string {
  if (key === 'headless.governedUse.blocked' || key === 'setup.work.governedUseBlocked') { const { text, next } = headlessGovernedUseText(locale, String(params['connection'])); return `${text} ${next}`; }
  return messageText(key, locale, params) ?? key;
}
