import { messageText, type Locale } from '#platform/index.js';
import { fillTemplate } from '#surfaces/core/terminal-render/index.js';
export const onboardingMessage = (key: string, params: Readonly<Record<string, string | number>>, locale: Locale): string => fillTemplate(messageText(key, locale) ?? key, params);
