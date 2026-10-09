import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error build tools are executable JavaScript, outside src's TypeScript contract.
import { stageBubblewrap } from '../../../scripts/stage-bubblewrap.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function fixture() {
  const root = mkdtempSync('/tmp/dk-bwrap-build-'); roots.push(root);
  mkdirSync(join(root, 'packaging/bwrap'), { recursive: true });
  writeFileSync(join(root, 'packaging/bwrap/bwrap.lock.json'), readFileSync(resolve('packaging/bwrap/bwrap.lock.json')));
  return root;
}
it('a fresh Linux source build invokes the existing locked recipe and fails clearly if staging cannot run', () => {
  const root = fixture(), calls: { binary: string; args: string[] }[] = [];
  expect(() => stageBubblewrap({ root, platform: 'linux', buildOutput: null, run(binary: string, args: string[]) {
    calls.push({ binary, args }); throw new Error('Docker unavailable');
  } })).toThrow(/BUBBLEWRAP_BUILD_REQUIRED.*locked bubblewrap.*Start Docker/u);
  expect(calls).toEqual([{ binary: process.execPath, args: [join(root, 'scripts/build-bwrap.mjs'), '--out', join(root, '.pack/bwrap/source-build')] }]);
  expect(existsSync(join(root, 'dist/adapters/core/shell-sandbox-bwrap/bundled'))).toBe(false);
});
it('an invalid staged binary is refused rather than reported as a successful ABSENT build', () => {
  const root = fixture(); const bundled = join(root, 'src/adapters/core/shell-sandbox-bwrap/bundled');
  mkdirSync(join(bundled, 'linux-x64'), { recursive: true }); writeFileSync(join(bundled, 'linux-x64/bwrap'), 'wrong-digest');
  let called = false;
  expect(() => stageBubblewrap({ root, platform: 'linux', buildOutput: null, run() { called = true; } })).toThrow(/not the locked bubblewrap build/u);
  expect(called).toBe(false); expect(existsSync(join(root, 'dist/adapters/core/shell-sandbox-bwrap/bundled'))).toBe(false);
});
