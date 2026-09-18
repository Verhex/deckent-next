// lint-arch: the single architecture gate for deckent (fail-closed, no baselines).
// Rules come from arch.json. Checks:
//  1. package import direction + public-API-only cross-package imports (index.ts), internal/ isolation
//  2. observability is never imported; apps import only surfaces
//  3. i18n: locale catalogs have identical key sets; t('key') keys exist; no dynamic keys;
//     surfaces never print string literals directly
//  4. model/flow literals only in the registry allowlist
//  5. .md writes only from kernel/docs-authority
//  6. budgets: file ≤ maxLinesPerFile (all text files), per-package and total src lines, test-case count
//  7. tracked markdown set is exactly the allowlist (+ pointer files within their line cap)
import ts from 'typescript';
import { lintConfigVocabulary } from './config-vocabulary.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > -1 && process.argv[rootArg + 1] ? resolve(process.argv[rootArg + 1]) : dirname(dirname(fileURLToPath(import.meta.url)));
const arch = JSON.parse(readFileSync(join(ROOT, 'arch.json'), 'utf8'));
const violations = [];
const fail = (rule, file, message) => violations.push({ rule, file, message });
const rel = (p) => relative(ROOT, p).split(sep).join('/');

function walk(dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, predicate, out);
    else if (predicate(path)) out.push(path);
  }
  return out;
}

const isTs = (p) => /\.(ts|tsx|mts)$/.test(p) && !p.endsWith('.d.ts');
const srcFiles = walk(join(ROOT, 'src'), isTs);
const appFiles = walk(join(ROOT, 'apps'), isTs);
const packageNames = Object.keys(arch.packages);
// Current domain/runtime contracts have one active shape. A second source module
// or public V2 name creates two authorities; migration history is the explicit
// boundary where old shapes may remain for forward-only conversion.
const VERSIONED_SHAPE_PACKAGES = new Set(['domain', 'capabilities', 'engine', 'adapters', 'composition']);
const VERSION_HISTORY_SEGMENTS = new Set(['migration', 'migrations']);
const versioningScope = (file) => {
  const path = rel(file).split('/');
  const migrationHistory = path[1] === 'adapters'
    && (path.some(segment => VERSION_HISTORY_SEGMENTS.has(segment.toLowerCase()))
      || /^migration-v\d+\.ts$/i.test(path.at(-1) ?? ''))
    && path.some(segment => /(?:attempt|persistence|store)/i.test(segment));
  return path[0] === 'src' && VERSIONED_SHAPE_PACKAGES.has(path[1]) && !migrationHistory;
};
const tiers = arch.tiers ?? { order: [], enforce: false, unitLines: Infinity };
const tierRank = new Map(tiers.order.map((name, index) => [name, index]));
if (arch.imports?.enforce) {
  try {
    const runtime = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).imports;
    const source = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')).compilerOptions.paths;
    for (const pkg of packageNames) {
      const key = `${arch.imports.aliasPrefix}${pkg}/*`;
      if (runtime?.[key] !== `./dist/${pkg}/*` || JSON.stringify(source?.[key]) !== JSON.stringify([`./src/${pkg}/*`])) {
        fail('import-map', 'package.json/tsconfig.json', `runtime/source mapping drift for ${key}`);
      }
    }
  } catch (error) { fail('import-map', 'package.json/tsconfig.json', error.message); }
}


function unitOf(file) {
  // src/<pkg>/<tier>/<unit>/... → { pkg, tier, unit } ; src/<pkg>/index.ts → { pkg, tier: null, unit: null }
  const parts = rel(file).split('/');
  if (parts[0] !== 'src' || parts.length < 3) return null;
  const [, pkg, third, fourth] = parts;
  if (parts.length === 3) return { pkg, tier: null, unit: null, rootFile: third };
  return { pkg, tier: third, unit: parts.length >= 5 ? fourth : null, rootFile: null };
}

