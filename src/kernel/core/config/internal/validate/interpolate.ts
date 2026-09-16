import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorRegistry } from '../../../errors/index.js';
import { isRecord } from '../../../utils/index.js';
export async function readDeckSecrets(projectRoot: string): Promise<Readonly<Record<string, string>>> {
  let text: string;
  try { text = await readFile(join(projectRoot, '.deck'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw ErrorRegistry.createError('CONFIG_READ_IO_HOLD', { cause: error }); }
  const secrets: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    secrets[match[1]!] = value;
  }
  return secrets;
}
export function interpolateConfig<T>(config: T, secrets: Readonly<Record<string, string>>, missing: (key: string) => void = () => {}, resolved: (path: string) => void = () => {}): T {
  function visit(value: unknown, path: string): unknown {
    if (typeof value === 'string') {
      const key = value.match(/^\$DECK:([A-Z_][A-Z0-9_]*)$/)?.[1];
      if (!key) return value;
      const secret = secrets[key] || secrets[`DECKENT_${key}`];
      if (!secret) missing(key);
      else resolved(path);
      return secret || value;
    }
    if (Array.isArray(value)) return value.map((child, i) => visit(child, `${path}/${i}`));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`)]));
    return value;
  }
  return visit(config, '') as T;
}
