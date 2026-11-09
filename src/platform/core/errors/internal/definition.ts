import type { Locale, Params } from '#platform/core/i18n/index.js';
import type { ErrorCategory } from './error.js';
export interface ErrorEntry { readonly message: string; readonly suggestion?: string; readonly whatHappened?: string; readonly why?: string; readonly howToFix?: readonly string[] }
/** KG3 F3: the authorization-refusal class a code belongs to. One class per code; a caller names the classes it counts (`isAuthorizationRefusal`). */
export type AuthorizationRefusal = 'policy-denied' | 'approval-unsupported' | 'scope-unknown' | 'approval-denied' | 'policy-unavailable' | 'authentication' | 'delivery';
/** One registered error code: its exit category, the localized renderer, its refusal class and its launch disposition (`permanent` closes the
 * Attempt as `launch-refused`, `held` parks the Run; absent = transient). */
export interface ErrorDefinition { readonly category: ErrorCategory; readonly render: (params: Params, locale: Locale) => ErrorEntry;
  readonly refusal?: AuthorizationRefusal; readonly launch?: 'permanent' | 'held' }
export type ErrorDefinitions = Readonly<Record<string, ErrorDefinition>>;
