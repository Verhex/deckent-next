#!/usr/bin/env node
// Affected-test selection for a local change (developer tooling, test revision stage A, 2026-10-24). Hosted CI still runs everything.
// Usage: node scripts/test-affected.mjs [--since <ref>] [--list] [--no-built] [--widen]
// Changed inputs (merge-base with main..working tree, plus untracked) → the Vitest files whose dependencies contain them, plus the
// extra npm scripts the map names. Dependencies come from a tree-shaken esbuild bundle of every test (Vitest's own `related` graph
// is file-level: through the package barrels it selected 1146 of 1252 files for one domain file), literal file paths in that code
// and scripts/test-affected-map.json. Not tracked: import-time effects of a module whose exports the test never uses.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildSourceCurrent } from './ci-build-artifact.mjs';

const RULE_KEYS = new Set(['inputs', 'reason', 'widen', 'none', 'tests', 'modules', 'run', 'keys']);
const MODULE = /\.(ts|tsx|mts|mjs|js|cjs)$/u;
const posix = path => path.split(sep).join('/');

/** Validates the versioned map: every rule says why, and names at least one effect. */
export function loadMap(map, scripts) {
  if (map.version !== 1 || typeof map.mirror !== 'object' || !Array.isArray(map.rules)) throw new Error('TEST_AFFECTED_MAP_INVALID: version, mirror, rules');
  for (const rule of map.rules) {
    if (rule.keys !== undefined && !(Array.isArray(rule.keys) && rule.keys.every(marker => typeof marker === 'string' && marker))) throw new Error(`TEST_AFFECTED_MAP_INVALID: keys ${JSON.stringify(rule)}`);
    const unknown = Object.keys(rule).filter(key => !RULE_KEYS.has(key));
    if (unknown.length || !Array.isArray(rule.inputs) || !rule.inputs.length || typeof rule.reason !== 'string' || !rule.reason.trim()
      || !(rule.widen === true || rule.none === true || rule.tests?.length || rule.modules?.length || rule.run?.length || rule.keys)) {
      throw new Error(`TEST_AFFECTED_MAP_INVALID: ${JSON.stringify(rule)}`);
    }
    for (const name of rule.run ?? []) if (!Object.hasOwn(scripts, name)) throw new Error(`TEST_AFFECTED_MAP_INVALID: unknown npm script ${name}`);
  }
  return map;
}

const mirrored = (path, mirror) => {
  for (const [from, to] of Object.entries(mirror)) if (path.startsWith(from)) return to + path.slice(from.length).replace(/\.js$/u, '.ts');
  return null;
};

/**
 * Path-like string literals of one file, resolved against the file's directory (./, ../) or the repository root. A `${…}` part
 * matches any file name; a literal `*` is a glob the code handles as data, not a file it reads. `dist/` paths name their source.
 */
