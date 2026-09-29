// build-bwrap (BWRAP-BUNDLE, owner 2026-09-29): a pinned, hash-verified bubblewrap to ship with the product. Reproducible build of the
// release tarball named by packaging/bwrap/bwrap.lock.json inside the Alpine image pinned there by digest (packaging/bwrap/build.sh):
// static-pie, musl + libcap linked in, no SELinux, never setuid (0.12.0 removed setuid support; the binary refuses to run setuid).
// The source tarball and the linked components' license texts are verified against the lock before anything runs; the output sha256 is
// compared with the lock (a mismatch fails) unless `--record` writes it. The output directory must not exist or be empty.
// Usage: node scripts/build-bwrap.mjs [--arch x86_64|aarch64|all] [--out .pack/bwrap/<time>] [--cache .pack/bwrap/cache] [--record]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGING = join(ROOT, 'packaging', 'bwrap');
const LOCK = join(PACKAGING, 'bwrap.lock.json');
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
  }
  for (const arch of BWRAP_ARCHES) {
    if (!SHA256.test(lock.outputs?.[arch]?.sha256 ?? '')) problems.push(`outputs.${arch}.sha256 is not a sha256: ${lock.outputs?.[arch]?.sha256}`);
  }
  for (const part of lock.linked ?? []) {
    if (part.licenseText && !SHA256.test(part.licenseText.sha256 ?? '')) problems.push(`linked ${part.name} license text is not pinned`);
  }
  return problems;
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
    SYSROOT_PACKAGES: lock.sysrootPackages.join(' '), ARCHES: arches.join(' '), OUT_OWNER: `${uid}:${gid}` };
  const log = execFileSync('docker', ['run', '--rm', ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '-v', `${join(out, 'in')}:/in:ro`, '-v', `${join(out, 'out')}:/out`, lock.buildImage.reference, 'sh', '/in/build.sh'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(out, 'build.log'), log);

  copyFileSync(texts.musl, join(out, 'out', 'licenses', 'musl-COPYRIGHT'));
  copyFileSync(texts.libcap, join(out, 'out', 'licenses', 'libcap-License'));
  writeFileSync(join(out, 'out', 'NOTICE-bubblewrap.txt'), bwrapNotice(lock));
  mkdirSync(join(out, 'out', 'source'));
  for (const [from, name] of [[join(out, 'in', tarball), tarball], [join(PACKAGING, 'build.sh'), 'build.sh'], [LOCK, 'bwrap.lock.json']]) {
    copyFileSync(from, join(out, 'out', 'source', name));
  }

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
  }
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ version: lock.version, image: lock.buildImage.reference, results, drift, recorded: record }, null, 2) + '\n');
  process.stdout.write(`${JSON.stringify({ out, results, drift, recorded: record })}\n`);
  if (mismatch) { process.stderr.write('build-bwrap: output or package set differs from bwrap.lock.json (not reproducible, or the lock is stale)\n'); process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`build-bwrap: ${error.message}\n`); process.exitCode = 1; });
}
