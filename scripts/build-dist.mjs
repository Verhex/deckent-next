// build-dist (DEPS-DIST, owner 2026-09-29): the publishable package. Runtime dependencies are bundled into the package itself, so npm, pnpm,
// Yarn and Bun install exactly the code this build produced (nothing is resolved at install time) and an air-gapped install is one tarball.
// Shape (measured choice, see proof DEPS-DIST-2026-09-29): Deckent's own compiled files keep the tsc `dist` layout byte-for-byte in module
// structure — every file is its own entry and its relative/#imports stay external — so import.meta.url-relative paths (native addon, sandbox
// helpers, spawned entries, build identity, package root) resolve exactly as in the tested dist. Only third-party code moves: esbuild inlines
// it (code splitting, so lazy import() stays lazy and React/zod exist once) into `dist/vendor/` chunks. Type declarations: only what a consumer
// reaches from the types entry, third-party ones vendored into `dist/vendor/types/` (scripts/dist-types.mjs, DEPS-TYPES).
// FASTURI-OUT (owner 2026-09-29): the MCP SDK's own bundled ajv + fast-uri (default validator) is replaced by a throwing stub and the build fails
// if ajv/fast-uri still reach the bundle (metafile inputs, shipped packages, sourcemap-embedded components). MCP-SCHEMA-VALIDATOR: Deckent ships its
// own JSON Schema validator (src/platform/core/validate), so the SDK's @cfworker/json-schema provider must not reach the bundle either.
// Reads the existing `dist` (run `npm run build` first; `--build` does it), writes `<out>/package/` (+ `<out>/meta.json`), and with `--pack`
// the tarball. Usage: node scripts/build-dist.mjs [--out .pack] [--build] [--pack] [--bwrap <build-bwrap output>]
// BWRAP-SELECT: the bundled bubblewrap (owner S4/S5) comes from a build-bwrap output (CI check-mode build) and must be exactly the locked
// build for the shipped architectures with its notice, licenses and corresponding source; otherwise the package is not publishable.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';
import { bundledNativeComponents, bundledPackages, cyclonedx, embeddedInBundle, lockedLicenseTexts, thirdPartyNotices } from './dist-sbom.mjs';
import { BUNDLED_DIR, bundleProblems, stageBundle } from './build-bwrap.mjs';
import { loadRegistry } from './dependencies.mjs';
import { vendorDeclarations } from './dist-types.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** Optional peers that stay external: loaded only on paths that already tolerate their absence (ink DEV devtools, ws native accelerators). */
export const OPTIONAL_EXTERNALS = ['react-devtools-core', 'bufferutil', 'utf-8-validate'];
/** esbuild's ESM `__require` shim throws "Dynamic require of X is not supported" for bundled CommonJS that requires node builtins (cross-spawn,
 * ws, …); a module-scope `require` from createRequire makes the shim use Node's real require. Added only to outputs that define the shim. */
const REQUIRE_SHIM = 'Dynamic require of "';
const REQUIRE_BANNER = "import { createRequire as __deckentCreateRequire } from 'node:module'; const require = __deckentCreateRequire(import.meta.url);";
const PUBLISHED_FIELDS = ['name', 'version', 'description', 'license', 'type', 'engines', 'bin', 'exports', 'imports', 'main'];

/** FASTURI-OUT (owner 2026-09-29): the MCP SDK packages carry their own bundled ajv 8 + fast-uri 3.1.0 (8 HIGH advisories) behind the
 * `_shims` default validator and the `validators/ajv` subpath; Deckent always passes its own validator, so that code must not ship.
 * Those public subpaths load with their one `ajvProvider` import replaced by stubs that throw a typed error when built or called.
 * MCP-SCHEMA-VALIDATOR (owner 2026-09-29): the SDK's @cfworker/json-schema copy (`cfWorkerProvider-*`) is not imported by Deckent and is
 * refused like ajv if anything bundles it. */
