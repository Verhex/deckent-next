// check-embedded-deps: lists third-party packages that installed packages carry INSIDE their own files (bundled/vendored), which
// `npm ls`, `npm audit`, `npm sbom` and `overrides` cannot see. Evidence is each package's sourcemaps: a `sources` entry under
// `node_modules/<pkg>/` (pnpm: `node_modules/.pnpm/<pkg>@<version>/`) names an embedded package and, when the path carries it, its version.
// Offline and read-only. Usage: node scripts/check-embedded-deps.mjs [package ...]  (default: package.json `dependencies`, plus the
// `@modelcontextprotocol/*` packages installed beside them). Prints JSON; exit 0. Not wired into verify.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))), MODULES = join(ROOT, 'node_modules');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const scope = join(MODULES, '@modelcontextprotocol');
const hosts = process.argv.length > 2 ? process.argv.slice(2) : [...new Set([...Object.keys(readJson(join(ROOT, 'package.json')).dependencies ?? {}),
  ...(existsSync(scope) ? readdirSync(scope).map(name => `@modelcontextprotocol/${name}`) : [])])].sort();

/** Every `.map` file of one installed package, not descending into its own nested node_modules (those are ordinary installed packages). */
function* maps(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* maps(path);
    else if (entry.name.endsWith('.map')) yield path;
  }
}
const PNPM = /node_modules\/\.pnpm\/((?:@[^+/]+\+)?[^@/]+)@([^/_]+)[^/]*\/node_modules\//u, PLAIN = /node_modules\/((?:@[^/]+\/)?[^/.][^/]*)\//gu;
const installedVersion = name => { const file = join(MODULES, name, 'package.json'); return existsSync(file) ? readJson(file).version : null; };

const report = [];
for (const host of hosts) {
  const dir = join(MODULES, host);
  if (!existsSync(join(dir, 'package.json'))) { report.push({ package: host, installed: null, embedded: [] }); continue; }
  const found = new Map();
  for (const file of maps(dir)) {
    let sources; try { sources = readJson(file).sources ?? []; } catch { continue; }
    for (const source of sources) {
      const pnpm = PNPM.exec(source);
      let name = pnpm ? pnpm[1].replace('+', '/') : null, version = pnpm ? pnpm[2] : null;
      if (!name) { const plain = [...source.matchAll(PLAIN)].at(-1); if (!plain) continue; name = plain[1]; }
      if (name === host) continue;
      const key = `${name}@${version ?? '?'}`, entry = found.get(key) ?? { name, version, sourceCount: 0, maps: new Set() };
      entry.sourceCount++; entry.maps.add(resolve(file).slice(dir.length + 1)); found.set(key, entry);
    }
  }
  report.push({ package: host, installed: installedVersion(host), embedded: [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => ({ name: entry.name, version: entry.version, installedTopLevel: installedVersion(entry.name), sourceCount: entry.sourceCount,
      maps: [...entry.maps].sort() })) });
}
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, root: ROOT, packages: report.filter(entry => entry.embedded.length > 0),
  scanned: report.map(entry => `${entry.package}@${entry.installed ?? 'missing'}`) }, null, 2)}\n`);
