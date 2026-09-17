// deckent build: tsc → copy JSON/text assets into dist → executable bits on bins → native (when present).
// Single entry point for local and CI builds. No staging/quarantine machinery: dist is disposable.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const ASSET_EXTENSIONS = new Set(['.json', '.md', '.template', '.sh']);
const BINS = ['dist/surfaces/core/cli/internal/entry.js', 'dist/surfaces/core/mcp/internal/server.js'];
execFileSync(process.execPath, [join(ROOT, 'scripts/config-vocabulary.mjs')], { cwd: ROOT, stdio: 'inherit' });

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
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
  const identity = { schemaVersion: 1, packageName: pkg.name, packageVersion: pkg.version, sourceTreeSha256: hash.digest('hex'), sourceFileCount: files.length, builtAt: new Date().toISOString() };
  writeFileSync(join(DIST, 'build-identity.json'), JSON.stringify(identity, null, 2) + '\n');
  return identity;
}

function buildNative() {
  const nativeDir = join(ROOT, 'native', 'exec-authority');
  if (!existsSync(nativeDir)) return 'absent';
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '--prefix', nativeDir, 'build']);
  return 'built';
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
