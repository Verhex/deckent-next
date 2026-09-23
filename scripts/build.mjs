// deckent build: tsc → copy JSON/text assets into dist → executable bits on bins → native (when present).
// Single entry point for local and CI builds. No staging/quarantine machinery: dist is disposable.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

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
    if (entry.isDirectory()) { if (entry.name !== 'build' && entry.name !== 'node_modules') walk(path, out); }
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

const started = performance.now();
rmSync(DIST, { recursive: true, force: true });
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '-p', 'tsconfig.json']);
const assets = copyAssets();
for (const bin of BINS) {
  const path = join(ROOT, bin);
  if (existsSync(path) && statSync(path).isFile()) chmodSync(path, 0o755);
}
const native = buildNative();
const identity = buildIdentity();
process.stdout.write(`build ok: ${identity.sourceFileCount} source files, ${assets} assets, native=${native}, ${Math.round(performance.now() - started)}ms\n`);
