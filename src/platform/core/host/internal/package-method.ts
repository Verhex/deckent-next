import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * K5 (owner 2026-10-27): the command that removes the running program, derived from where this code really is: a global npm package
 * (`<prefix>/lib/node_modules/<name>`) gives `npm uninstall -g`, with `--prefix` when that is not the running Node's own prefix. Anything else
 * (a development build, an unknown method) is null and the person gets generic guidance. Uninstall only prints it; it never runs it.
 */
export function packageRemovalCommand(file = fileURLToPath(import.meta.url), execPath = process.execPath): string | null {
  let directory: string;
  try { directory = dirname(realpathSync(file)); } catch { return null; }
  for (; dirname(directory) !== directory; directory = dirname(directory)) {
    const scoped = basename(dirname(directory)).startsWith('@'), modules = scoped ? dirname(dirname(directory)) : dirname(directory);
    if (basename(modules) !== 'node_modules' || basename(dirname(modules)) !== 'lib') continue;
    let name: unknown;
    try { name = (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown }).name; } catch { return null; }
    if (name !== (scoped ? `${basename(dirname(directory))}/${basename(directory)}` : basename(directory))) return null;
    const prefix = dirname(dirname(modules));
    return prefix === dirname(dirname(execPath)) ? `npm uninstall -g ${name}` : `npm uninstall -g --prefix ${JSON.stringify(prefix)} ${name}`;
  }
  return null;
}
