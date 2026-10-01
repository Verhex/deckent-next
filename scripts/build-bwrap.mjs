// build-bwrap (BWRAP-BUNDLE, owner 2026-09-29): a pinned, hash-verified bubblewrap to ship with the product. Reproducible build of the
// release tarball named by packaging/bwrap/bwrap.lock.json inside the Alpine image pinned there by digest (packaging/bwrap/build.sh):
// static-pie, musl + libcap linked in, no SELinux, never setuid (0.12.0 removed setuid support; the binary refuses to run setuid).
// The source tarball and the linked components' license texts are verified against the lock before anything runs; the output sha256 is
// compared with the lock (a mismatch fails) unless `--record` writes it. The output directory must not exist or be empty.
// Usage: node scripts/build-bwrap.mjs [--arch x86_64|aarch64|all] [--out .pack/bwrap/<time>] [--cache .pack/bwrap/cache] [--record]
//        node scripts/build-bwrap.mjs --constant          (re-generates the runtime identity constant from the lock; `--record` does it too)
//        node scripts/build-bwrap.mjs --stage-dev <out>   (a verified build output → src/…/bundled/, gitignored, for src-mode tests and `npm run build`)
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGING = join(ROOT, 'packaging', 'bwrap');
const LOCK = join(PACKAGING, 'bwrap.lock.json');
/** The runtime's expected identity of the bundled build (BWRAP-SELECT), generated from the lock; a contract test keeps them equal. */
export const IDENTITY_MODULE = join(ROOT, 'src', 'adapters', 'core', 'shell-sandbox-bwrap', 'internal', 'bundled.ts');
/** Where the runtime resolves the bundled build, relative to the package's `dist` (and to `src` in development). */
export const BUNDLED_DIR = join('adapters', 'core', 'shell-sandbox-bwrap', 'bundled');
export const BWRAP_ARCHES = Object.freeze(['x86_64', 'aarch64']);
/** Node's `process.arch` for each build architecture: the directory the runtime would resolve inside the package. */
export const NODE_ARCH = Object.freeze({ x86_64: 'x64', aarch64: 'arm64' });

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const option = (name, fallback) => { const at = process.argv.indexOf(name); return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback; };

