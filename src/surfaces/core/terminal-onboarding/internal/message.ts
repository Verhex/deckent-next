import { messageText, type Locale } from '#platform/index.js';
export const onboardingMessage = (key: string, params: Readonly<Record<string, string | number>>, locale: Locale): string => messageText(key, locale, params) ?? key;
