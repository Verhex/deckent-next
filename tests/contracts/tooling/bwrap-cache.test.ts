import { createHash } from 'node:crypto';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { chmodSync, closeSync, openSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error Executable JS tooling has no declaration file.
import { CACHE_INPUTS, cacheIdentity, restoreBuild, saveBuild, verifyCache } from '../../../scripts/bwrap-cache.mjs';

const roots: string[] = [], repo = fileURLToPath(new URL('../../..', import.meta.url));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
// Same command/argv/assertions; regular-file capture avoids the host's restricted socket-backed stdio.
function capture(command: string, args: string[], options: ExecFileSyncOptions) {
  const root = mkdtempSync(join(tmpdir(), 'bwrap-capture-')); roots.push(root);
  const out = join(root, 'stdout'), err = join(root, 'stderr');
  const stdoutFd = openSync(out, 'wx', 0o600), stderrFd = openSync(err, 'wx', 0o600);
  let failure: unknown;
  try { execFileSync(command, args, { ...options, timeout: 10000, stdio: ['ignore', stdoutFd, stderrFd] }); }
  catch (error) { failure = error; }
  finally { closeSync(stdoutFd); closeSync(stderrFd); }
  const stdout = readFileSync(out, 'utf8'), stderr = readFileSync(err, 'utf8');
  if (failure) throw Object.assign(failure, { stdout, stderr });
  return stdout;
}

afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bwrap-cache-')); roots.push(root);
  const lock = JSON.parse(readFileSync(join(repo, 'packaging/bwrap/bwrap.lock.json'), 'utf8'));
  const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  for (const path of CACHE_INPUTS as string[]) { mkdirSync(dirname(join(root, path)), { recursive: true }); cpSync(join(repo, path), join(root, path)); }
  lock.outputs.x86_64.sha256 = sha('binary-x86_64'); lock.source.sha256 = sha('source');
  for (const part of lock.linked.filter((part: { licenseText: unknown }) => part.licenseText)) part.licenseText.sha256 = sha(part.name);
  write('packaging/bwrap/bwrap.lock.json', JSON.stringify(lock));
  const build = join(root, 'built');
  write('built/out/x86_64/bwrap', 'binary-x86_64');
  write('built/out/host-packages.txt', lock.resolvedPackages.host.join('\n') + '\n');
  write('built/out/x86_64/sysroot-packages.txt', lock.resolvedPackages['sysroot-x86_64'].join('\n') + '\n');
  for (const key of ['host', 'sysroot-x86_64']) write(`built/out/apk/${key}/package.apk`, key);
  write('built/out/source/bwrap.lock.json', JSON.stringify(lock)); write(`built/out/source/bubblewrap-${lock.version}.tar.xz`, 'source');
  write('built/out/source/build.sh', readFileSync(join(root, 'packaging/bwrap/build.sh'), 'utf8'));
  for (const [name, content] of [['bubblewrap-COPYING', 'copying'], ['musl-COPYRIGHT', 'musl'], ['libcap-License', 'libcap']]) write(`built/out/licenses/${name}`, content!);
  return { root, lock, build, cached: join(root, 'cache/build-x86_64'), arches: ['x86_64'] };
}
it('treats absence as miss; a hit verifies APK checksums, exact closure, source and locked binary before copying', () => {
  const f = fixture(), target = join(f.root, 'target');
  expect(restoreBuild(f.cached, target, f.root, f.lock, f.arches)).toBe(false);
  saveBuild(f.build, f.cached, f.root, f.lock, f.arches);
  expect(restoreBuild(f.cached, target, f.root, f.lock, f.arches)).toBe(true);
  expect(readFileSync(join(target, 'out/x86_64/bwrap'), 'utf8')).toBe('binary-x86_64');
  writeFileSync(join(f.cached, 'out/apk/host/package.apk'), 'corruption');
  expect(() => restoreBuild(f.cached, join(f.root, 'refused'), f.root, f.lock, f.arches)).toThrow(/file\/APK checksums/u);
  expect(existsSync(join(f.root, 'refused'))).toBe(false);
});
it('rejects tampered binary even if the cache checksum manifest was rewritten to match it', () => {
  const f = fixture(); saveBuild(f.build, f.cached, f.root, f.lock, f.arches);
  writeFileSync(join(f.cached, 'out/x86_64/bwrap'), 'other');
  const path = join(f.cached, 'cache-manifest.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.files['out/x86_64/bwrap'] = sha('other'); writeFileSync(path, JSON.stringify(manifest));
  expect(() => verifyCache(f.cached, f.root, f.lock, f.arches)).toThrow(/locked sha256 mismatch/u);
});
it.each(['host', 'sysroot-x86_64'])('refuses a different %s closure before saving', key => {
  const f = fixture(), path = key === 'host' ? 'host-packages.txt' : 'x86_64/sysroot-packages.txt';
  writeFileSync(join(f.build, 'out', path), 'different-1.0-r0\n');
  expect(() => saveBuild(f.build, f.cached, f.root, f.lock, f.arches)).toThrow(/package closure differs/u);
  expect(existsSync(f.cached)).toBe(false);
});
it.each(CACHE_INPUTS as string[])('binds cache identity to %s and target architecture', path => {
  const f = fixture(); saveBuild(f.build, f.cached, f.root, f.lock, f.arches);
  expect(cacheIdentity(f.root, ['aarch64'])).not.toEqual(cacheIdentity(f.root, f.arches));
  writeFileSync(join(f.root, path), 'changed input');
  expect(() => verifyCache(f.cached, f.root, f.lock, f.arches)).toThrow(/input identity differs/u);
});
it.skipIf(process.platform === 'win32')('refuses symlink payloads rather than hashing through them', () => {
  const f = fixture(); saveBuild(f.build, f.cached, f.root, f.lock, f.arches);
  const path = join(f.cached, 'out/apk/host/package.apk'); rmSync(path); symlinkSync(join(f.build, 'out/apk/host/package.apk'), path);
  expect(() => verifyCache(f.cached, f.root, f.lock, f.arches)).toThrow(/not a regular single-link/u);
});
it('the real driver consumes a verified hit without Docker, network or an executable search path', () => {
  const f = fixture(); saveBuild(f.build, f.cached, f.root, f.lock, f.arches);
  const stdout = capture(process.execPath, [join(f.root, 'scripts/build-bwrap.mjs'), '--reuse', '--arch', 'x86_64',
    '--cache', join(f.root, 'cache'), '--out', join(f.root, 'served')], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  expect(stdout).toContain('verified cache hit; no Docker or Alpine access');
  expect(readFileSync(join(f.root, 'served/out/x86_64/bwrap'), 'utf8')).toBe('binary-x86_64');
});
it.skipIf(process.platform === 'win32')('cache miss errors retain the failing build log and identify the refresh path; no implicit retry', () => {
  const f = fixture(), cache = join(f.root, 'downloads'), bin = join(f.root, 'bin'); mkdirSync(cache); mkdirSync(bin);
  writeFileSync(join(cache, `bubblewrap-${f.lock.version}.tar.xz`), 'source');
  for (const part of f.lock.linked.filter((part: { licenseText: unknown }) => part.licenseText)) writeFileSync(join(cache, `${part.name}-${part.version}-license.txt`), part.name);
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho vanished-apk >&2\nexit 42\n'); chmodSync(join(bin, 'docker'), 0o755);
  const out = join(f.root, 'miss');
  try { capture(process.execPath, [join(f.root, 'scripts/build-bwrap.mjs'), '--reuse', '--arch', 'x86_64', '--cache', cache, '--out', out],
    { env: { ...process.env, PATH: bin }, stdio: 'pipe' }); expect.unreachable(); }
  catch (error) { expect(String((error as { stderr: Buffer }).stderr)).toContain('BWRAP_BUILD_FAILED: cache miss build failed. If Alpine pins vanished, run the platform verification deps-watch refresh'); }
  expect(readFileSync(join(out, 'build.log'), 'utf8')).toContain('vanished-apk');
  expect(existsSync(join(cache, 'build-x86_64'))).toBe(false);
});
it('all build workflows restore exact keys including recipes, verify before use/save, and keep SHA-pinned cache actions', () => {
  for (const name of ['ci', 'bwrap-bundle', 'platform-verification']) {
    const workflow = readFileSync(join(repo, `.github/workflows/${name}.yml`), 'utf8');
    const key = workflow.split('\n').find(line => line.includes('key: bwrap-v2-')) ?? '';
    for (const input of CACHE_INPUTS as string[]) expect(key).toContain(`'${input}'`);
    expect(key).toContain('${{ runner.os }}-${{ runner.arch }}-');
    expect(workflow).not.toContain('restore-keys:');
    expect(workflow).toContain('node scripts/build-bwrap.mjs --reuse --arch');
    expect(workflow).toContain('node scripts/build-bwrap.mjs --verify-cache --arch');
    expect(workflow.indexOf('--verify-cache')).toBeLessThan(workflow.indexOf('uses: actions/cache/save@'));
    for (const match of workflow.matchAll(/uses: (actions\/cache\/\w+@\S+)/gu)) expect(match[1]).toMatch(/@[a-f0-9]{40}$/u);
  }
  const recipe = readFileSync(join(repo, 'packaging/bwrap/build.sh'), 'utf8');
  expect(recipe).toContain('--cache-packages'); expect(recipe).not.toContain('--allow-untrusted');
  expect(recipe).toContain('BWRAP_PIN_REFRESH_REQUIRED');
});
