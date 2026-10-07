// dist-types (DEPS-TYPES, owner 2026-09-29): the published package's type declarations, self-contained. The zero-dependency package
// (DEPS-DIST) bundles zod and the MCP SDK into its JavaScript, so a consumer has no `zod` / `@modelcontextprotocol/*` to resolve the types our
// declarations name. This step ships exactly the declaration closure a consumer's type checker loads from every `types` condition of the
// manifest's `exports` (`.` and `./extensions` today; Astra 2423 P2-1: the extensions entry was declared but not shipped):
//   - closure: TypeScript's own program over those entries, once per supported consumer resolution (NodeNext, Bundler), so conditions,
//     nested versions (the MCP SDK's own zod 4 next to our zod 3) and `.d.ts`/`.d.mts`/`.d.cts` formats are resolved as a consumer resolves
//     them; a specifier that resolves differently in the two modes, or not at all, fails the build;
//   - own declarations keep the tsc layout (relative and `#` imports unchanged); declarations no consumer can reach are not shipped;
//   - third-party declarations are copied byte-for-byte (except rewritten specifiers) to `dist/vendor/types/<name>@<version>/<path in package>`
//     with the package's module `type`, and every bare specifier that led to them is rewritten to a relative path (`.d.ts`→`.js`,
//     `.d.mts`→`.mjs`, `.d.cts`→`.cjs`, so each format stays what its author shipped);
//   - left external: Node built-ins only (`node:*`, resolved by the consumer's @types/node, as before).
// Deterministic: sorted walk, content-only output. Established practice for this problem is a declaration bundler (api-extractor
// `bundledPackages`, rollup-plugin-dts `respectExternal`, rolldown-plugin-dts via tsdown); the choice and its losses are in the DEPS-TYPES proof.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, normalize, relative, sep } from 'node:path';
import ts from 'typescript';
import { packageDirOf } from './dist-sbom.mjs';

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/iu;
const BUILTINS = new Set(builtinModules);
/** The consumer resolutions the published types are proven for (pack-smoke `--types` checks the same two). */
export const CONSUMER_MODES = {
  nodenext: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
  bundler: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler },
};
const posix = path => path.split(sep).join('/');
const isBuiltin = spec => spec.startsWith('node:') || BUILTINS.has(spec.split('/')[0]);
const runtimeExtension = file => file.replace(/\.d\.(m|c)?ts$/u, (_, kind) => `.${kind ?? ''}js`);

/** Every module specifier literal of a declaration file with its kind: import/export declarations, `import x = require()`, `import('…')`
 * types, and `declare module '…'` (an ambient module or augmentation, which cannot be relocated by rewriting a specifier). */
export function moduleSpecifiers(sourceFile) {
  const found = [];
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push({ node: node.moduleSpecifier, kind: 'import' });
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) found.push({ node: node.moduleReference.expression, kind: 'import' });
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) found.push({ node: node.argument.literal, kind: 'import' });
    else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) found.push({ node: node.name, kind: 'ambient' });
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found.sort((a, b) => a.node.getStart(sourceFile) - b.node.getStart(sourceFile));
}

/** The declaration entries the manifest publishes: every `types` condition anywhere under `exports` (sorted, unique), else its top-level
 * `types`/`typings`, else `dist/index.d.ts`. One program over all of them is the closure a consumer of any subpath can reach. */
export function declarationEntries(root) {
  const manifestPath = join(root, 'package.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  const found = new Set();
  const visit = (value, key) => {
    if (typeof value === 'string') { if (key === 'types') found.add(value); return; }
    if (value && typeof value === 'object') for (const [name, inner] of Object.entries(value)) visit(inner, name);
  };
  visit(manifest.exports, null);
  if (!found.size && typeof (manifest.types ?? manifest.typings) === 'string') found.add(manifest.types ?? manifest.typings);
  if (!found.size) found.add('dist/index.d.ts');
  return [...found].map(entry => posix(normalize(entry))).sort();
}

/** The declaration closure of every `<root>/<entry>` for every consumer mode, with each specifier's resolved target. */
export function declarationClosure(root, entries = declarationEntries(root)) {
  root = realpathSync.native(root);
  const files = new Map(), problems = [];
  // A declared entry that does not exist would silently drop out of the program (and out of the package): refuse it instead.
  for (const entry of entries) if (!existsSync(join(root, entry))) problems.push(`${entry}: declared types entry does not exist`);
  for (const [mode, modeOptions] of Object.entries(CONSUMER_MODES)) {
    // resolveJsonModule off and no automatic @types: the strictest consumer setting; Node built-ins stay unresolved (ambient in @types/node).
    const options = { ...modeOptions, target: ts.ScriptTarget.ES2022, strict: true, noEmit: true, skipLibCheck: false, types: [], resolveJsonModule: false };
    const host = ts.createCompilerHost(options), cache = ts.createModuleResolutionCache(root, name => name, options);
    const program = ts.createProgram({ rootNames: entries.map(entry => join(root, entry)), options, host });
    for (const sourceFile of [...program.getSourceFiles()].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
      if (program.isSourceFileDefaultLibrary(sourceFile)) continue;
      // TypeScript uses forward slashes on Windows; filesystem comparisons use native canonical paths.
      const path = normalize(sourceFile.fileName), row = files.get(path) ?? { path, specifiers: new Map() };
      files.set(path, row);
      for (const ref of sourceFile.typeReferenceDirectives) if (ref.fileName !== 'node') problems.push(`${posix(relative(root, path))}: /// <reference types="${ref.fileName}"> is not supported`);
      for (const { node, kind } of moduleSpecifiers(sourceFile)) {
        const text = node.text, at = `${node.getStart(sourceFile)}`;
        if (kind === 'ambient') { if (!isBuiltin(text)) problems.push(`${posix(relative(root, path))}: declare module '${text}' cannot be relocated`); continue; }
        const resolved = ts.resolveModuleName(text, path, options, host, cache, undefined, program.getModeForUsageLocation(sourceFile, node)).resolvedModule;
        const target = resolved ? normalize(resolved.resolvedFileName) : null;
        if (!target && !isBuiltin(text) && !text.startsWith('#')) problems.push(`${posix(relative(root, path))}: '${text}' does not resolve (${mode})`);
        const previous = row.specifiers.get(at);
        if (previous && previous.target !== target) problems.push(`${posix(relative(root, path))}: '${text}' resolves to ${previous.target} (${previous.mode}) and ${target} (${mode})`);
        if (!previous) row.specifiers.set(at, { start: node.getStart(sourceFile) + 1, end: node.getEnd() - 1, text, target, mode });
      }
    }
  }
  return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), problems: [...new Set(problems)].sort() };
}

