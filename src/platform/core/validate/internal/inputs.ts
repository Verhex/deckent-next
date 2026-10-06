import { realpath } from 'node:fs/promises';
import { ErrorRegistry } from '#platform/core/errors/index.js';
import { foldWslDrivePath, isWslHost, pathApi, type Environment } from '#platform/core/host/index.js';

/** Lexical containment; filesystem operations additionally call validateExistingPath. */
export function validatePath(base: string, userPath: string, platform: string = process.platform, env: Environment = process.env): string {
  const api = pathApi(platform);
  if (!api.isAbsolute(base) || userPath.includes('\0')) throw ErrorRegistry.createError('PATH_TRAVERSAL');
  // WSL drvfs: `/mnt/c` and `/mnt/C` are one root; both sides use the canonical drive spelling (Linux keeps case-sensitive letters).
  const fold = isWslHost(platform, env) ? foldWslDrivePath : (path: string) => path;
  const resolvedBase = fold(api.resolve(base));
  const resolved = fold(api.resolve(resolvedBase, fold(userPath)));
  const relative = api.relative(resolvedBase, resolved);
  if (relative === '..' || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) throw ErrorRegistry.createError('PATH_TRAVERSAL');
  if (platform === 'win32' && (/[<>"|?*]/.test(userPath) || relative.includes(':') || relative.split(api.sep).some(p => /[. ]$/.test(p)))) throw ErrorRegistry.createError('PATH_TRAVERSAL');
  return resolved;
}
export async function validateExistingPath(base: string, userPath: string): Promise<string> {
  const candidate = validatePath(base, userPath);
  return validatePath(await realpath(base), await realpath(candidate));
}
export function validateTaskId(id: string): string {
  if (!/^[\w-]{1,100}$/.test(id)) throw ErrorRegistry.createError('INVALID_TASK_ID');
  return id;
}
