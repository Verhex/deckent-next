import { realpath } from 'node:fs/promises';
import { ErrorRegistry } from '#kernel/core/errors/index.js';
import { pathApi } from '#kernel/core/platform/index.js';

/** Lexical containment; filesystem operations additionally call validateExistingPath. */
export function validatePath(base: string, userPath: string, platform: string = process.platform): string {
  const api = pathApi(platform);
  if (!api.isAbsolute(base) || userPath.includes('\0')) throw ErrorRegistry.createError('PATH_TRAVERSAL');
  const resolvedBase = api.resolve(base);
  const resolved = api.resolve(resolvedBase, userPath);
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
