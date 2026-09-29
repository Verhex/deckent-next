import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// BWRAP-BUNDLE: the shipped bubblewrap is identified by one lock (source, build image, every package, outputs); the build refuses a lock
// that does not pin all of them, and the notice shipped next to the binary names its license, exact source and linked components.
// @ts-expect-error JavaScript build tooling has no declaration file.
import { BWRAP_ARCHES, bwrapNotice, lockProblems } from '../../../scripts/build-bwrap.mjs';

const lock = JSON.parse(readFileSync(new URL('../../../packaging/bwrap/bwrap.lock.json', import.meta.url), 'utf8'));
const buildScript = readFileSync(new URL('../../../packaging/bwrap/build.sh', import.meta.url), 'utf8');
const mutated = (change: (copy: typeof lock) => void) => { const copy = structuredClone(lock); change(copy); return lockProblems(copy) as string[]; };

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
});