/** Writes the closure into `<stage>/dist` (own declarations at their tsc path, third-party ones under dist/vendor/types). */
export function vendorDeclarations({ root, stage }) {
  // TypeScript resolves Windows short-name aliases (RUNNER~1) to their long path names.
  root = realpathSync.native(root);
  const { files, problems } = declarationClosure(root);
  const dist = join(root, 'dist') + sep, packages = new Map(), placed = new Map();
  const place = path => {
    if (placed.has(path)) return placed.get(path);
    let out;
    if (path.startsWith(dist)) out = join(stage, 'dist', path.slice(dist.length));
    else {
      const rel = posix(relative(root, path)), pkgDir = packageDirOf(rel);
      if (!pkgDir) { problems.push(`${rel}: outside dist and node_modules`); return null; }
      if (/(?:^|\/)node_modules\/@types\/node$/u.test(pkgDir)) return null; // the consumer's own @types/node
      const manifest = JSON.parse(readFileSync(join(root, pkgDir, 'package.json'), 'utf8')), key = `${manifest.name}@${manifest.version}`;
      if (!packages.has(key)) packages.set(key, { name: manifest.name, version: manifest.version, type: manifest.type === 'module' ? 'module' : 'commonjs',
        license: typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? null, dir: pkgDir,
        licenseFiles: readdirSync(join(root, pkgDir)).filter(name => LICENSE_FILE.test(name)).sort(), files: [] });
      const item = packages.get(key); if (!item.files.includes(rel.slice(pkgDir.length + 1))) item.files.push(rel.slice(pkgDir.length + 1));
      out = join(stage, 'dist/vendor/types', key, rel.slice(pkgDir.length + 1));
    }
    placed.set(path, out); return out;
  };
  for (const file of files) place(file.path);
  const written = [];
  for (const file of files) {
    const out = placed.get(file.path);
    if (!out) continue;
    let text = readFileSync(file.path, 'utf8');
    const edits = [...file.specifiers.values()].filter(spec => spec.target).map(spec => {
      const target = placed.get(spec.target) ?? place(spec.target);
      if (target === null) return null; // @types/node: unchanged
      if (/^[.#]/u.test(spec.text)) {
        // Relative and #imports keep their text; relocation must not change what they reach (same package, same layout).
        if (spec.text.startsWith('.') && relative(dirname(out), target) !== relative(dirname(file.path), spec.target)) problems.push(`${posix(relative(root, file.path))}: relative '${spec.text}' crosses a package boundary`);
        return null;
      }
      let next = posix(relative(dirname(out), runtimeExtension(target)));
      if (!next.startsWith('.')) next = `./${next}`;
      return { ...spec, next };
    }).filter(Boolean).sort((a, b) => b.start - a.start);
    for (const edit of edits) text = text.slice(0, edit.start) + edit.next + text.slice(edit.end);
    // One vendored copy per name@version (TypeScript dedupes such copies too); installs of the same version must be identical.
    if (written.some(row => row.out === out)) { if (readFileSync(out, 'utf8') !== text) problems.push(`${posix(relative(root, file.path))}: differs from another copy of the same package version`); continue; }
    mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, text); written.push({ out, rewritten: edits.length });
  }
  const vendored = [...packages.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  for (const item of vendored) {
    // The package's module type decides how its `.d.ts` files are read (ESM or CJS), exactly as in its own package.
    const dir = join(stage, 'dist/vendor/types', `${item.name}@${item.version}`);
    if (!existsSync(join(dir, 'package.json'))) writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ type: item.type })}\n`);
    item.files.sort();
  }
  const own = written.filter(row => row.out.startsWith(join(stage, 'dist') + sep) && !row.out.startsWith(join(stage, 'dist/vendor/types') + sep));
  return { own: own.length, rewrittenOwn: own.filter(row => row.rewritten).length, vendored, problems: [...new Set(problems)].sort() };
}
