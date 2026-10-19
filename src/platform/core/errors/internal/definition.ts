import type { Locale, Params } from '#platform/core/i18n/index.js';
import type { ErrorCategory } from './error.js';
export interface ErrorEntry { readonly message: string; readonly suggestion?: string; readonly whatHappened?: string; readonly why?: string; readonly howToFix?: readonly string[] }
/** One registered error code: its exit category and the localized renderer. */
export interface ErrorDefinition { readonly category: ErrorCategory; readonly render: (params: Params, locale: Locale) => ErrorEntry }
export type ErrorDefinitions = Readonly<Record<string, ErrorDefinition>>;