function literalReferences(root, file, text, inventory, mirror) {
  const refs = { files: new Set(), modules: new Set(), built: new Set() };
  for (const [, , raw] of text.replace(/\$\{[^}]*\}/gu, '@@any@@').matchAll(/(['"`])([\w@./-]{2,200})\1/gu)) {
    if (!raw.includes('/') && !/\.\w{1,6}$/u.test(raw)) continue;
    let path = posix(relative(root, resolve(raw.startsWith('.') ? dirname(join(root, file)) : root, raw.replaceAll('@@any@@', '*'))));
    if (!path || path.startsWith('..') || path.startsWith('node_modules/')) continue;
    const source = mirrored(path, mirror);
    if (source && MODULE.test(source) && existsSync(join(root, source)) && statSync(join(root, source)).isFile()) { refs.built.add(source); continue; }
    if (source) path = source.replace(/\/$/u, ''); // built data (a directory, a copied JSON) is read from its source
    if (path.includes('*')) {
      const prefix = path.slice(0, path.lastIndexOf('/', path.indexOf('*')) + 1);
      if (!prefix || !existsSync(join(root, prefix))) continue; // a bare `${root}/${name}` pattern says nothing about the input
      for (const candidate of inventory) if (candidate.startsWith(prefix) && matchesGlob(candidate, path)) refs.files.add(candidate);
    } else if (existsSync(join(root, path)) && statSync(join(root, path)).isDirectory()) {
      // A bare top-level name ('src/') is usually workspace test data; a relative or deeper directory is one the code reads.
      if (raw.startsWith('.') || path.includes('/')) for (const candidate of inventory) if (candidate.startsWith(`${path}/`)) refs.files.add(candidate);
    } else if (existsSync(join(root, path)) || raw.includes('/')) {
      refs.files.add(path); // a missing path stays a dependency: deleting it must select its readers
      // A named fixture or script runs as its own process; a named src/ file is data (src/ is reached by imports or dist/).
      if (MODULE.test(path) && !path.startsWith('src/') && existsSync(join(root, path))) refs.modules.add(path);
    }
  }
  return refs;
}

/**
 * Maps every repository input to the test files that depend on it (`index`): the test's tree-shaken static imports, literal file
 * paths in that code, and the same for every module those literals name (spawned fixtures). A test that runs the built product
 * (`dist/`, mirrored to `src/`) depends on that entry's whole closure; those dependents are kept apart (`builtIndex`): they need a
 * current build, and nearly every source file is in the CLI entry's closure.
 */
export async function dependencyIndex(root, tests, inventory, mirror, packages) {
  const alias = new RegExp(`^#(${packages.join('|')})/`, 'u');
  const edges = new Map(); // importer → { missing: unresolved local imports (deleted files), built: imported dist entries as sources }
  const edge = file => edges.get(file) ?? edges.set(file, { missing: [], built: [] }).get(file);
  const local = { name: 'local', setup(plugin) {
    plugin.onResolve({ filter: /^(\.|#)/ }, args => {
      const path = alias.test(args.path) ? join(root, 'src', args.path.slice(1)) : args.path.startsWith('.') ? resolve(args.resolveDir, args.path) : null;
      if (path === null) return { external: true };
      const importer = posix(relative(root, args.importer)), source = mirrored(posix(relative(root, path)), mirror);
      if (source) { edge(importer).built.push(source); return { path, external: true }; }
      for (const candidate of [path, path.replace(/\.js$/u, '.ts'), path.replace(/\.js$/u, '.tsx')]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate, sideEffects: false };
      }
      edge(importer).missing.push(posix(relative(root, path.replace(/\.js$/u, '.ts'))));
      return { path, external: true };
    });
    plugin.onResolve({ filter: /.*/ }, args => args.kind === 'entry-point' ? { path: resolve(root, args.path), sideEffects: false } : { external: true });
  } };
  const used = new Map(), refsOf = new Map();
  const bundle = async entries => {
    const result = await build({ entryPoints: entries.map(entry => join(root, entry)), bundle: true, format: 'esm', platform: 'node', write: false,
      metafile: true, outdir: join(root, '.pack/test-affected'), outbase: root, plugins: [local], logLevel: 'silent', jsx: 'automatic' });
    for (const output of Object.values(result.metafile.outputs)) {
      if (!output.entryPoint) continue;
      used.set(posix(relative(root, resolve(root, output.entryPoint))),
        Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([input]) => posix(relative(root, resolve(root, input)))));
    }
  };
  // Batches share parsing; 32 entries × 6 concurrent builds measured 21 s and ~700 MB for 1252 test files (2026-10-24, 16 cores).
  for (let pending = [...tests]; pending.length;) {
    const batches = [];
    for (let i = 0; i < pending.length; i += 32) batches.push(pending.slice(i, i + 32));
    await Promise.all(Array.from({ length: 6 }, async () => { while (batches.length) await bundle(batches.shift()); }));
    const next = new Set();
    for (const files of used.values()) for (const file of files) {
      if (!refsOf.has(file)) refsOf.set(file, literalReferences(root, file, readFileSync(join(root, file), 'utf8'), inventory, mirror));
      for (const module of [...refsOf.get(file).modules, ...refsOf.get(file).built, ...(edges.get(file)?.built ?? [])]) if (!used.has(module)) next.add(module);
    }
    pending = [...next];
  }
  // One walk: the files a module set depends on, and the built entries it runs (followed only when `built`).
  const walk = (start, built) => {
    const seen = new Set(), deps = new Set(), entries = new Set(), stack = [...start];
    while (stack.length) {
      const module = stack.pop();
      if (seen.has(module)) continue;
      seen.add(module);
      for (const file of used.get(module) ?? []) {
        const refs = refsOf.get(file), own = edges.get(file);
        deps.add(file);
        for (const dep of [...refs.files, ...(own?.missing ?? [])]) deps.add(dep);
        for (const entry of [...refs.built, ...(own?.built ?? [])]) { entries.add(entry); if (built) stack.push(entry); }
        stack.push(...refs.modules);
      }
    }
    return { deps, entries };
  };
  const index = new Map(), builtIndex = new Map(), builtTests = new Set(), closures = new Map();
  const add = (target, dep, test) => target.set(dep, [...(target.get(dep) ?? []), test]);
  for (const test of tests) {
    const { deps, entries } = walk([test], false);
    for (const dep of deps) add(index, dep, test);
    if (!entries.size) continue;
    builtTests.add(test);
    const key = [...entries].sort().join('\0');
    if (!closures.has(key)) closures.set(key, walk(entries, true).deps);
    for (const dep of closures.get(key)) if (!deps.has(dep)) add(builtIndex, dep, test);
  }
  return { index, builtIndex, builtTests };
}

/**
 * Files that name a changed entry of a flat string catalog (`keys` rule). A text-only edit (the key stays) can change a verdict only
 * where the text is asserted, so it selects test files and fixtures that name the key or a fragment of its previous text; an added or
 * removed key also selects source that names it, literally or through a template (`queue.state.${state}`). Whole-catalog markers
 * select test files that check every entry. Null when either side is not a flat string map: no narrowing then.
 */
export function catalogMentions(before, after, markers, files, textOf) {
  const flat = value => value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string');
  if (!flat(before) || !flat(after)) return null;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => before[key] !== after[key]);
  const structural = changed.filter(key => !Object.hasOwn(before, key) || !Object.hasOwn(after, key));
  const fragments = changed.flatMap(key => (before[key] ?? '').split(/\{\w+\}/u).map(part => part.trim()).filter(part => part.length >= 4));
  const escape = part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const templates = text => [...text.matchAll(/`([^`\n]*\$\{[^`\n]*)`/gu)].map(([, body]) => body.split(/\$\{[^}]*\}/u))
    .filter(parts => parts.join('').includes('.') && parts.join('').length >= 4).map(parts => new RegExp(`^${parts.map(escape).join('[\\w.-]+')}$`, 'u'));
  return new Set(files.filter(file => {
    const text = textOf(file);
    if (file.startsWith('tests/') && [...changed, ...fragments, ...markers].some(needle => text.includes(needle))) return true;
    return structural.some(key => text.includes(key)) || (structural.length > 0 && text.includes('${') && templates(text).some(pattern => structural.some(key => pattern.test(key))));
  }));
}

