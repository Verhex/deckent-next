import { t, type Locale, type MessageKey, type Params } from '#platform/core/i18n/index.js';
import type { ErrorCategory } from './error.js';
import { mergeErrorDefinitions } from './merge.js';
export interface ErrorEntry { readonly message: string; readonly suggestion?: string; readonly whatHappened?: string; readonly why?: string; readonly howToFix?: readonly string[] }
/** KG3 F3: the authorization-refusal class a code belongs to. One class per code; a caller names the classes it counts (`isAuthorizationRefusal`). */
export type AuthorizationRefusal = 'policy-denied' | 'approval-unsupported' | 'scope-unknown' | 'approval-denied' | 'policy-unavailable' | 'authentication' | 'delivery';
/** Owner B2-1 (2026-11-09): the one authorization-refusal class every person-facing surface counts; engine recovery and reconciliation keep their own lists. */
export const PERSON_AUTHORIZATION_REFUSALS: readonly AuthorizationRefusal[] = Object.freeze(['policy-denied', 'approval-unsupported', 'scope-unknown', 'approval-denied', 'delivery']);
/** One registered error code: its exit category, the localized renderer, its refusal class and its launch disposition (`permanent` closes the
 * Attempt as `launch-refused`, `held` parks the Run; absent = transient). */
export interface ErrorDefinition { readonly category: ErrorCategory; readonly render: (params: Params, locale: Locale) => ErrorEntry;
  readonly refusal?: AuthorizationRefusal; readonly launch?: 'permanent' | 'held' }
export type ErrorDefinitions = Readonly<Record<string, ErrorDefinition>>;
/** The codes a catalog family names `<prefix><CODE>`; a code with no catalog sentence does not type-check. */
type PlainCode<P extends string> = MessageKey extends infer K ? K extends `${P}${infer C}` ? C : never : never;
/** KG14 F-H2c: codes whose only text is their catalog sentence `<prefix><CODE>` with the caller's params (`scripts/architecture-check.mjs` checks each key). */
export const plainErrors = <P extends string>(prefix: P, codes: { readonly [C in PlainCode<P>]?: ErrorCategory }): ErrorDefinitions =>
  Object.freeze(Object.fromEntries(Object.entries(codes as Readonly<Record<string, ErrorCategory>>).map(([code, category]) => {
    const key = `${prefix}${code}` as MessageKey;
    return [code, { category, render: (p: Params, l: Locale) => ({ message: t(key, p, l) }) }];
  })));
/** One table from its parts in source order; a code defined in two parts fails closed (ERROR_REGISTRY_DUPLICATE), as across fragments. */
export const errorTable = (source: string, ...parts: readonly ErrorDefinitions[]): ErrorDefinitions => mergeErrorDefinitions(parts.map(part => [source, part]));
