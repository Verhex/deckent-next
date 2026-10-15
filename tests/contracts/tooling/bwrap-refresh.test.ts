import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Executable JS tooling has no declaration file.
import { assertResolved, refresh, refreshedLock, refreshBody, REFRESH_PATHS } from '../../../scripts/refresh-bwrap.mjs';
// @ts-expect-error Executable JS tooling has no declaration file.
import { publish } from '../../../scripts/publish-bwrap-refresh.mjs';
import { bundledIdentityModule } from '../../../scripts/build-bwrap.mjs';
const lock = JSON.parse(readFileSync(new URL('../../../packaging/bwrap/bwrap.lock.json', import.meta.url), 'utf8'));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture() { const root = mkdtempSync(join(tmpdir(), 'bwrap-refresh-')); roots.push(root); return root; }
const closure = () => structuredClone(lock.resolvedPackages) as Record<string, string[]>;
describe('candidate pin resolution', () => {
  it('refreshes transitive and direct pins together and requires every sysroot closure', () => {
    const resolved = closure(); resolved.host = resolved.host!.map(pin => pin.replace('meson-1.11.1-r0', 'meson-1.11.1-r1'));
    const candidate = refreshedLock(lock, resolved);
    expect(candidate.hostPackages).toContain('meson=1.11.1-r1'); expect(candidate.resolvedPackages).toEqual(resolved);
    delete resolved['sysroot-aarch64']; expect(() => refreshedLock(lock, resolved)).toThrow('missing resolved closure: sysroot-aarch64');
  });
  it('refuses a direct pin with different versions across architectures and unverified linked-license upgrades', () => {
    const resolved = closure(); resolved['sysroot-aarch64'] = resolved['sysroot-aarch64']!.map(pin => pin.replace('linux-headers-7.0.0-r1', 'linux-headers-7.0.0-r2'));
    expect(() => refreshedLock(lock, resolved)).toThrow('direct pin missing or differs across architectures: linux-headers');
    const changed = closure();
    for (const key of Object.keys(changed)) changed[key] = changed[key]!.map(pin => pin.replace('musl-1.2.6-r2', 'musl-1.2.6-r3'));
    expect(() => refreshedLock(lock, changed)).toThrow('BWRAP_LICENSE_REFRESH_REQUIRED');
  });
  it('rejects a build whose resolved closure differs from the proposed one for either architecture', () => {
    const root = fixture(); mkdirSync(join(root, 'out/x86_64'), { recursive: true }); mkdirSync(join(root, 'out/aarch64'));
    writeFileSync(join(root, 'out/host-packages.txt'), lock.resolvedPackages.host.join('\n'));
    for (const arch of ['x86_64', 'aarch64']) writeFileSync(join(root, `out/${arch}/sysroot-packages.txt`), lock.resolvedPackages[`sysroot-${arch}`].join('\n'));
    expect(() => assertResolved(lock.resolvedPackages, root)).not.toThrow();
    writeFileSync(join(root, 'out/aarch64/sysroot-packages.txt'), 'bad-1.0-r0\n');
    expect(() => assertResolved(lock.resolvedPackages, root)).toThrow('BWRAP_REFRESH_CLOSURE_DRIFT: sysroot-aarch64');
  });
  it('retains binary comparisons, every closure delta, evidence link and release gate in the PR body', () => {
    const candidate = refreshedLock(lock, closure()), body = refreshBody(lock, candidate, 'https://example.test/evidence');
    for (const arch of ['x86_64', 'aarch64']) expect(body).toContain(`${arch}: \`${lock.outputs[arch].sha256}\``);
    for (const key of Object.keys(lock.resolvedPackages)) expect(body).toContain(`${key}: removed`);
    expect(body).toContain('https://example.test/evidence'); expect(body).toContain('Astra independent review + hosted CI');
    expect(body).toContain('GITHUB_TOKEN-created PRs do not trigger normal PR CI');
  });
  it('the orchestration records then independently checks both architectures before modifying the checkout', () => {
    const root = fixture(), out = join(root, 'evidence'); mkdirSync(join(root, 'packaging/bwrap'), { recursive: true });
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'src/adapters/core/shell-sandbox-bwrap/internal'), { recursive: true });
    const repo = new URL('../../../', import.meta.url);
    for (const path of ['packaging/bwrap/build.sh', 'packaging/bwrap/resolve.sh', 'scripts/build-bwrap.mjs', 'scripts/bwrap-cache.mjs']) {
      writeFileSync(join(root, path), readFileSync(new URL(path, repo)));
    }
    writeFileSync(join(root, REFRESH_PATHS[0]), JSON.stringify(lock)); writeFileSync(join(root, REFRESH_PATHS[1]), 'unchanged identity');
    const resolved = closure(); resolved.host = resolved.host!.map(pin => pin.replace('meson-1.11.1-r0', 'meson-1.11.1-r1'));
    const calls: string[][] = [];
    const execute = (_binary: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'run') {
        expect(args).toContain(lock.buildImage.reference);
        const mount = args.find(arg => arg.endsWith(':/out'))!;
        for (const [key, lines] of Object.entries(resolved)) writeFileSync(join(mount.slice(0, -5), `${key}-packages.txt`), lines.join('\n'));
      } else {
        expect(args).toContain('all');
        const dest = args[args.indexOf('--out') + 1]!; mkdirSync(join(dest, 'out/x86_64'), { recursive: true }); mkdirSync(join(dest, 'out/aarch64'));
        writeFileSync(join(dest, 'out/host-packages.txt'), resolved.host!.join('\n'));
        for (const arch of ['x86_64', 'aarch64']) writeFileSync(join(dest, `out/${arch}/sysroot-packages.txt`), resolved[`sysroot-${arch}`]!.join('\n'));
        expect(readFileSync(join(root, REFRESH_PATHS[0]), 'utf8')).toBe(JSON.stringify(lock));
        if (!args.includes('--record')) throw new Error('second build hash mismatch');
      }
      return 'mock executor log';
    };
    expect(() => refresh({ root, out, execute })).toThrow('second build hash mismatch');
    expect(calls).toHaveLength(3); expect(calls[1]).toContain('--record'); expect(calls[2]).not.toContain('--record');
    expect(readFileSync(join(root, REFRESH_PATHS[1]), 'utf8')).toBe('unchanged identity');
    roots.push(readFileSync(join(out, 'scratch.txt'), 'utf8').trim());
  });
});
describe('bounded PR publication (no live requests)', () => {
  function candidate() {
    const root = fixture(), branch = 'build/bwrap-pins-0123456789abcdef';
    // The base checkout holds the current lock; the candidate copies (out/files) change only pins, as a refresh may.
    const candidateLock = { ...lock, hostPackages: [...lock.hostPackages] };
    const files: Record<string, string> = { [REFRESH_PATHS[0]!]: JSON.stringify(candidateLock, null, 2) + '\n', [REFRESH_PATHS[1]!]: bundledIdentityModule(candidateLock) };
    for (const path of REFRESH_PATHS as string[]) {
      const parts = path.split('/'); parts.pop();
      mkdirSync(join(root, ...parts), { recursive: true }); mkdirSync(join(root, 'files', ...parts), { recursive: true });
      writeFileSync(join(root, path), path === REFRESH_PATHS[0] ? JSON.stringify(lock) : 'base identity'); writeFileSync(join(root, 'files', path), files[path]!);
    }
    writeFileSync(join(root, 'result.json'), JSON.stringify({ changed: true, branch, title: 'build(bwrap): refresh pins (Alpine 3)', paths: REFRESH_PATHS }));
    writeFileSync(join(root, 'PR-BODY.md'), 'retained evidence');
    return { root, out: root, branch, repository: 'example/repo', base: 'main', baseSha: 'a'.repeat(40) };
  }
  it('opens one draft with exactly the two admitted files; never merges or force-updates refs', async () => {
    const input = candidate(), calls: { method: string; path: string; body: Record<string, unknown> | undefined }[] = [];
    const result = await publish({ ...input, request: async (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push({ method, path, body });
      if (path.includes('/pulls?')) return [];
      if (path.includes('/git/ref/')) return null;
      if (path.includes('/git/commits/') && method === 'GET') return { tree: { sha: 'base-tree' } };
      if (path.endsWith('/git/trees')) return { sha: 'candidate-tree' };
      if (path.endsWith('/git/commits')) return { sha: 'candidate-commit' };
      return { html_url: 'https://example.test/pr' };
    } });
    expect(result.url).toBe('https://example.test/pr');
    const tree = calls.find(call => call.path.endsWith('/git/trees'))!.body!.tree as { path: string }[];
    expect(tree.map(entry => entry.path)).toEqual(REFRESH_PATHS);
    expect(calls.at(-1)!.body).toMatchObject({ draft: true, base: 'main', head: input.branch, body: 'retained evidence' });
    expect(calls.some(call => call.method === 'PATCH' || call.method === 'PUT' || call.path.includes('/merge'))).toBe(false);
  });
  it('does not mutate anything for an existing PR or for no drift', async () => {
    const input = candidate(), calls: string[] = [];
    const request = async (method: string) => { calls.push(method); return [{ html_url: 'existing-pr' }]; };
    expect((await publish({ ...input, request })).existing).toBe('existing-pr'); expect(calls).toEqual(['GET']);
    writeFileSync(join(input.out, 'result.json'), '{"changed":false}'); calls.length = 0;
    expect(await publish({ ...input, request })).toEqual({ changed: false }); expect(calls).toEqual([]);
  });
});

