/** KG14 H1: the code any failure carries (a typed error, a Node errno, a wire `{ code }`), for presentation only; a floor decision uses `isCodedError`. */
export const errorCodeOf = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : null;
};
/** Nothing at the path: ENOENT, and with `notDir` also ENOTDIR (a parent is a file). EACCES, EIO and the rest are not absence. */
export const isAbsent = (error: unknown, options: { readonly notDir?: boolean } = {}): boolean => {
  const code = errorCodeOf(error);
  return code === 'ENOENT' || (options.notDir === true && code === 'ENOTDIR');
};
