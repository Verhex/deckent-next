#!/usr/bin/env node
// Conservative lexical proof for DOCS-AUDIT's retired namespaces, including computed TS references.
// Run before removal; --keys replays the exact saved key set after removal without relying on the catalogs.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const prefixes = ['cli.memcat.', 'cli.batch.'];
const catalogs = ['en', 'tr'].map(locale => JSON.parse(readFileSync(join(root, `src/platform/core/i18n/locales/${locale}/cli.json`), 'utf8')));
let keys;
if (process.argv[2] === '--keys' && process.argv.length === 4) keys = JSON.parse(readFileSync(process.argv[3], 'utf8'));
else if (process.argv.length === 2) keys = [...new Set(catalogs.flatMap(catalog => Object.keys(catalog).filter(key => prefixes.some(prefix => key.startsWith(prefix)))))].sort();
else throw new Error('Usage: node scripts/audit-unused-i18n.mjs [--keys saved-keys.json]');
if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !prefixes.some(prefix => key.startsWith(prefix)))) throw new Error('Invalid retired key set');
const references = []; let files = 0;
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.deckent', '.agents', '.codex', 'dist', 'coverage'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/u.test(entry.name)) {
      files++;
      readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
        // Also catches a namespace assembled as `cli.memcat.${name}` or a prefix without the final dot.
        if (prefixes.some(prefix => line.includes(prefix.slice(0, -1)))) references.push(`${relative(root, path)}:${index + 1}: ${line.trim()}`);
      });
    }
  }
}
scan(root);
console.log(JSON.stringify({ keys, keyCount: keys.length, typescriptFiles: files, references }, null, 2));
process.exitCode = references.length ? 1 : 0;
