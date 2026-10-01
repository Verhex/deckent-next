import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// BWRAP-BUNDLE: the shipped bubblewrap is identified by one lock (source, build image, every package, outputs); the build refuses a lock
// that does not pin all of them, and the notice shipped next to the binary names its license, exact source and linked components.
// @ts-expect-error JavaScript build tooling has no declaration file.
import { BWRAP_ARCHES, bundledIdentityModule, bundleProblems, bwrapNotice, IDENTITY_MODULE, lockProblems, resolvedPackagePins, stageBundle } from '../../../scripts/build-bwrap.mjs';

const lock = JSON.parse(readFileSync(new URL('../../../packaging/bwrap/bwrap.lock.json', import.meta.url), 'utf8'));
const buildScript = readFileSync(new URL('../../../packaging/bwrap/build.sh', import.meta.url), 'utf8');
const mutated = (change: (copy: typeof lock) => void) => { const copy = structuredClone(lock); change(copy); return lockProblems(copy) as string[]; };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** A build-bwrap output tree with fake binaries whose sha256 a copy of the lock then names. */
function fakeBuild() {
  const root = mkdtempSync(join(tmpdir(), 'bwrap-stage-')); roots.push(root);
  const out = join(root, 'build', 'out'), copy = structuredClone(lock);
  for (const arch of BWRAP_ARCHES) { mkdirSync(join(out, arch), { recursive: true }); writeFileSync(join(out, arch, 'bwrap'), `fake ${arch}\n`); copy.outputs[arch].sha256 = sha(`fake ${arch}\n`); }
  mkdirSync(join(out, 'licenses')); for (const name of ['bubblewrap-COPYING', 'musl-COPYRIGHT', 'libcap-License']) writeFileSync(join(out, 'licenses', name), name);
  mkdirSync(join(out, 'source')); writeFileSync(join(out, 'source', `bubblewrap-${lock.version}.tar.xz`), 'tarball'); copy.source.sha256 = sha('tarball');
  return { root, build: join(root, 'build'), copy };
}