/**
 * Pure selection: each changed input selects its dependents and what its map rules add, or is reported as widening. Tests that reach
 * an input only through the built product are selected too, unless `built` is false (--no-built): then they are counted as skipped.
 */
export function selectTests(changed, { index, builtIndex = new Map() }, map, tests, built = true, narrow = new Map()) {
  const selected = new Set(), runs = new Set(), lines = [], widen = [], skipped = new Set();
  for (const input of changed) {
    const rules = map.rules.filter(rule => rule.inputs.some(glob => matchesGlob(input, glob)));
    const reason = rules.map(rule => rule.reason).join('; ');
    if (rules.some(rule => rule.widen)) { widen.push(input); lines.push(`${input} → WIDEN: ${reason}`); continue; }
    const modules = [input, ...rules.flatMap(rule => rule.modules ?? [])];
    let direct = new Set([...modules.flatMap(module => index.get(module) ?? []),
      ...rules.flatMap(rule => (rule.tests ?? []).flatMap(glob => tests.filter(test => matchesGlob(test, glob))))]);
    let viaBuild = new Set(modules.flatMap(module => builtIndex.get(module) ?? []).filter(test => !direct.has(test)));
    if (narrow.get(input)) { // a catalog edit selects the tests that name what changed, plus the rule's own tests
      const naming = new Set([...narrow.get(input)].flatMap(file => [...(index.get(file) ?? []), ...(builtIndex.get(file) ?? [])]));
      const own = new Set(rules.flatMap(rule => (rule.tests ?? []).flatMap(glob => tests.filter(test => matchesGlob(test, glob)))));
      direct = new Set([...direct].filter(test => naming.has(test) || own.has(test)));
      viaBuild = new Set([...viaBuild].filter(test => naming.has(test)));
    }
    const extra = rules.flatMap(rule => rule.run ?? []);
    for (const test of [...direct, ...(built ? viaBuild : [])]) selected.add(test);
    if (!built) for (const test of viaBuild) skipped.add(test);
    for (const name of extra) runs.add(name);
    const count = direct.size + (built ? viaBuild.size : 0);
    const via = !viaBuild.size ? '' : built ? `; ${viaBuild.size} of them only through the built product` : `; ${viaBuild.size} more only through the built product, skipped by --no-built`;
    if (count || extra.length || viaBuild.size) lines.push(`${input} → ${count} test file(s)${extra.length ? ` + ${extra.join(', ')}` : ''}${via}${reason ? ` (${reason})` : ''}`);
    else if (rules.some(rule => rule.none)) lines.push(`${input} → no test: ${reason}`);
    else { widen.push(input); lines.push(`${input} → WIDEN: no test imports or names it and no map rule covers it`); }
  }
  return { selected: [...selected].sort(), runs: [...runs], lines, widen, skipped };
}

