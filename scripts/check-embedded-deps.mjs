// check-embedded-deps: lists third-party packages that installed packages carry INSIDE their own files (bundled/vendored), which
// `npm ls`, `npm audit`, `npm sbom` and `overrides` cannot see. Evidence is each package's sourcemaps: a `sources` entry under
// `node_modules/<pkg>/` (pnpm: `node_modules/.pnpm/<pkg>@<version>/`) names an embedded package and, when the path carries it, its version.
// Offline and read-only. Usage: node scripts/check-embedded-deps.mjs [package ...]  (default: package.json `dependencies`, plus the
// `@modelcontextprotocol/*` packages installed beside them). Prints JSON; exit 0. Library use: lint-arch compares `scanEmbedded` with
// dependencies.json `embedded[]` (DEPS-GOV); scripts/deps-watch.mjs feeds the result to OSV.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
/** The default hosts: package.json `dependencies` plus every installed `@modelcontextprotocol/*` package. */
export function defaultHosts(root) {
  const scope = join(root, 'node_modules', '@modelcontextprotocol');
  return [...new Set([...Object.keys(readJson(join(root, 'package.json')).dependencies ?? {}),
    ...(existsSync(scope) ? readdirSync(scope).map(name => `@modelcontextprotocol/${name}`) : [])])].sort();
}

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

/** One report row per host: `installed` is null when the host is not installed under `<root>/node_modules`. */
export function scanEmbedded(root, hosts) {
  const modules = join(root, 'node_modules');
  const installedVersion = name => { const file = join(modules, name, 'package.json'); return existsSync(file) ? readJson(file).version : null; };
  const report = [];
  for (const host of hosts) {
    const dir = join(modules, host);
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
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const report = scanEmbedded(root, process.argv.length > 2 ? process.argv.slice(2) : defaultHosts(root));
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, root, packages: report.filter(entry => entry.embedded.length > 0),
    scanned: report.map(entry => `${entry.package}@${entry.installed ?? 'missing'}`) }, null, 2)}\n`);
}