function packageOf(file) {
  const r = rel(file);
  if (r.startsWith('src/')) {
    const seg = r.split('/')[1];
    return packageNames.includes(seg) ? seg : (seg === 'index.ts' ? '(root)' : `(unknown:${seg})`);
  }
  if (r.startsWith('apps/')) return `apps/${r.split('/')[1]}`;
  return '(outside)';
}

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (!spec) continue;
    const aliasPrefix = arch.imports?.aliasPrefix ?? '#';
    let target;
    if (spec.startsWith(aliasPrefix)) target = resolve(ROOT, 'src', spec.slice(aliasPrefix.length).replace(/\.js$/, '.ts'));
    else if (spec.startsWith('.')) target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
    else continue;
    out.push({ spec, target, aliased: spec.startsWith(aliasPrefix), line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

// ---- 0: one active contract shape (migration history is exempt)
for (const file of srcFiles) {
  if (!versioningScope(file)) continue;
  const path = rel(file);
  if (/(^|\/)(?:version-(?:\d+|[a-z]+)|v\d+|migration-v\d+)\.ts$/.test(path)) {
    fail('versioning', path, 'parallel versioned module; evolve the current contract in place or keep the old shape under adapter persistence migrations');
  }
  const source = readFileSync(file, 'utf8');
  // AST declarations/export lists avoid comments and strings. Provider-native
  // names such as ProviderV2 remain valid unless the name is contract-shaped.
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const contractWord = /(?:schema|contract|record|graph|claim|protocol|snapshot|request|response|event|envelope|receipt|command|attempt|run|task|policy|config|manifest)/i;
  const versionMarker = /V\d+/i;
  const checkName = (name, node) => {
    if (!versionMarker.test(name) || !contractWord.test(name)) return;
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    fail('versioning', `${path}:${line}`, `parallel versioned contract API "${name}"; keep one current contract shape (adapter persistence migrations are exempt)`);
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isTypeParameterDeclaration(node)) {
      if (ts.isIdentifier(node.name)) checkName(node.name.text, node.name);
    } else if (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node)
      || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      if (node.name) checkName(node.name.text, node.name);
    } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) checkName(element.name.text, element.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

// Pure domain packages cannot acquire host capabilities through external modules or ambient globals.
for (const file of srcFiles) {
  const policy = arch.packages[packageOf(file)];
  if (!policy?.pure) continue;
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const ambient = new Set(['process', 'globalThis', 'global', 'Buffer', 'require', 'eval', 'Function', 'Date']);
  function visit(node) {
    if (ts.isIdentifier(node) && ambient.has(node.text)) fail('domain-purity', rel(file), `ambient capability ${node.text}`);
    const spec = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier : undefined;
    if (spec && ts.isStringLiteral(spec) && !spec.text.startsWith('.') && !spec.text.startsWith('#')
      && !(policy.externalImports ?? []).includes(spec.text)) fail('domain-purity', rel(file), `external dependency ${spec.text}`);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) fail('domain-purity', rel(file), 'dynamic import');
    ts.forEachChild(node, visit);
  }
  visit(source);
}

// ---- 1 + 2: direction, public API, internal isolation, observability, apps
for (const file of [...srcFiles, ...appFiles]) {
  const from = packageOf(file);
  if (from.startsWith('(unknown')) fail('layout', rel(file), `file is outside a declared package (${from}); declare it in arch.json`);
  for (const imp of importsOf(file)) {
    const targetRel = rel(imp.target);
    if (!targetRel.startsWith('src/')) continue;
    if (arch.imports?.enforce && !existsSync(imp.target)) fail('import-target', `${rel(file)}:${imp.line}`, `missing target ${imp.spec}`);
    const to = packageOf(imp.target);
    if (to === from) {
      if (!tiers.enforce || !from.startsWith('(') && packageNames.includes(from)) {
        const src = unitOf(file), dst = unitOf(imp.target);
        if (tiers.enforce && src && dst && dst.tier) {
          const srcRank = src.tier ? tierRank.get(src.tier) : Infinity; // package index.ts may import any tier
          const dstRank = tierRank.get(dst.tier);
          if (srcRank !== undefined && dstRank !== undefined && dstRank > srcRank) fail('tier-direction', `${rel(file)}:${imp.line}`, `${src.tier} may not import ${dst.tier} (order: ${tiers.order.join(' ← ')})`);
          const sameUnit = src.tier === dst.tier && src.unit === dst.unit && src.unit !== null;
          if (!sameUnit && !/^src\/[^/]+\/[^/]+\/[^/]+\/index\.ts$/.test(targetRel)) fail('unit-api', `${rel(file)}:${imp.line}`, `cross-unit import must target the unit index.ts (got ${imp.spec})`);
          if (!sameUnit && arch.imports?.enforce && !imp.aliased) fail('import-style', `${rel(file)}:${imp.line}`, `cross-unit import must use the ${arch.imports.aliasPrefix}<pkg>/<tier>/<unit>/index.js alias (got ${imp.spec})`);
        }
      }
      continue;
    }
    const allowed = from === '(root)' ? packageNames : from.startsWith('apps/') ? arch.apps.imports : (arch.packages[from]?.imports ?? []);
    if (!allowed.includes(to)) fail('direction', `${rel(file)}:${imp.line}`, `${from} → ${to} is not allowed (allowed: ${allowed.join(', ') || 'none'})`);
    if (arch.imports?.enforce && !imp.aliased && !from.startsWith('apps/')) fail('import-style', `${rel(file)}:${imp.line}`, `cross-package import must use the ${arch.imports.aliasPrefix}<pkg>/index.js alias (got ${imp.spec})`);
    const isIndex = /^src\/[^/]+\/index\.ts$/.test(targetRel) || /^src\/[^/]+\/index$/.test(targetRel);
    if (!isIndex) fail('public-api', `${rel(file)}:${imp.line}`, `cross-package import must target src/${to}/index.ts (got ${imp.spec})`);
    if (targetRel.includes('/internal/')) fail('internal', `${rel(file)}:${imp.line}`, `internal/ module imported from another package`);
    const importedBy = arch.packages[to]?.importedBy;
    if (Array.isArray(importedBy) && !importedBy.includes(from)) fail('read-only', `${rel(file)}:${imp.line}`, `${to} may only be imported by [${importedBy.join(', ') || 'nobody'}]`);
  }
}

// ---- 2b: tier layout and unit budgets
if (tiers.enforce) {
  const unitLines = new Map();
  for (const file of srcFiles) {
    const info = unitOf(file);
    if (!info || !packageNames.includes(info.pkg)) continue;
    if (info.rootFile !== null) { if (info.rootFile !== 'index.ts') fail('layout', rel(file), `only index.ts may sit directly under src/${info.pkg}/; place it in src/${info.pkg}/<tier>/<unit>/`); continue; }
    if (!tierRank.has(info.tier)) { fail('layout', rel(file), `unknown tier "${info.tier}" (tiers: ${tiers.order.join(', ')})`); continue; }
    if (info.unit === null) { fail('layout', rel(file), `files under src/${info.pkg}/${info.tier}/ must belong to a unit directory`); continue; }
    const key = `src/${info.pkg}/${info.tier}/${info.unit}`;
    unitLines.set(key, (unitLines.get(key) ?? 0) + readFileSync(file, 'utf8').split('\n').length);
    if (!existsSync(join(ROOT, key, 'index.ts'))) fail('layout', key, 'unit has no index.ts (public surface)');
  }
  for (const [unit, lines] of unitLines) if (lines > tiers.unitLines) fail('unit-budget', unit, `${lines} lines > unit budget ${tiers.unitLines}; split the unit or move behaviour to a higher tier`);
}

// ---- 3: i18n
const catalogDir = join(ROOT, arch.i18n.catalogDir);
const catalogs = {}, familyOwners = {};
for (const locale of arch.i18n.locales) {
  const merged = Object.create(null);
  familyOwners[locale] = Object.create(null);
  for (const family of arch.i18n.families) {
    const path = join(catalogDir, 'locales', locale, `${family}.json`);
    if (!existsSync(path)) { fail('i18n', rel(path), 'locale family missing'); continue; }
    const source = readFileSync(path, 'utf8');
    const ast = ts.parseJsonText(path, source);
    function checkDuplicates(node) {
      if (ts.isObjectLiteralExpression(node)) {
        const seen = new Set();
        for (const property of node.properties) {
          const key = property.name?.text;
          if (seen.has(key)) fail('i18n-duplicate', rel(path), `duplicate key "${key}"`);
          seen.add(key);
        }
      }
      ts.forEachChild(node, checkDuplicates);
    }
    checkDuplicates(ast);
    let entries;
    try { entries = JSON.parse(source); } catch { fail('i18n', rel(path), 'invalid JSON'); continue; }
    for (const [key, value] of Object.entries(entries)) {
      if (Object.hasOwn(merged, key)) fail('i18n-duplicate', rel(path), `duplicate family key "${key}"`);
      if (typeof value !== 'string' || !value.trim() || value.includes('\u001b')) fail('i18n-value', rel(path), `empty/nonstring/ANSI value for "${key}"`);
      merged[key] = value;
      familyOwners[locale][key] = family;
    }
  }
  catalogs[locale] = merged;
}
const localeNames = Object.keys(catalogs);
if (localeNames.length > 1) {
  const base = new Set(Object.keys(catalogs[localeNames[0]]));
  for (const locale of localeNames.slice(1)) {
    const keys = new Set(Object.keys(catalogs[locale]));
    for (const k of base) if (!keys.has(k)) fail('i18n', `${arch.i18n.catalogDir}/${locale}.json`, `missing key "${k}"`);
    for (const k of keys) if (!base.has(k)) fail('i18n', `${arch.i18n.catalogDir}/${locale}.json`, `extra key "${k}" not in ${localeNames[0]}`);
    for (const key of keys) if (base.has(key)) {
      if (familyOwners[locale][key] !== familyOwners[localeNames[0]][key]) fail('i18n-family', arch.i18n.catalogDir, `locale families disagree for "${key}"`);
      const placeholders = value => typeof value === 'string' ? [...new Set([...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort().join(',') : null;
      if (placeholders(catalogs[locale][key]) !== placeholders(catalogs[localeNames[0]][key])) fail('i18n-placeholder', arch.i18n.catalogDir, `placeholder sets disagree for "${key}"`);
    }
  }
}
const knownKeys = new Set(Object.keys(catalogs[localeNames[0]] ?? {}));
const T_CALL = new RegExp(`(?<![\\w.])${arch.i18n.callee}\\(\\s*([^)]*?)\\s*[,)]`, 'g');
const OUTPUT_CALL = /(?:console\.(?:log|error|warn|info)|process\.(?:stdout|stderr)\.write)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
for (const file of srcFiles) {
  if (rel(file).startsWith(`${arch.i18n.catalogDir}/`)) continue; // the t() implementation itself
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(T_CALL)) {
    const arg = m[1].trim();
    const lit = arg.match(/^(['"])([^'"]+)\1$/);
    const line = src.slice(0, m.index).split('\n').length;
    if (!lit) { fail('i18n-dynamic', `${rel(file)}:${line}`, `t() key must be a string literal (got ${arg || 'empty'})`); continue; }
    if (!knownKeys.has(lit[2])) fail('i18n-key', `${rel(file)}:${line}`, `unknown i18n key "${lit[2]}"`);
  }
  if (rel(file).startsWith('src/surfaces/')) {
    for (const m of src.matchAll(OUTPUT_CALL)) {
      if (/[A-Za-z]{3,}/.test(m[2])) fail('i18n-literal', `${rel(file)}:${src.slice(0, m.index).split('\n').length}`, 'user-facing string literal in surface output; use t()');
    }
  }
}

lintConfigVocabulary(ROOT, srcFiles, fail);

// ---- 4: model/flow literals
const literalAllow = new Set(arch.literals.allow);
const literalRes = arch.literals.forbidden.map((p) => new RegExp(p, 'g'));
for (const file of srcFiles) {
  if (literalAllow.has(rel(file))) continue;
  const src = readFileSync(file, 'utf8');
  for (const re of literalRes) for (const m of src.matchAll(re)) fail('literal', `${rel(file)}:${src.slice(0, m.index).split('\n').length}`, `hardcoded model/provider literal "${m[0]}" (only ${arch.literals.allow.join(', ')})`);
}

// ---- 5: .md write gate
const MD_WRITE = /(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|renameSync|rename)\([^\n]*\.md/g;
for (const file of srcFiles) {
  if (rel(file).startsWith(arch.markdown.writerModule)) continue;
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(MD_WRITE)) fail('md-write', `${rel(file)}:${src.slice(0, m.index).split('\n').length}`, `markdown write outside ${arch.markdown.writerModule}`);
}

// ---- 6: budgets
const { fileRoots, textExtensions, maxLinesPerFile, designTargetLines } = arch.budgets;
if (!Array.isArray(fileRoots) || !fileRoots.length || !Array.isArray(textExtensions) || !textExtensions.length
  || !Number.isSafeInteger(maxLinesPerFile) || maxLinesPerFile < 1
  || !Number.isSafeInteger(designTargetLines) || designTargetLines < 1 || designTargetLines > maxLinesPerFile) {
  fail('budget-config', 'arch.json', 'invalid file scope or line limits');
}
const textFiles = [...new Set((Array.isArray(fileRoots) ? fileRoots : []).flatMap(dir => walk(join(ROOT, dir),
  p => Array.isArray(textExtensions) && textExtensions.includes(extname(p)))))];
let aboveDesignTarget = 0;
for (const file of textFiles) {
  if (arch.budgets.evidenceFiles?.includes(rel(file))) continue;
  const text = readFileSync(file, 'utf8');
  const lines = text.length === 0 ? 0 : text.split('\n').length - Number(text.endsWith('\n'));
  if (lines > maxLinesPerFile) fail('file-size', rel(file), `${lines} lines > ${maxLinesPerFile}`);
  if (lines > designTargetLines) aboveDesignTarget++;
}
const perPackage = {};
let total = 0;
for (const file of srcFiles) {
  const lines = readFileSync(file, 'utf8').split('\n').length;
  total += lines;
  const pkg = packageOf(file);
  perPackage[pkg] = (perPackage[pkg] ?? 0) + lines;
}
for (const [pkg, budget] of Object.entries(arch.budgets.packageLines)) {
  if ((perPackage[pkg] ?? 0) > budget) fail('package-budget', `src/${pkg}`, `${perPackage[pkg]} lines > budget ${budget}`);
}
if (total > arch.budgets.totalSrcLines) fail('total-budget', 'src', `${total} lines > budget ${arch.budgets.totalSrcLines}`);
const TEST_CASE = /^\s*(?:it|test)(?:\.(?:each|skip|only|todo|concurrent))*\(/gm;
let testCases = 0;
for (const file of walk(join(ROOT, 'tests'), (p) => /\.test\.tsx?$/.test(p))) testCases += (readFileSync(file, 'utf8').match(TEST_CASE) ?? []).length;
if (testCases > arch.budgets.testCases) fail('test-budget', 'tests', `${testCases} test cases > budget ${arch.budgets.testCases}`);

// ---- 7: tracked markdown
const tracked = (() => { try { return execFileSync('git', ['ls-files', '--', '*.md'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); } catch { return []; } })();
const allow = new Set(arch.markdown.trackedAllow);
const allowGlobs = (arch.markdown.trackedAllowGlobs ?? []).map(g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$'));
for (const file of tracked) {
  if (allowGlobs.some(re => re.test(file))) continue;
  const cap = arch.markdown.pointerFiles[file];
  if (cap !== undefined) {
    const lines = readFileSync(join(ROOT, file), 'utf8').trimEnd().split('\n').length;
    if (lines > cap) fail('markdown', file, `pointer file has ${lines} lines > ${cap}`);
    continue;
  }
  if (!allow.has(file)) fail('markdown', file, `tracked markdown outside allowlist [${[...allow].join(', ')}]`);
}
for (const file of allow) if (!existsSync(join(ROOT, file))) fail('markdown', file, 'required document missing');

// ---- 8: vocabulary (owner: the product says run, never sprint)
const vocab = arch.vocabulary;
if (vocab?.enforce) {
  const vocabRes = vocab.forbidden.map(p => new RegExp(p, 'g'));
  const vocabFiles = vocab.scope.flatMap(dir => walk(join(ROOT, dir), p => /\.(ts|tsx|mts|js|mjs|json|sh|yml|yaml)$/.test(p) && !p.endsWith('HARVEST.json')));
  for (const file of vocabFiles) {
    const text = readFileSync(file, 'utf8');
    for (const re of vocabRes) for (const m of text.matchAll(re)) fail('vocabulary', `${rel(file)}:${text.slice(0, m.index).split('\n').length}`, `forbidden vocabulary "${m[0]}" (canonical chain: ${vocab.canonicalChain.join(' → ')})`);
  }
}

// ---- report
const summary = `lint-arch: ${srcFiles.length} src files, ${total} src lines, ${aboveDesignTarget} files above design target, ${testCases} test cases, tiers=${tiers.enforce ? 'enforced' : 'off'}, imports=${arch.imports?.enforce ? 'aliased' : 'off'}, vocabulary=${arch.vocabulary?.enforce ? 'enforced' : 'off'}, ${violations.length} violation(s)`;
if (violations.length === 0) { process.stdout.write(`${summary}\n`); process.exit(0); }
for (const v of violations) process.stdout.write(`✗ [${v.rule}] ${v.file} — ${v.message}\n`);
process.stdout.write(`${summary}\n`);
process.exit(1);
