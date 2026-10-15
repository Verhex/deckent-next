// Scheduled pin drift producer. All builds happen in a disposable tree; publish candidates only after a second check build.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { BWRAP_ARCHES, bundledIdentityModule, resolvedPackagePins } from './build-bwrap.mjs';
import { CACHE_INPUTS } from './bwrap-cache.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const REFRESH_PATHS = Object.freeze(['packaging/bwrap/bwrap.lock.json', 'src/adapters/core/shell-sandbox-bwrap/internal/bundled.ts']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const run = (binary, args) => execFileSync(binary, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 });

/** No arch is optional; a different direct dependency version per sysroot requires a deliberate recipe change. */
export function refreshedLock(lock, resolved) {
  const result = structuredClone(lock);
  const maps = Object.fromEntries(['host', ...BWRAP_ARCHES.map(arch => `sysroot-${arch}`)].map(key => {
    if (!Array.isArray(resolved[key]) || !resolved[key].length) throw new Error(`missing resolved closure: ${key}`);
    return [key, new Map(resolvedPackagePins(resolved[key]).map(pin => pin.split('=')))];
  }));
  const pins = (old, keys) => old.map(pin => {
    const name = pin.split('=')[0], versions = keys.map(key => maps[key].get(name));
    if (versions.some(value => !value) || new Set(versions).size !== 1) throw new Error(`direct pin missing or differs across architectures: ${name}`);
    return `${name}=${versions[0]}`;
  });
  result.hostPackages = pins(lock.hostPackages, ['host']);
  result.sysrootPackages = pins(lock.sysrootPackages, BWRAP_ARCHES.map(arch => `sysroot-${arch}`));
  result.resolvedPackages = resolved;
  for (const linked of result.linked) {
    const versions = BWRAP_ARCHES.map(arch => maps[`sysroot-${arch}`].get(linked.apk === 'libcap' ? 'libcap2' : linked.apk));
    if (versions.some(value => !value) || new Set(versions).size !== 1) throw new Error(`linked version differs or is missing: ${linked.apk}`);
    if (linked.version !== versions[0] && linked.licenseText) throw new Error(`BWRAP_LICENSE_REFRESH_REQUIRED: ${linked.apk} changed; independently verify its new license text before refreshing pins`);
    linked.version = versions[0];
  }
  return result;
}
export function assertResolved(expected, build, arches = BWRAP_ARCHES) {
  for (const key of ['host', ...arches.map(arch => `sysroot-${arch}`)]) {
    const path = key === 'host' ? 'host-packages.txt' : `${key.slice(8)}/sysroot-packages.txt`;
    const actual = readFileSync(join(build, 'out', path), 'utf8').trim().split('\n').filter(Boolean);
    if (JSON.stringify(actual) !== JSON.stringify(expected[key])) throw new Error(`BWRAP_REFRESH_CLOSURE_DRIFT: ${key}`);
  }
}
export function refreshBody(before, after, evidenceUrl) {
  return [`Automated Alpine ${after.buildImage.alpineRelease} pin refresh; no automatic merge.`, '',
    `Build image: \`${after.buildImage.reference}\``, `Source SHA256: \`${after.source.sha256}\``,
    `Before lock SHA256: \`${sha(JSON.stringify(before))}\``, `Candidate lock SHA256: \`${sha(JSON.stringify(after))}\``, '',
    ...BWRAP_ARCHES.map(arch => `- ${arch}: \`${before.outputs[arch].sha256}\` → \`${after.outputs[arch].sha256}\` (two builds agree)`), '',
    ...Object.keys(after.resolvedPackages).map(key => `- ${key}: removed ${JSON.stringify(before.resolvedPackages[key].filter(pin => !after.resolvedPackages[key].includes(pin)))}; added ${JSON.stringify(after.resolvedPackages[key].filter(pin => !before.resolvedPackages[key].includes(pin)))}`), '',
    `Evidence (resolved host + every sysroot, both build logs and output hashes): ${evidenceUrl}`, '',
    'Release gate: Astra independent review + hosted CI for this exact candidate. GITHUB_TOKEN-created PRs do not trigger normal PR CI; lead must dispatch ci and bwrap-bundle on the generated branch. Never auto-merge.', ''].join('\n');
}
export function refresh({ root = ROOT, out, execute = run }) {
  mkdirSync(out, { recursive: true });
  const logged = (path, binary, args) => {
    try { const output = execute(binary, args); writeFileSync(path, output); return output; }
    catch (error) { writeFileSync(path, `${error.stdout ?? ''}\n${error.stderr ?? error.message}\n`); throw error; }
  };
  const lock = json(join(root, REFRESH_PATHS[0]));
  const scratch = mkdtempSync(join(tmpdir(), 'bwrap-refresh-'));
  // Retained work is kept on failures: no partially verified lock is copied to the checkout.
  writeFileSync(join(out, 'scratch.txt'), `${scratch}\n`);
  const resolvedDir = join(out, 'resolved'); mkdirSync(resolvedDir);
  const env = { HOST_NAMES: lock.hostPackages.map(pin => pin.split('=')[0]).join(' '),
    SYSROOT_NAMES: lock.sysrootPackages.map(pin => pin.split('=')[0]).join(' '), ARCHES: BWRAP_ARCHES.join(' '),
    OUT_OWNER: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}` };
  const args = ['run', '--rm', ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '-v', `${join(root, 'packaging/bwrap/resolve.sh')}:/resolve.sh:ro`, '-v', `${resolvedDir}:/out`, lock.buildImage.reference, 'sh', '/resolve.sh'];
  logged(join(out, 'resolve.log'), 'docker', args);
  const resolved = Object.fromEntries(['host', ...BWRAP_ARCHES.map(arch => `sysroot-${arch}`)].map(key =>
    [key, readFileSync(join(resolvedDir, `${key}-packages.txt`), 'utf8').trim().split('\n').filter(Boolean)]));
  const candidate = refreshedLock(lock, resolved);
  if (JSON.stringify(candidate) === JSON.stringify(lock)) {
    writeFileSync(join(out, 'result.json'), JSON.stringify({ changed: false }) + '\n'); return { changed: false };
  }
  for (const path of [...CACHE_INPUTS, 'packaging/bwrap/resolve.sh']) {
    mkdirSync(dirname(join(scratch, path)), { recursive: true }); cpSync(join(root, path), join(scratch, path));
  }
  mkdirSync(dirname(join(scratch, REFRESH_PATHS[1])), { recursive: true });
  writeFileSync(join(scratch, REFRESH_PATHS[0]), JSON.stringify(candidate, null, 2) + '\n');
  const build = (name, record) => {
    const dest = join(out, name);
    logged(join(out, `${name}.log`), process.execPath, [join(scratch, 'scripts/build-bwrap.mjs'), '--arch', 'all', '--out', dest,
      '--cache', join(out, 'downloads'), ...(record ? ['--record'] : [])]);
    assertResolved(resolved, dest);
  };
  build('build-record', true); build('build-check', false);
  const checked = json(join(scratch, REFRESH_PATHS[0]));
  const evidenceUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : 'local retained refresh directory';
  writeFileSync(join(out, 'PR-BODY.md'), refreshBody(lock, checked, evidenceUrl));
  writeFileSync(join(out, 'before-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  writeFileSync(join(out, 'candidate-lock.json'), JSON.stringify(checked, null, 2) + '\n');
  writeFileSync(join(root, REFRESH_PATHS[0]), JSON.stringify(checked, null, 2) + '\n');
  writeFileSync(join(root, REFRESH_PATHS[1]), bundledIdentityModule(checked));
  const result = { changed: true, title: `build(bwrap): refresh pins (Alpine ${checked.buildImage.alpineRelease})`,
    branch: `build/bwrap-pins-${sha(JSON.stringify(checked)).slice(0, 16)}`, paths: REFRESH_PATHS };
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n'); return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { refresh({ out: resolve(process.argv[2] ?? '.pack/bwrap-refresh') }); }
  catch (error) { process.stderr.write(`refresh-bwrap: ${error.message}\n`); process.exitCode = 1; }
}
