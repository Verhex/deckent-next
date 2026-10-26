import { MESSAGE_REGISTRY, type Locale } from '#platform/index.js';
import { fillTemplate } from '#surfaces/core/terminal-render/index.js';
export const onboardingMessage = (key: string, params: Readonly<Record<string, string | number>>, locale: Locale): string => fillTemplate((MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[key] ?? key, params);
