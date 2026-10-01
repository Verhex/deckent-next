// deckent build: tsc → copy JSON/text assets into dist → executable bits on bins → native (when present).
// Single entry point for local and CI builds. No staging/quarantine machinery: dist is disposable.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { BUNDLED_DIR, bundleProblems, stageBundle } from './build-bwrap.mjs';
import { buildTypeScript } from './build-typescript.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const ASSET_EXTENSIONS = new Set(['.json', '.md', '.template', '.sh']);
execFileSync(process.execPath, [join(ROOT, 'scripts/package-metadata.mjs')], { cwd: ROOT, stdio: 'inherit' });
const BINS = Object.values(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).bin ?? {});
execFileSync(process.execPath, [join(ROOT, 'scripts/config-vocabulary.mjs')], { cwd: ROOT, stdio: 'inherit' });

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'build' && entry.name !== 'node_modules' && entry.name !== 'bundled') walk(path, out); }
    else out.push(path);
  }
  return out;
}

function copyAssets() {
  let copied = 0;
  for (const file of walk(SRC)) {
    const ext = file.slice(file.lastIndexOf('.'));
    if (!ASSET_EXTENSIONS.has(ext)) continue;
    const target = join(DIST, relative(SRC, file));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target);
    copied += 1;
  }
  return copied;
}

function buildIdentity() {
  const hash = createHash('sha256');
  const files = walk(SRC).sort();
  for (const file of files) {
    hash.update(relative(SRC, file));
    hash.update(readFileSync(file));
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  // Commit is best-effort provenance (null outside a Git checkout, e.g. a `git archive` tree); the source tree digest is the product identity.
  const git = args => { try { return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const sourceCommit = git(['rev-parse', 'HEAD']) || null;
  const status = sourceCommit === null ? null : git(['--no-optional-locks', 'status', '--porcelain', '--', 'src']);
  const sourceDirty = status === null ? null : status.length > 0;
  const identity = { schemaVersion: 1, packageName: pkg.name, packageVersion: pkg.version, sourceTreeSha256: hash.digest('hex'), sourceFileCount: files.length,
    sourceCommit, sourceDirty, builtAt: new Date().toISOString() };
  writeFileSync(join(DIST, 'build-identity.json'), JSON.stringify(identity, null, 2) + '\n');
  return identity;
}

function buildNative() {
  const units = walk(join(SRC, 'adapters')).filter(path => path.endsWith('/native/package.json')).map(dirname);
  let copied = 0;
  for (const unit of units) {
    const manifest = JSON.parse(readFileSync(join(unit, 'package.json'), 'utf8')).deckentNative;
    if (!manifest || !Array.isArray(manifest.platforms) || !Array.isArray(manifest.artifacts)
      || !manifest.artifacts.length || !manifest.platforms.every(value => typeof value === 'string')) {
      throw new Error(`Invalid native build manifest: ${relative(ROOT, unit)}`);
    }
    if (!manifest.platforms.includes(process.platform)) continue;
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '--prefix', unit, 'build']);
    for (const declared of manifest.artifacts) {
      if (typeof declared !== 'string' || isAbsolute(declared)
        || !resolve(unit, declared).startsWith(unit + sep)) throw new Error('Invalid native artifact path');
      const artifact = resolve(unit, declared);
      if (!statSync(artifact).isFile()) throw new Error('Missing native artifact');
      const target = join(DIST, relative(SRC, artifact));
      mkdirSync(dirname(target), { recursive: true }); cpSync(artifact, target);
      copied += 1;
    }
  }
  return copied ? 'built' : 'absent';
}

/**
 * BWRAP-SELECT (lead 2026-09-29): the bundled bubblewrap is part of the normal build, so src-mode tests and dist run the same locked build
 * the package ships. `src/…/bundled/` (gitignored) must be exactly the locked build; when it is absent or stale it is staged from a
 * build-bwrap output that verifies against the lock — `DECKENT_BWRAP_BUILD=<dir>`, else the newest matching `.pack/bwrap/<dir>/`. A wrong
 * staged tree fails the build; no verifiable output at all is said loudly (the real-sandbox guard test then fails on a sandbox-capable
 * host instead of the bubblewrap tests silently skipping). build-dist still gates releases on its own `--bwrap` input.
 */
function stageBubblewrap() {
  const lock = JSON.parse(readFileSync(join(ROOT, 'packaging', 'bwrap', 'bwrap.lock.json'), 'utf8'));
  const target = join(SRC, BUNDLED_DIR);
  const verifies = dir => lock.shipArches.every(arch => { const file = join(dir, 'out', arch, 'bwrap'); return existsSync(file) && createHash('sha256').update(readFileSync(file)).digest('hex') === lock.outputs[arch].sha256; });
  let state = 'present';
  if (bundleProblems(target, lock).length) {
    const packs = join(ROOT, '.pack', 'bwrap');
    const candidates = process.env.DECKENT_BWRAP_BUILD ? [resolve(process.env.DECKENT_BWRAP_BUILD)]
      : existsSync(packs) ? readdirSync(packs).map(name => join(packs, name)).filter(dir => existsSync(join(dir, 'out'))).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs) : [];
    const source = candidates.find(verifies);
    if (source) { stageBundle(source, target, lock); state = `staged from ${relative(ROOT, source) || source}`; }
    else if (existsSync(target)) throw new Error(`${relative(ROOT, target)} is not the locked bubblewrap build (${bundleProblems(target, lock).join('; ')}) and no build-bwrap output verifies against the lock: `
      + 'run `node scripts/build-bwrap.mjs` (Docker) or set DECKENT_BWRAP_BUILD=<build-bwrap output>');
    else if (process.platform !== 'linux') return 'absent (not Linux)';
    else {
      process.stderr.write(['', '!'.repeat(100), `!! BUBBLEWRAP NOT STAGED: no locked bubblewrap ${lock.version} build (sha256 ${lock.shipArches.map(arch => lock.outputs[arch].sha256.slice(0, 12)).join(', ')}) found.`,
        '!! dist has no bundled launcher: on a host whose system bwrap is older than 0.12 the bubblewrap realm is unusable, and the real-sandbox',
        '!! guard test (tests/contracts/adapters/bwrap-real-sandbox-guard.test.ts) FAILS on a host with user namespaces. Fix: `node scripts/build-bwrap.mjs`',
        '!! (Docker), or `DECKENT_BWRAP_BUILD=<build-bwrap output> npm run build`, or `node scripts/build-bwrap.mjs --stage-dev <output>`.', '!'.repeat(100), ''].join('\n'));
      return 'ABSENT';
    }
  }
  cpSync(target, join(DIST, BUNDLED_DIR), { recursive: true });
  return state;
}

const started = performance.now();
rmSync(DIST, { recursive: true, force: true });
buildTypeScript(ROOT);
const assets = copyAssets();
for (const bin of BINS) {
  const path = join(ROOT, bin);
  if (existsSync(path) && statSync(path).isFile()) chmodSync(path, 0o755);
}
const native = buildNative();
const bundled = stageBubblewrap();
const identity = buildIdentity();
process.stdout.write(`build ok: ${identity.sourceFileCount} source files, ${assets} assets, native=${native}, bubblewrap=${bundled}, ${Math.round(performance.now() - started)}ms\n`);
