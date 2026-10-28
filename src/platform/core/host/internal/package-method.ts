import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { readProcessFile } from './service-manager.js';
import launchers from './launchers.json' with { type: 'json' };
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
/** S22 (lead 2026-10-27): a launcher the person wrote by hand for this folder (for example `~/.local/bin/deckent-<name>`): a registry-named,
 * bounded scan of the person's bin folders for a regular `deckent*` file whose text names this project. Deckent did not create it, so it only
 * names it and prints its removal; it never edits or deletes it. */
export function handMadeLaunchers(projectRoot: string, env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const home = env['HOME'], name = new RegExp(launchers.namePattern, 'u');
  if (!home) return [];
  return launchers.directories.flatMap(folder => {
    let names: string[]; try { names = readdirSync(join(home, folder)).slice(0, launchers.maxEntries); } catch { return []; }
    return names.filter(entry => name.test(entry)).map(entry => join(home, folder, entry))
      .filter(path => { try { return lstatSync(path).isFile() && (readProcessFile(path) ?? '').includes(projectRoot); } catch { return false; } });
  });
}