describe('publish re-verifies the candidate written by npm-installed code', () => {
  function base() {
    const root = fixture();
    for (const path of REFRESH_PATHS as string[]) { const parts = path.split('/'); parts.pop(); mkdirSync(join(root, ...parts), { recursive: true }); mkdirSync(join(root, 'files', ...parts), { recursive: true }); }
    writeFileSync(join(root, REFRESH_PATHS[0]!), JSON.stringify(lock));
    writeFileSync(join(root, 'result.json'), JSON.stringify({ changed: true, branch: 'build/bwrap-pins-0123456789abcdef', title: 't', paths: REFRESH_PATHS }));
    writeFileSync(join(root, 'PR-BODY.md'), 'evidence');
    return { root, out: root, repository: 'example/repo', base: 'main', baseSha: 'a'.repeat(40) };
  }
  const never = async () => { throw new Error('no request may be made'); };
  it('refuses a candidate that changes the build image or source (only pins may change)', async () => {
    for (const change of [{ buildImage: { ...lock.buildImage, reference: 'alpine@sha256:' + 'f'.repeat(64) } }, { source: { ...lock.source, sha256: 'f'.repeat(64) } }]) {
      const input = base(), candidateLock = { ...lock, ...change };
      writeFileSync(join(input.out, 'files', REFRESH_PATHS[0]!), JSON.stringify(candidateLock)); writeFileSync(join(input.out, 'files', REFRESH_PATHS[1]!), bundledIdentityModule(candidateLock));
      await expect(publish({ ...input, request: never })).rejects.toThrow(/BWRAP_REFRESH_INVALID/u);
    }
  });
  it('refuses a bundled identity module that does not match the candidate lock', async () => {
    const input = base();
    writeFileSync(join(input.out, 'files', REFRESH_PATHS[0]!), JSON.stringify(lock)); writeFileSync(join(input.out, 'files', REFRESH_PATHS[1]!), 'export const tampered = 1;\n');
    await expect(publish({ ...input, request: never })).rejects.toThrow(/bundled identity/u);
  });
});
