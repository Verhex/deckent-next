import type { StandardSchemaV1 } from './standard-schema.js';

/** Outcome of validating through a Standard Schema at a synchronous Deckent boundary. `async` means the schema answered with a
 * Promise: Deckent's registry and config validation are synchronous, so the caller refuses it with its own typed code. */
export type StandardSyncValidation<Output> =
  | { readonly status: 'valid'; readonly value: Output }
  | { readonly status: 'invalid'; readonly issues: readonly StandardSchemaV1.Issue[] }
  | { readonly status: 'async' };

/** Structural check for a Standard Schema v1 object (spec 1.1.0): `~standard.version === 1` and a `validate` function. The vendor
 * name is descriptive and never checked. Accessors are not invoked beyond the two reads. */
export function isStandardSchemaV1(value: unknown): value is StandardSchemaV1 {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const props: unknown = (value as { readonly '~standard'?: unknown })['~standard'];
  return typeof props === 'object' && props !== null && (props as { version?: unknown }).version === 1
    && typeof (props as { validate?: unknown }).validate === 'function';
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function';

/** Calls `~standard.validate` once and never awaits. A Promise result is reported as `async` after its rejection is consumed, so a
 * refused asynchronous schema cannot surface later as an unhandled rejection. A result that is not a spec result object (a foreign
 * implementation's bug) is `invalid` with no issues; a truthy `issues` is failure, per the spec ("a falsy value for issues indicates
 * success"). Exceptions thrown by `validate` propagate unchanged (same as a throwing zod refinement today). */
export function validateStandardSchemaSync<Output>(schema: StandardSchemaV1<unknown, Output>, value: unknown): StandardSyncValidation<Output> {
  const result: unknown = schema['~standard'].validate(value);
  if (isThenable(result)) {
    Promise.resolve(result).catch(() => undefined);
    return { status: 'async' };
  }
  if (typeof result !== 'object' || result === null) return { status: 'invalid', issues: [] };
  const { issues } = result as { readonly issues?: unknown };
  if (issues) return { status: 'invalid', issues: Array.isArray(issues) ? issues as readonly StandardSchemaV1.Issue[] : [] };
  return { status: 'valid', value: (result as StandardSchemaV1.SuccessResult<Output>).value };
}
