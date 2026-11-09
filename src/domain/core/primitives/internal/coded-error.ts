/** KG14 H1: the one coded error base. Twin of platform/core/errors `CodedError` (both packages import nothing; the persisted-schema precedent).
 * The shared `Symbol.for` brand, not the class identity, marks a coded error: either twin, a subclass and a separately distributed copy all pass. */
const CODED = Symbol.for('deckent.coded-error');
export class CodedError<C extends string = string> extends Error {
  declare readonly params?: Readonly<Record<string, unknown>> | undefined;
  constructor(readonly code: C, options: { readonly message?: string; readonly params?: Readonly<Record<string, unknown>>; readonly cause?: unknown } = {}) {
    super(options.message ?? code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name; if (options.params !== undefined) this.params = options.params;
  }
} Object.defineProperty(CodedError.prototype, CODED, { value: true });
/** A floor decision reads a code only through this brand check; a plain `{ code }` (wire, foreign object) never passes. */
export const isCodedError = <C extends string>(error: unknown, code: C): error is CodedError<C> => typeof error === 'object' && error !== null && (error as { [CODED]?: unknown })[CODED] === true && (error as { code?: unknown }).code === code;
