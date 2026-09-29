// build-dist (DEPS-DIST, owner 2026-09-29): the publishable package. Runtime dependencies are bundled into the package itself, so npm, pnpm,
// Yarn and Bun install exactly the code this build produced (nothing is resolved at install time) and an air-gapped install is one tarball.
// Shape (measured choice, see proof DEPS-DIST-2026-09-29): Deckent's own compiled files keep the tsc `dist` layout byte-for-byte in module
// structure — every file is its own entry and its relative/#imports stay external — so import.meta.url-relative paths (native addon, sandbox
// helpers, spawned entries, build identity, package root) resolve exactly as in the tested dist. Only third-party code moves: esbuild inlines
// it (code splitting, so lazy import() stays lazy and React/zod exist once) into `dist/vendor/` chunks.
// Reads the existing `dist` (run `npm run build` first; `--build` does it), writes `<out>/package/` (+ `<out>/meta.json`), and with `--pack`
// the tarball. Usage: node scripts/build-dist.mjs [--out .pack] [--build] [--pack]
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';
import { bundledPackages, cyclonedx, embeddedInBundle, thirdPartyNotices } from './dist-sbom.mjs';
import { loadRegistry } from './dependencies.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** Optional peers that stay external: loaded only on paths that already tolerate their absence (ink DEV devtools, ws native accelerators). */
export const OPTIONAL_EXTERNALS = ['react-devtools-core', 'bufferutil', 'utf-8-validate'];
/** esbuild's ESM `__require` shim throws "Dynamic require of X is not supported" for bundled CommonJS that requires node builtins (cross-spawn,
 * ws, …); a module-scope `require` from createRequire makes the shim use Node's real require. Added only to outputs that define the shim. */
const REQUIRE_SHIM = 'Dynamic require of "';
const REQUIRE_BANNER = "import { createRequire as __deckentCreateRequire } from 'node:module'; const require = __deckentCreateRequire(import.meta.url);";
const PUBLISHED_FIELDS = ['name', 'version', 'description', 'license', 'type', 'engines', 'bin', 'exports', 'imports', 'main'];

const walk = (dir, out = []) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name);
  if (entry.isDirectory()) walk(path, out); else out.push(path); } return out; };
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Bare package specifiers in shipped declaration files (node: builtins excepted), with the file count per package. With no dependencies a
 * consumer's type checker cannot resolve them: a release blocker until the public types stop naming third-party packages. */
