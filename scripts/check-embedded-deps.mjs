// check-embedded-deps: lists third-party packages that installed packages carry INSIDE their own files (bundled/vendored), which
// `npm ls`, `npm audit`, `npm sbom` and `overrides` cannot see. Evidence is each package's sourcemaps: a `sources` entry under
// `node_modules/<pkg>/` (pnpm: `node_modules/.pnpm/<pkg>@<version>/`) names an embedded package and, when the path carries it, its version.
// Offline and read-only. Usage: node scripts/check-embedded-deps.mjs [package ...]  (default: package.json `dependencies`, plus the
// `@modelcontextprotocol/*` packages installed beside them). Prints JSON; exit 0. Library use: lint-arch compares `scanEmbedded` with
// dependencies.json `embedded[]` (DEPS-GOV); scripts/deps-watch.mjs feeds the result to OSV.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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

/** Hosts are package names (under `<root>/node_modules`) or { name, dir? }, with dir absolute or relative to root.
 * One report row per host; an unreadable manifest/directory/map adds `problem` instead of throwing or omitting the host. */
export function scanEmbedded(root, hosts) {
  const modules = join(root, 'node_modules');
  const installedVersion = name => { try { return readJson(join(modules, name, 'package.json')).version ?? null; } catch { return null; } };
  const report = [];
  for (const host of hosts) {
    const name = typeof host === 'string' ? host : host.name;
    const dir = resolve(root, (typeof host === 'string' ? undefined : host.dir) ?? join('node_modules', name));
    const row = { package: name, installed: null, embedded: [] }, found = new Map();
    try {
      row.installed = readJson(join(dir, 'package.json')).version ?? null;
      for (const file of maps(dir)) {
        const text = readFileSync(file, 'utf8');
        let sources; try { sources = JSON.parse(text).sources ?? []; } catch { continue; }
        for (const source of sources) {
          const pnpm = PNPM.exec(source);
          let embeddedName = pnpm ? pnpm[1].replace('+', '/') : null, version = pnpm ? pnpm[2] : null;
          if (!embeddedName) { const plain = [...source.matchAll(PLAIN)].at(-1); if (!plain) continue; embeddedName = plain[1]; }
          if (embeddedName === name) continue;
          const key = `${embeddedName}@${version ?? '?'}`, entry = found.get(key) ?? { name: embeddedName, version, sourceCount: 0, maps: new Set() };
          entry.sourceCount++; entry.maps.add(relative(dir, file).replaceAll('\\', '/')); found.set(key, entry);
        }
      }
    } catch (error) { row.problem = `${dir}: ${error.message}`; }
    row.embedded = [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => ({ name: entry.name, version: entry.version, installedTopLevel: installedVersion(entry.name), sourceCount: entry.sourceCount,
        maps: [...entry.maps].sort() }));
    report.push(row);
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const report = scanEmbedded(root, process.argv.length > 2 ? process.argv.slice(2) : defaultHosts(root));
  const problems = report.filter(entry => entry.problem);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, root, packages: report.filter(entry => entry.embedded.length > 0),
    scanned: report.map(entry => `${entry.package}@${entry.installed ?? 'missing'}`), ...(problems.length ? { problems } : {}) }, null, 2)}\n`);
}