/** A cached download whose bytes must hash to the lock's value; a mismatch (cached or fetched) refuses the build. */
async function verifiedFile(url, expected, path) {
  if (!existsSync(path)) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`download failed ${response.status}: ${url}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  const actual = sha256(readFileSync(path));
  if (actual !== expected) throw new Error(`sha256 mismatch for ${url}: expected ${expected}, got ${actual} (${path})`);
  return path;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const RESOLVED_PACKAGE = /^([a-z0-9][\w.+-]*)-([0-9][\w.+-]*-r[0-9]+)$/u;
/** apk info's name-version inventory becomes exact solver constraints, including transitive dependencies. */
export function resolvedPackagePins(packages) {
  return packages.map(entry => {
    const match = typeof entry === 'string' && RESOLVED_PACKAGE.exec(entry);
    if (!match) throw new Error(`resolved package is not name-version: ${entry}`);
    return `${match[1]}=${match[2]}`;
  });
}
/** What the lock fails to pin (empty when complete): the build refuses to run on any of these. */
export function lockProblems(lock) {
  const problems = [];
  if (!lock.source?.url?.includes(`/v${lock.version}/`)) problems.push(`source.url does not name version ${lock.version}`);
  if (!SHA256.test(lock.source?.sha256 ?? '')) problems.push(`source.sha256 is not a sha256: ${lock.source?.sha256}`);
  if (!/@sha256:[0-9a-f]{64}$/u.test(lock.buildImage?.reference ?? '')) problems.push(`buildImage.reference is not pinned by digest: ${lock.buildImage?.reference}`);
  for (const key of ['hostPackages', 'sysrootPackages']) {
    (lock[key] ?? []).forEach((spec, index) => { if (!/^[a-z0-9][\w.+-]*=[\w.+-]+$/u.test(spec)) problems.push(`${key}[${index}] is not pinned (name=version): ${spec}`); });
  }
  for (const key of ['host', ...BWRAP_ARCHES.map(arch => `sysroot-${arch}`)]) {
    if (!Array.isArray(lock.resolvedPackages?.[key]) || !lock.resolvedPackages[key].length) problems.push(`resolvedPackages.${key} is missing`);
    else lock.resolvedPackages[key].forEach((entry, index) => {
      if (typeof entry !== 'string' || !RESOLVED_PACKAGE.test(entry)) problems.push(`resolvedPackages.${key}[${index}] is not name-version: ${entry}`);
    });
  }
  for (const arch of BWRAP_ARCHES) {
    if (!SHA256.test(lock.outputs?.[arch]?.sha256 ?? '')) problems.push(`outputs.${arch}.sha256 is not a sha256: ${lock.outputs?.[arch]?.sha256}`);
  }
  for (const part of lock.linked ?? []) {
    if (part.licenseText && !SHA256.test(part.licenseText.sha256 ?? '')) problems.push(`linked ${part.name} license text is not pinned`);
  }
  if (!Array.isArray(lock.shipArches) || !lock.shipArches.length || !lock.shipArches.every(arch => BWRAP_ARCHES.includes(arch))) problems.push(`shipArches must name built architectures: ${lock.shipArches}`);
  return problems;
}

/** The TypeScript module the runtime compares the bundled file with: version, minimum kernel and the sha256 of each shipped architecture. */
export function bundledIdentityModule(lock) {
  const sha = lock.shipArches.map(arch => `    ${NODE_ARCH[arch]}: '${lock.outputs[arch].sha256}',`).join('\n');
  return ['// Generated from packaging/bwrap/bwrap.lock.json by `node scripts/build-bwrap.mjs --constant` (BWRAP-SELECT); do not edit.',
    '/** The bundled bubblewrap build this package ships: its version, the oldest kernel it supports and its sha256 per Node architecture. */',
    'export const BUBBLEWRAP_BUNDLED = Object.freeze({', `  version: '${lock.version}',`, `  minimumKernel: '${lock.minimumKernel}',`,
    `  sha256: Object.freeze({\n${sha}\n  }) as Readonly<Partial<Record<string, string>>>,`, '});', ''].join('\n');
}

/** Problems of a staged bundle directory against the lock (empty when it is exactly the locked build for the shipped architectures). */
export function bundleProblems(dir, lock) {
  const problems = [];
  if (!existsSync(dir)) return [`no bundled bubblewrap at ${dir}`];
  const shipped = lock.shipArches.map(arch => `linux-${NODE_ARCH[arch]}`);
  for (const entry of readdirSync(dir).filter(name => name.startsWith('linux-'))) if (!shipped.includes(entry)) problems.push(`${entry} is not a shipped architecture`);
  for (const arch of lock.shipArches) {
    const path = join(dir, `linux-${NODE_ARCH[arch]}`, 'bwrap');
    if (!existsSync(path)) { problems.push(`missing linux-${NODE_ARCH[arch]}/bwrap`); continue; }
    const digest = sha256(readFileSync(path));
    if (digest !== lock.outputs[arch].sha256) problems.push(`linux-${NODE_ARCH[arch]}/bwrap sha256 ${digest} is not the locked ${lock.outputs[arch].sha256}`);
  }
  for (const file of ['NOTICE-bubblewrap.txt', 'licenses/bubblewrap-COPYING', 'licenses/musl-COPYRIGHT', 'licenses/libcap-License',
    `source/bubblewrap-${lock.version}.tar.xz`, 'source/build.sh', 'source/bwrap.lock.json']) if (!existsSync(join(dir, file))) problems.push(`missing ${file}`);
  const tarball = join(dir, 'source', `bubblewrap-${lock.version}.tar.xz`), shippedLock = join(dir, 'source', 'bwrap.lock.json');
  if (existsSync(tarball) && sha256(readFileSync(tarball)) !== lock.source.sha256) problems.push('source tarball does not match the lock');
  if (existsSync(shippedLock) && JSON.stringify(JSON.parse(readFileSync(shippedLock, 'utf8'))) !== JSON.stringify(lock)) problems.push('source/bwrap.lock.json is not the lock');
  return problems;
}

/** Copies a build output (`<out>/out` of this script, or that directory itself) into `target` as the runtime expects it: the shipped
 * architectures' binaries (0755) with the notice, license texts and the corresponding source (LGPL-2.1 §4). Refuses anything off the lock.
 * The recipe and lock shipped are the repository's (the binaries' locked sha256 proves they are what this recipe builds); the notice is
 * regenerated from the lock. */
export function stageBundle(from, target, lock) {
  const out = existsSync(join(from, 'out')) ? join(from, 'out') : from;
  for (const arch of lock.shipArches) {
    const digest = sha256(readFileSync(join(out, arch, 'bwrap')));
    if (digest !== lock.outputs[arch].sha256) throw new Error(`${join(out, arch, 'bwrap')} sha256 ${digest} is not the locked ${lock.outputs[arch].sha256}`);
  }
  rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true });
  for (const arch of lock.shipArches) {
    const dir = join(target, `linux-${NODE_ARCH[arch]}`); mkdirSync(dir);
    copyFileSync(join(out, arch, 'bwrap'), join(dir, 'bwrap')); chmodSync(join(dir, 'bwrap'), 0o755);
  }
  writeFileSync(join(target, 'NOTICE-bubblewrap.txt'), bwrapNotice(lock));
  cpSync(join(out, 'licenses'), join(target, 'licenses'), { recursive: true });
  mkdirSync(join(target, 'source'));
  copyFileSync(join(out, 'source', `bubblewrap-${lock.version}.tar.xz`), join(target, 'source', `bubblewrap-${lock.version}.tar.xz`));
  copyFileSync(join(PACKAGING, 'build.sh'), join(target, 'source', 'build.sh'));
  writeFileSync(join(target, 'source', 'bwrap.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  const problems = bundleProblems(target, lock);
  if (problems.length) throw new Error(`staged bundle is not the locked build: ${problems.join('; ')}`);
  return target;
}

/** The notice shipped next to the executable: what it is, its license, where its exact source is, and the linked components. The
 * source tarball travels with the binary (LGPL-2.1 §4 "accompany it with the complete corresponding machine-readable source code"). */
export function bwrapNotice(lock) {
  const lines = [`bubblewrap ${lock.version} (${lock.license}) — a separate program shipped with Deckent, run as a subprocess.`,
    `Corresponding source (included): source/bubblewrap-${lock.version}.tar.xz, identical to ${lock.source.url}`,
    `  sha256 ${lock.source.sha256}; git tag ${lock.source.tag} (commit ${lock.source.commit}), signed by ${lock.source.tagSigningPrimaryKey}.`,
    '  Build recipe and exact toolchain: source/build.sh and source/bwrap.lock.json.', '',
    'Statically linked into this executable:'];
  for (const part of lock.linked) lines.push(`  ${part.name} ${part.version} — ${part.license}`);
  lines.push('', 'License texts: licenses/bubblewrap-COPYING (LGPL-2.1), licenses/musl-COPYRIGHT, licenses/libcap-License.', '');
  return lines.join('\n');
}

async function main() {
  const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
  if (process.argv.includes('--constant')) { writeFileSync(IDENTITY_MODULE, bundledIdentityModule(lock)); process.stdout.write(`${IDENTITY_MODULE}\n`); return; }
  const stageFrom = option('--stage-dev', null);
  if (stageFrom) { process.stdout.write(`${stageBundle(resolve(stageFrom), join(ROOT, 'src', BUNDLED_DIR), lock)}\n`); return; }
  const arch = option('--arch', 'all');
  const arches = arch === 'all' ? BWRAP_ARCHES : [arch];
  if (!arches.every(value => BWRAP_ARCHES.includes(value))) throw new Error(`unknown --arch ${arch}`);
  const record = process.argv.includes('--record');
  // A first `--record` may lack outputs and resolved package sets; every other pin is required before anything is downloaded or run.
  const problems = lockProblems(lock).filter(problem => !(record && /^(?:outputs|resolvedPackages)\./u.test(problem)));
  if (problems.length) throw new Error(`bwrap.lock.json is incomplete: ${problems.join('; ')}`);
  const cache = resolve(option('--cache', join(ROOT, '.pack', 'bwrap', 'cache')));
  const out = resolve(option('--out', join(ROOT, '.pack', 'bwrap', `build-${Date.now()}`)));
  if (existsSync(out) && readdirSync(out).length) throw new Error(`--out ${out} is not empty; refusing to overwrite`);
  mkdirSync(cache, { recursive: true }); mkdirSync(join(out, 'in'), { recursive: true }); mkdirSync(join(out, 'out'), { recursive: true });

  const tarball = `bubblewrap-${lock.version}.tar.xz`;
  copyFileSync(await verifiedFile(lock.source.url, lock.source.sha256, join(cache, tarball)), join(out, 'in', tarball));
  copyFileSync(join(PACKAGING, 'build.sh'), join(out, 'in', 'build.sh'));
  const texts = {};
  for (const part of lock.linked.filter(entry => entry.licenseText)) {
    texts[part.name] = await verifiedFile(part.licenseText.url, part.licenseText.sha256, join(cache, `${part.name}-${part.version}-license.txt`));
  }

  const uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0;
  const env = { BWRAP_VERSION: lock.version, SOURCE_DATE_EPOCH: lock.sourceDateEpoch, HOST_PACKAGES: lock.hostPackages.join(' '),
    SYSROOT_PACKAGES: lock.sysrootPackages.join(' '), ARCHES: arches.join(' '), OUT_OWNER: `${uid}:${gid}`,
    HOST_RESOLVED_PACKAGES: resolvedPackagePins(lock.resolvedPackages?.host ?? []).join(' ') };
  for (const name of arches) env[`SYSROOT_${name.toUpperCase()}_RESOLVED_PACKAGES`] = resolvedPackagePins(lock.resolvedPackages?.[`sysroot-${name}`] ?? []).join(' ');
  const log = execFileSync('docker', ['run', '--rm', ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '-v', `${join(out, 'in')}:/in:ro`, '-v', `${join(out, 'out')}:/out`, lock.buildImage.reference, 'sh', '/in/build.sh'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(out, 'build.log'), log);

  copyFileSync(texts.musl, join(out, 'out', 'licenses', 'musl-COPYRIGHT'));
  copyFileSync(texts.libcap, join(out, 'out', 'licenses', 'libcap-License'));
  writeFileSync(join(out, 'out', 'NOTICE-bubblewrap.txt'), bwrapNotice(lock));

  // The whole resolved package set (dependencies included) must equal the lock's: a silently upgraded toolchain is a different build.
  const lines = path => readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const resolved = { host: lines(join(out, 'out', 'host-packages.txt')) };
  for (const name of arches) resolved[`sysroot-${name}`] = lines(join(out, 'out', name, 'sysroot-packages.txt'));
  const drift = Object.entries(resolved).filter(([key, list]) => lock.resolvedPackages?.[key] && lock.resolvedPackages[key].join('\n') !== list.join('\n'))
    .map(([key]) => key);
  const results = {};
  let mismatch = drift.length > 0 && !record;
  if (drift.length) process.stderr.write(`build-bwrap: resolved packages differ from the lock: ${drift.join(', ')}\n`);
  for (const name of arches) {
    const digest = sha256(readFileSync(join(out, 'out', name, 'bwrap')));
    const expected = lock.outputs?.[name]?.sha256;
    results[name] = { sha256: digest, expected: expected ?? null, match: expected === digest };
    if (!record && expected !== digest) mismatch = true;
  }
  if (record) {
    lock.resolvedPackages = { ...lock.resolvedPackages, ...resolved };
    lock.outputs = { ...lock.outputs };
    for (const name of arches) lock.outputs[name] = { nodeArch: NODE_ARCH[name], sha256: results[name].sha256 };
    writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
    writeFileSync(IDENTITY_MODULE, bundledIdentityModule(lock));
  }
  // The corresponding source travels with the output, after a `--record` wrote the lock, so the shipped lock names these outputs.
  mkdirSync(join(out, 'out', 'source'));
  for (const [from, name] of [[join(out, 'in', tarball), tarball], [join(PACKAGING, 'build.sh'), 'build.sh'], [LOCK, 'bwrap.lock.json']]) {
    copyFileSync(from, join(out, 'out', 'source', name));
  }
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ version: lock.version, image: lock.buildImage.reference, results, drift, recorded: record }, null, 2) + '\n');
  process.stdout.write(`${JSON.stringify({ out, results, drift, recorded: record })}\n`);
  if (mismatch) { process.stderr.write('build-bwrap: output or package set differs from bwrap.lock.json (not reproducible, or the lock is stale)\n'); process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`build-bwrap: ${error.message}\n`); process.exitCode = 1; });
}