/** Selected tests that run the built product need a current build: run them, refuse a stale build (exit 2), or drop them with --no-built. */
export function builtGate(files, builtTests, noBuilt, buildState) {
  const built = files.filter(file => builtTests.has(file));
  if (noBuilt) return { files: files.filter(file => !builtTests.has(file)), skipped: built };
  const build = built.length ? buildState() : null;
  if (build && !build.current) {
    return { exit: 2, message: `${built.length} selected file(s) run the built dist (e.g. ${built[0]}) but the build is ${build.reason}: build first (npm run build, never while a suite runs) or pass --no-built` };
  }
  return { files, skipped: [] };
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.split('\n').filter(Boolean);
}

async function main(argv) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const options = { since: null, list: false, widen: false, noBuilt: false };
  for (let i = 0; i < argv.length; i++) {
    if (['--list', '--widen'].includes(argv[i])) options[argv[i].slice(2)] = true;
    else if (argv[i] === '--no-built') options.noBuilt = true;
    else if (argv[i] === '--since' && argv[i + 1]) options.since = argv[++i];
    else throw new Error(`TEST_AFFECTED_USAGE: unknown argument ${argv[i]} (use --since <ref>, --list, --no-built, --widen)`);
  }
  const started = Date.now();
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const map = loadMap(JSON.parse(readFileSync(join(root, 'scripts/test-affected-map.json'), 'utf8')), pkg.scripts);
  const base = git(root, 'merge-base', 'HEAD', options.since ?? 'main')[0];
  const changed = [...new Set([...git(root, 'diff', '--name-only', '--no-renames', base), ...git(root, 'ls-files', '--others', '--exclude-standard')])].sort();
  const inventory = git(root, 'ls-files', '--cached', '--others', '--exclude-standard').filter(file => existsSync(join(root, file)));
  const tests = inventory.filter(file => /^tests\/.+\.test\.ts$/u.test(file)).sort();
  const packages = Object.keys(JSON.parse(readFileSync(join(root, 'arch.json'), 'utf8')).packages);
  const graph = await dependencyIndex(root, tests, inventory, map.mirror, packages);
  const narrow = new Map(), texts = new Map();
  const textOf = file => texts.get(file) ?? texts.set(file, existsSync(join(root, file)) && statSync(join(root, file)).isFile() ? readFileSync(join(root, file), 'utf8') : '').get(file);
  for (const input of changed) {
    const rule = map.rules.find(item => item.keys && item.inputs.some(glob => matchesGlob(input, glob)));
    if (!rule) continue;
    const json = text => { try { return JSON.parse(text); } catch { return null; } };
    const before = spawnSync('git', ['show', `${base}:${input}`], { cwd: root, encoding: 'utf8' });
    const files = [...graph.index.keys()].filter(file => /^(src|tests)\//u.test(file) && !rule.inputs.some(glob => matchesGlob(file, glob)));
    narrow.set(input, catalogMentions(before.status === 0 ? json(before.stdout) : {}, existsSync(join(root, input)) ? json(textOf(input)) : {}, rule.keys, files, textOf));
  }
  const { selected, runs, lines, widen, skipped } = selectTests(changed, graph, map, tests, !options.noBuilt, narrow);
  process.stdout.write(`test:affected: ${changed.length} changed input(s) since ${base.slice(0, 12)} (${options.since ?? 'main'}); graph ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  for (const line of lines) process.stdout.write(`  ${line}\n`);
  if (widen.length && !options.widen) {
    process.stdout.write(`test:affected: WIDENED to all ${tests.length} test files by ${widen.length} input(s) above; not run. Add a map rule, or rerun with --widen (full suite: coordinate with maintainers).\n`);
    return 2;
  }
  const gate = builtGate(widen.length ? tests : selected, graph.builtTests, options.noBuilt, () => buildSourceCurrent(root));
  if (gate.exit && !options.list) { process.stdout.write(`test:affected: ${gate.message}.\n`); return gate.exit; }
  const files = gate.files ?? (widen.length ? tests : selected);
  const dropped = new Set([...skipped, ...(gate.skipped ?? [])]).size;
  const note = options.noBuilt ? `; --no-built skipped ${dropped} built-product test file(s) (hosted CI runs them)` : '';
  if (!files.length && !runs.length) { process.stdout.write(`test:affected: EMPTY selection${note}: nothing proves this change; an empty run is never a pass.\n`); return 2; }
  process.stdout.write(`test:affected: ${files.length} of ${tests.length} test file(s)${runs.length ? ` + ${runs.join(', ')}` : ''}${note}\n`);
  if (options.list) { for (const file of files) process.stdout.write(`${file}\n`); return 0; }
  const env = { ...process.env, VITEST_MAX_FORKS: process.env.VITEST_MAX_FORKS ?? '2' };
  let exit = 0;
  if (files.length) {
    const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--configLoader', 'runner', ...(widen.length ? [] : files)];
    exit = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env }).status ?? 1;
  }
  for (const name of runs) {
    const status = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', name], { cwd: root, stdio: 'inherit', env, shell: process.platform === 'win32' }).status ?? 1;
    exit ||= status;
  }
  process.stdout.write(`test:affected: ${exit === 0 ? 'passed' : 'FAILED'} in ${((Date.now() - started) / 1000).toFixed(1)} s${note}\n`);
  return exit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
