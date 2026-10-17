import { WorkspacePatchError, historyPathSchema } from './contract.js';
/** Directory/file replacement and either end of a rename conflict with a patch path. Textual mergeability is irrelevant. */
export function patchPathsIntersect(a: string, b: string): boolean { return a === b || a.startsWith(b + '/') || b.startsWith(a + '/'); }
/** NUL is the protocol delimiter, never LF or whitespace. A truncated listing is not an empty change set. Paths are checked for shape only:
 * an intervening commit may change a path the patch could never write; it conflicts only through `assertDisjointHistory`. */
export function changedHistoryPaths(output: string): readonly string[] {
  if (!output) return [];
  if (!output.endsWith('\0')) throw new WorkspacePatchError('PATCH_CORRUPT');
  const paths = output.slice(0, -1).split('\0');
  if (paths.some(path => !historyPathSchema.safeParse(path).success)) throw new WorkspacePatchError('PATCH_UNSAFE');
  return paths;
}
export function assertDisjointHistory(paths: readonly string[], touched: readonly string[]): void {
  if (paths.some(path => touched.some(other => patchPathsIntersect(path, other)))) throw new WorkspacePatchError('PATCH_BASE_ADVANCED');
}