export const AJV_PROVIDER_PACKAGES = ['@modelcontextprotocol/client', '@modelcontextprotocol/server'];
export const FORBIDDEN_IN_BUNDLE = ['ajv', 'ajv-formats', 'fast-uri', 'json-schema-traverse', '@cfworker/json-schema'];
const AJV_IMPORT = /^import\s*\{([^}]*)\}\s*from\s*["'](?:\.{1,2}\/)+ajvProvider-[^"']+\.mjs["'];?[ \t]*$/mu;
/** The stubbed module text: `code` with its single ajvProvider import replaced; throws when the SDK layout no longer matches. */
export function stubAjvImport(code, label) {
  const match = AJV_IMPORT.exec(code);
  if (!match || AJV_IMPORT.test(code.slice(match.index + match[0].length))) throw new Error(`${label}: expected exactly one ajvProvider import to stub (SDK layout changed; review FASTURI-OUT)`);
  const locals = match[1].split(',').map(part => part.trim()).filter(Boolean).map(part => part.split(/\s+as\s+/u).at(-1));
  const stub = ['class DeckentRemovedValidatorError extends Error { constructor(name) { super(`${name} (the MCP SDK default ajv validator) is not part of this package; pass an explicit jsonSchemaValidator (the Deckent JSON Schema validator)`); this.name = "DeckentRemovedValidatorError"; this.code = "MCP_DEFAULT_VALIDATOR_REMOVED"; } }',
    ...locals.map(local => `function ${local}() { throw new DeckentRemovedValidatorError(${JSON.stringify(local)}); }`)].join('\n');
  return code.slice(0, match.index) + stub + code.slice(match.index + match[0].length);
}
const escape = text => text.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
const AJV_SUBPATH = new RegExp(`^(?:${AJV_PROVIDER_PACKAGES.map(escape).join('|')})/(?:_shims|validators/ajv)$`, 'u');
/** esbuild plugin; `hits` counts each stubbed `<package>/<subpath>` (the guard requires every present SDK package's `_shims`). */
export function ajvStubPlugin(hits = new Map()) {
  return { name: 'deckent-mcp-ajv-stub', setup(builder) {
    builder.onResolve({ filter: /^@modelcontextprotocol\/[^/]+\/(?:_shims|validators\/ajv)$/ /* Go RE2 syntax: no flags */ }, async args => {
      if (args.pluginData?.deckentAjvStub || !AJV_SUBPATH.test(args.path)) return undefined;
      // esbuild's own resolver (package exports, `node` condition) finds the real module; only its contents are replaced.
      const real = await builder.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: { deckentAjvStub: true } });
      if (real.errors.length) return { errors: real.errors };
      hits.set(args.path, (hits.get(args.path) ?? 0) + 1);
      return { path: real.path, pluginData: { deckentAjvStub: args.path } };
    });
    builder.onLoad({ filter: /\.mjs$/ }, args => typeof args.pluginData?.deckentAjvStub !== 'string' ? undefined
      : { contents: stubAjvImport(readFileSync(args.path, 'utf8'), args.pluginData.deckentAjvStub), loader: 'js', resolveDir: dirname(args.path) });
  } };
}
/** Violations of the no-ajv/fast-uri/cfworker rule for one build: stub hits per present SDK package, metafile inputs, shipped and embedded
 * components. */
export function ajvGuard({ metafile, shipped, embedded, hits }) {
  const out = [], inputs = Object.keys(metafile.inputs).map(input => input.replaceAll('\\', '/'));
  for (const name of AJV_PROVIDER_PACKAGES) {
    if (inputs.some(input => input.includes(`node_modules/${name}/`)) && !(hits.get(`${name}/_shims`) > 0)) out.push(`${name}/_shims was bundled without the ajv stub`);
  }
  const forbidden = new RegExp(`(?:^|/)node_modules/(?:${FORBIDDEN_IN_BUNDLE.map(escape).join('|')})/|/(?:ajvProvider|cfWorkerProvider)-[^/]*$`, 'u');
  for (const input of inputs.filter(input => forbidden.test(input))) out.push(`bundle input ${input}`);
  for (const item of shipped.filter(item => FORBIDDEN_IN_BUNDLE.includes(item.name))) out.push(`shipped package ${item.name}@${item.version}`);
  for (const item of embedded.filter(item => item.shipped && FORBIDDEN_IN_BUNDLE.includes(item.name))) out.push(`embedded ${item.name}@${item.version} in ${item.carrier} (${item.carrierFiles.join(', ')})`);
  return out;
}

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