describe('bubblewrap bundle lock (BWRAP-BUNDLE)', () => {
  it('pins source, image, every package and one output per architecture; a missing pin is a named problem', () => {
    expect(lockProblems(lock)).toEqual([]);
    expect(Object.keys(lock.outputs).sort()).toEqual([...BWRAP_ARCHES].sort());
    expect(mutated(copy => { copy.hostPackages[0] = 'clang22'; })).toEqual(['hostPackages[0] is not pinned (name=version): clang22']);
    expect(mutated(copy => { copy.buildImage.reference = 'alpine:3'; })).toEqual(['buildImage.reference is not pinned by digest: alpine:3']);
    expect(mutated(copy => { copy.source.sha256 = 'abc'; })).toEqual(['source.sha256 is not a sha256: abc']);
    expect(mutated(copy => { delete copy.outputs.aarch64; })).toEqual(['outputs.aarch64.sha256 is not a sha256: undefined']);
    expect(mutated(copy => { copy.source.url = copy.source.url.replace('0.13.0', '0.12.0'); })).toEqual(['source.url does not name version 0.13.0']);
    expect(mutated(copy => { delete copy.resolvedPackages['sysroot-x86_64']; })).toEqual(['resolvedPackages.sysroot-x86_64 is missing']);
    expect(mutated(copy => { copy.resolvedPackages.host[0] = 'python3'; })).toEqual(['resolvedPackages.host[0] is not name-version: python3']);
  });

  it('constrains transitive packages as well as direct requests; malformed inventory fails rather than yielding an unpinned request', () => {
    const hostPins = resolvedPackagePins(lock.resolvedPackages.host) as string[];
    expect(hostPins).toContain('python3-pycache-pyc0=3.14.8-r0');
    expect(hostPins).toContain('nghttp2-libs=1.70.0-r0');
    for (const pin of lock.hostPackages) expect(hostPins).toContain(pin);
    for (const arch of BWRAP_ARCHES) {
      const sysrootPins = resolvedPackagePins(lock.resolvedPackages[`sysroot-${arch}`]) as string[];
      for (const pin of lock.sysrootPackages) expect(sysrootPins).toContain(pin);
    }
    expect(resolvedPackagePins(['ncurses-terminfo-base-6.6_p20260516-r0'])).toEqual(['ncurses-terminfo-base=6.6_p20260516-r0']);
    expect(() => resolvedPackagePins(['python3'])).toThrow('resolved package is not name-version: python3');
    expect(() => resolvedPackagePins(['python3=latest'])).toThrow('resolved package is not name-version: python3=latest');
    expect(() => resolvedPackagePins(['python3-3.14.8-r0 extra'])).toThrow('resolved package is not name-version:');
  });

  it('builds without setuid or SELinux and with the options the lock records', () => {
    for (const option of lock.mesonOptions) expect(buildScript).toContain(option);
    expect(buildScript).not.toMatch(/chmod\s+(?:[0-7]*[4-7][0-7]{3}\b|[ug]\+s)/u);
    expect(lock.license).toBe('LGPL-2.1-or-later');
  });

  it('ships a notice with the license, the exact corresponding source and every linked component', () => {
    const notice = bwrapNotice(lock) as string;
    for (const text of [`bubblewrap ${lock.version}`, lock.license, lock.source.url, lock.source.sha256, lock.source.commit,
      ...lock.linked.map((part: { name: string; license: string }) => `${part.name}`)]) expect(notice).toContain(text);
  });

  it('the runtime identity constant is generated from the lock and ships only the architectures the lock ships (aarch64 withheld)', () => {
    expect(readFileSync(IDENTITY_MODULE, 'utf8')).toBe(bundledIdentityModule(lock));
    expect(lock.shipArches).toEqual(['x86_64']);
    expect(lock.shipNote).toMatch(/arm64/u);
    expect(lock.mesonOptions).toContain('-Dassume_kernel=5.15.0');
    expect(lock.minimumKernel).toBe('5.15.0');
    expect(mutated(copy => { copy.shipArches = ['riscv64']; })).toEqual(['shipArches must name built architectures: riscv64']);
  });

  it('stages only the locked binaries of shipped architectures with notice, licenses and the corresponding source; refuses anything else', () => {
    const { root, build, copy } = fakeBuild();
    const target = join(root, 'bundled');
    stageBundle(build, target, copy);
    expect(statSync(join(target, 'linux-x64', 'bwrap')).mode & 0o777).toBe(0o755);
    expect(() => statSync(join(target, 'linux-arm64'))).toThrow();
    expect(readFileSync(join(target, 'NOTICE-bubblewrap.txt'), 'utf8')).toBe(bwrapNotice(copy));
    expect(readFileSync(join(target, 'source', 'build.sh'), 'utf8')).toBe(buildScript);
    expect(JSON.parse(readFileSync(join(target, 'source', 'bwrap.lock.json'), 'utf8'))).toEqual(copy);
    expect(bundleProblems(target, copy)).toEqual([]);
    expect(bundleProblems(target, lock)).toContain('source/bwrap.lock.json is not the lock');
    // Drift is named: a changed binary, an extra architecture, a missing source file.
    writeFileSync(join(target, 'linux-x64', 'bwrap'), 'other\n'); cpSync(join(target, 'linux-x64'), join(target, 'linux-arm64'), { recursive: true });
    rmSync(join(target, 'source', 'build.sh'));
    expect(bundleProblems(target, copy)).toEqual(['linux-arm64 is not a shipped architecture',
      `linux-x64/bwrap sha256 ${sha('other\n')} is not the locked ${copy.outputs.x86_64.sha256}`, 'missing source/build.sh']);
    // A build output off the lock is never staged.
    writeFileSync(join(build, 'out', 'x86_64', 'bwrap'), 'tampered\n'); chmodSync(join(build, 'out', 'x86_64', 'bwrap'), 0o755);
    expect(() => stageBundle(build, join(root, 'again'), copy)).toThrow(/is not the locked/u);
    expect(existsSync(join(root, 'again'))).toBe(false); // refused before anything is written
  });
});