export function declarationImports(dir) {
  const found = {};
  for (const file of walk(dir).filter(path => path.endsWith('.d.ts'))) {
    const seen = new Set();
    for (const match of readFileSync(file, 'utf8').matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
      const spec = match[1] ?? match[2];
      if (/^(?:\.|#|node:)/u.test(spec)) continue;
      const name = spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
      if (!seen.has(name)) { seen.add(name); found[name] = (found[name] ?? 0) + 1; }
    }
  }
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
}

/** The published package.json: no dependencies (they are inside dist), no scripts, the shipped files listed explicitly. */
export function publishedManifest(source, extraFiles) {
  const out = Object.fromEntries(PUBLISHED_FIELDS.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  out.files = [...new Set([...(source.files ?? []), ...extraFiles])];
  return out;
}

export async function buildDist({ root = ROOT, out = join(ROOT, '.pack'), timestamp } = {}) {
  const dist = join(root, 'dist'), stage = join(out, 'package');
  if (!existsSync(join(dist, 'build-identity.json'))) throw new Error('dist/build-identity.json missing: run `npm run build` first (or pass --build)');
  const identity = JSON.parse(readFileSync(join(dist, 'build-identity.json'), 'utf8'));
  const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (identity.packageVersion !== source.version) throw new Error(`dist was built for ${identity.packageVersion}, package.json is ${source.version}: rebuild`);
  rmSync(out, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });

  const files = walk(dist);
  const own = { name: 'deckent-own-modules', setup(builder) {
    // Deckent's own modules stay separate files: a relative or #import from a dist file is external (import attributes are preserved).
    builder.onResolve({ filter: /^[.#]/ /* Go RE2 syntax: no flags */ }, args => args.kind !== 'entry-point' && args.importer.startsWith(dist + '/') ? { path: args.path, external: true } : undefined);
  } };
  const result = await build({ absWorkingDir: root, entryPoints: files.filter(file => file.endsWith('.js')), outbase: dist, outdir: join(stage, 'dist'),
    bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node24', chunkNames: 'vendor/[name]-[hash]', legalComments: 'eof',
    external: OPTIONAL_EXTERNALS, metafile: true, logLevel: 'warning', plugins: [own] });
  const patched = [];
  for (const output of Object.keys(result.metafile.outputs)) {
    const path = join(root, output), code = readFileSync(path, 'utf8');
    if (!code.includes(REQUIRE_SHIM)) continue;
    const lines = code.split('\n'); lines.splice(lines[0].startsWith('#!') ? 1 : 0, 0, REQUIRE_BANNER);
    writeFileSync(path, lines.join('\n')); patched.push(relative(stage, path));
  }
  // Everything that is not a compiled module ships unchanged: declarations, JSON assets, native addon and helper binaries, build identity.
  for (const file of files.filter(file => !file.endsWith('.js'))) { const target = join(stage, 'dist', relative(dist, file)); mkdirSync(dirname(target), { recursive: true }); cpSync(file, target); }
  for (const extra of ['assets', 'native', 'README.md', 'LICENSE']) if (existsSync(join(root, extra))) cpSync(join(root, extra), join(stage, extra), { recursive: true });
  const manifest = publishedManifest(source, ['THIRD-PARTY-NOTICES.md', 'sbom.cdx.json']);
  for (const bin of Object.values(manifest.bin ?? {})) chmodSync(join(stage, bin), 0o755);

  const { registry } = loadRegistry(root, JSON.parse(readFileSync(join(root, 'arch.json'), 'utf8')).dependencies?.registry);
  const licenses = new Map(Object.values(registry?.dependencies ?? {}).flatMap(entry => (entry.embedded ?? []).filter(item => item.license).map(item => [`${item.name}@${item.version}`, item.license])));
  const { shipped, treeShaken } = bundledPackages(root, result.metafile);
  const embedded = embeddedInBundle(root, shipped, licenses);
  const bom = cyclonedx({ pkg: manifest, identity, tools: [{ name: 'esbuild', version: esbuildVersion }, { name: 'deckent build-dist', version: '1' }],
    shipped, embedded, timestamp: timestamp ?? identity.builtAt });
  const notices = thirdPartyNotices(root, { pkg: manifest, shipped, embedded });
  writeFileSync(join(stage, 'sbom.cdx.json'), `${JSON.stringify(bom, null, 2)}\n`);
  writeFileSync(join(stage, 'THIRD-PARTY-NOTICES.md'), `${notices.text}\n`);
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, 'meta.json'), JSON.stringify(result.metafile));
  const typeLeaks = declarationImports(join(stage, 'dist'));
  const blockers = [...(Object.keys(typeLeaks).length ? [`published declarations import packages the zero-dependency package cannot resolve: ${Object.keys(typeLeaks).join(', ')}`] : []),
    ...(existsSync(join(stage, 'LICENSE')) ? [] : ['LICENSE file missing']), ...notices.gaps.map(gap => `notice: ${gap}`)];
  const summary = { schemaVersion: 1, stage, esbuild: esbuildVersion, outputs: Object.keys(result.metafile.outputs).length, requireBanner: patched,
    shipped: shipped.map(item => `${item.name}@${item.version}`), treeShaken: treeShaken.map(item => `${item.name}@${item.version}`),
    embedded: embedded.map(item => `${item.name}@${item.version} in ${item.carrier}: ${item.shipped ? 'shipped' : 'not shipped'}`),
    typeLeaks, publishable: { ok: blockers.length === 0, blockers } };
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

/** `npm pack` of the staged package; returns the tarball path, size and sha256. */
export function packDist(summary, out) {
  const [packed] = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--json', '--pack-destination', out], { cwd: summary.stage, encoding: 'utf8' }));
  const tarball = join(out, packed.filename);
  return { tarball, size: statSync(tarball).size, unpackedSize: packed.unpackedSize, entryCount: packed.entryCount, sha256: sha256(tarball) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), outAt = args.indexOf('--out');
  const out = resolve(outAt > -1 ? args[outAt + 1] : join(ROOT, '.pack'));
  if (args.includes('--build')) execFileSync(process.execPath, [join(ROOT, 'scripts/build.mjs')], { cwd: ROOT, stdio: 'inherit' });
  const summary = await buildDist({ out });
  const packed = args.includes('--pack') ? packDist(summary, out) : null;
  process.stdout.write(`${JSON.stringify({ ...summary, packed }, null, 2)}\n`);
}