export async function buildDist({ root = ROOT, out = join(ROOT, '.pack'), timestamp, bwrap = null } = {}) {
  const dist = join(root, 'dist'), stage = join(out, 'package');
  if (!existsSync(join(dist, 'build-identity.json'))) throw new Error('dist/build-identity.json missing: run `npm run build` first (or pass --build)');
  const identity = JSON.parse(readFileSync(join(dist, 'build-identity.json'), 'utf8'));
  const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (identity.packageVersion !== source.version) throw new Error(`dist was built for ${identity.packageVersion}, package.json is ${source.version}: rebuild`);
  // Only a previous build-dist output (or an absent directory) is replaced; never an arbitrary --out tree.
  if (existsSync(out) && readdirSync(out).length && !existsSync(join(out, 'summary.json'))) throw new Error(`refusing to replace ${out}: not a build-dist output`);
  if (existsSync(join(out, 'bwrap'))) throw new Error(`refusing to replace ${out}: it holds bubblewrap builds (bwrap/); pass another --out`);
  rmSync(out, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });

  const files = walk(dist), stubHits = new Map();
  const own = { name: 'deckent-own-modules', setup(builder) {
    // Deckent's own modules stay separate files: a relative or #import from a dist file is external (import attributes are preserved).
    builder.onResolve({ filter: /^[.#]/ /* Go RE2 syntax: no flags */ }, args => args.kind !== 'entry-point' && args.importer.startsWith(dist + '/') ? { path: args.path, external: true } : undefined);
  } };
  const result = await build({ absWorkingDir: root, entryPoints: files.filter(file => file.endsWith('.js')), outbase: dist, outdir: join(stage, 'dist'),
    bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node24', chunkNames: 'vendor/[name]-[hash]', legalComments: 'eof',
    external: OPTIONAL_EXTERNALS, metafile: true, logLevel: 'warning', plugins: [own, ajvStubPlugin(stubHits)] });
  const patched = [];
  for (const output of Object.keys(result.metafile.outputs)) {
    const path = join(root, output), code = readFileSync(path, 'utf8');
    if (!code.includes(REQUIRE_SHIM)) continue;
    const lines = code.split('\n'); lines.splice(lines[0].startsWith('#!') ? 1 : 0, 0, REQUIRE_BANNER);
    writeFileSync(path, lines.join('\n')); patched.push(relative(stage, path));
  }
  // Everything that is not a compiled module or a declaration ships unchanged: JSON assets, native addon and helper binaries, build identity.
  // Declarations: only the closure a consumer's type checker reaches from the types entry, third-party ones vendored (scripts/dist-types.mjs).
  const declarations = vendorDeclarations({ root, stage });
  if (declarations.problems.length) throw new Error(`published declarations are not self-contained:\n${declarations.problems.join('\n')}`);
  for (const file of files.filter(file => !file.endsWith('.js') && !file.endsWith('.d.ts'))) { const target = join(stage, 'dist', relative(dist, file)); mkdirSync(dirname(target), { recursive: true }); cpSync(file, target); }
  for (const extra of ['assets', 'native', 'README.md', 'LICENSE']) if (existsSync(join(root, extra))) cpSync(join(root, extra), join(stage, extra), { recursive: true });
  const bwrapLock = JSON.parse(readFileSync(join(root, 'packaging', 'bwrap', 'bwrap.lock.json'), 'utf8')), bundledDir = join(stage, 'dist', BUNDLED_DIR);
  if (bwrap) stageBundle(bwrap, bundledDir, bwrapLock);
  const bundleGaps = bundleProblems(bundledDir, bwrapLock);
  const native = bundleGaps.length ? [] : bundledNativeComponents(bwrapLock);
  const manifest = publishedManifest(source, ['THIRD-PARTY-NOTICES.md', 'sbom.cdx.json']);
  for (const bin of Object.values(manifest.bin ?? {})) chmodSync(join(stage, bin), 0o755);

  const { registry } = loadRegistry(root, JSON.parse(readFileSync(join(root, 'arch.json'), 'utf8')).dependencies?.registry);
  const licenses = new Map(Object.values(registry?.dependencies ?? {}).flatMap(entry => (entry.embedded ?? []).filter(item => item.license).map(item => [`${item.name}@${item.version}`, item.license])));
  const { shipped, treeShaken } = bundledPackages(root, result.metafile);
  const embedded = embeddedInBundle(root, shipped, licenses);
  const ajvViolations = ajvGuard({ metafile: result.metafile, shipped, embedded, hits: stubHits });
  if (ajvViolations.length) throw new Error(`the package would ship the MCP SDK's ajv/fast-uri (FASTURI-OUT):\n  ${ajvViolations.join('\n  ')}`);
  const bom = cyclonedx({ pkg: manifest, identity, tools: [{ name: 'esbuild', version: esbuildVersion }, { name: 'deckent build-dist', version: '1' }],
    shipped, embedded, native, timestamp: timestamp ?? identity.builtAt });
  const locked = lockedLicenseTexts(root);
  const notices = thirdPartyNotices(root, { pkg: manifest, shipped, embedded, declarations: declarations.vendored, locked: locked.texts,
    native: bundleGaps.length ? [] : [{ name: bwrapLock.component, version: bwrapLock.version, notice: readFileSync(join(bundledDir, 'NOTICE-bubblewrap.txt'), 'utf8'),
      dir: relative(stage, bundledDir) }] });
  writeFileSync(join(stage, 'sbom.cdx.json'), `${JSON.stringify(bom, null, 2)}\n`);
  writeFileSync(join(stage, 'THIRD-PARTY-NOTICES.md'), `${notices.text}\n`);
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, 'meta.json'), JSON.stringify(result.metafile));
  const typeLeaks = declarationImports(join(stage, 'dist'));
  const blockers = [...(Object.keys(typeLeaks).length ? [`published declarations import packages the zero-dependency package cannot resolve: ${Object.keys(typeLeaks).join(', ')}`] : []),
    ...(existsSync(join(stage, 'LICENSE')) ? [] : ['LICENSE file missing']), ...notices.gaps.map(gap => `notice: ${gap}`),
    ...locked.problems.map(problem => `license lock: ${problem}`),
    ...bundleGaps.map(gap => `bubblewrap: ${gap}`)];
  const summary = { schemaVersion: 1, stage, esbuild: esbuildVersion, outputs: Object.keys(result.metafile.outputs).length, requireBanner: patched,
    ajvStub: Object.fromEntries([...stubHits].sort(([a], [b]) => a.localeCompare(b))),
    shipped: shipped.map(item => `${item.name}@${item.version}`), treeShaken: treeShaken.map(item => `${item.name}@${item.version}`),
    embedded: embedded.map(item => `${item.name}@${item.version} in ${item.carrier}: ${item.shipped ? 'shipped' : 'not shipped'}`),
    declarations: { own: declarations.own, ownDropped: files.filter(file => file.endsWith('.d.ts')).length - declarations.own, ownRewritten: declarations.rewrittenOwn,
      vendored: declarations.vendored.map(item => `${item.name}@${item.version}: ${item.files.length}`) },
    bubblewrap: bundleGaps.length ? { shipped: false, problems: bundleGaps } : { shipped: true, version: bwrapLock.version, arches: bwrapLock.shipArches },
    // An unused locked text is not a blocker (nothing unlicensed ships) but means a version moved: the lock entry is stale.
    licenseTexts: { used: notices.lockedUsed, unused: [...locked.texts.keys()].filter(key => !notices.lockedUsed.includes(key)).sort() },
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
  const bwrapAt = args.indexOf('--bwrap');
  const summary = await buildDist({ out, bwrap: bwrapAt > -1 ? resolve(args[bwrapAt + 1]) : null });
  const packed = args.includes('--pack') ? packDist(summary, out) : null;
  process.stdout.write(`${JSON.stringify({ ...summary, packed }, null, 2)}\n`);
}
