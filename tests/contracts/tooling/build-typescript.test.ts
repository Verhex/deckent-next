import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const helper = new URL('../../../scripts/build-typescript.mjs', import.meta.url).href;
// The fixture compiler records argv/cwd or fails; it never compiles or writes dist during a test suite.
async function fixture(exitCode = 0) {
  const root = await mkdtemp(join(tmpdir(), 'deckent compiler & fixture-')); roots.push(root);
  await mkdir(join(root, 'node_modules', 'typescript', 'bin'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"private":true}');
  await writeFile(join(root, 'tsconfig.json'), '{}');
  await writeFile(join(root, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"0.0.0"}');
  await writeFile(join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    `require('node:fs').writeFileSync('invocation.json', JSON.stringify({args:process.argv.slice(2), cwd:process.cwd()})); process.exit(${exitCode});`);
  return root;
}
function invoke(root: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  // No PATH launcher, npm download, shell quoting or global compiler fallback is allowed.
  env.PATH = '';
  const driver = `import {buildTypeScript} from ${JSON.stringify(helper)};
    try { buildTypeScript(process.argv[1]); } catch(e) { console.log(JSON.stringify({code:e.code,status:e.status})); process.exitCode=1; }`;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', driver, root], { env, encoding: 'utf8' });
}
describe('shell-free local TypeScript compiler launch', () => {
  it('uses the installed compiler with literal paths and no PATH executable', async () => {
    const root = await fixture();
    const result = invoke(root);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(root, 'invocation.json'), 'utf8'))).toEqual({
      args: ['-p', 'tsconfig.json'], cwd: root,
    });
  });
  it('propagates compiler failure without accepting a successful build', async () => {
    const root = await fixture(42);
    const result = invoke(root);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).status).toBe(42);
    expect(JSON.parse(await readFile(join(root, 'invocation.json'), 'utf8')).args).toEqual(['-p', 'tsconfig.json']);
  });
  it('fails closed when the checkout compiler is absent', async () => {
    const root = await fixture();
    await rm(join(root, 'node_modules'), { recursive: true });
    const result = invoke(root);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).code).toBe('MODULE_NOT_FOUND');
    await expect(readFile(join(root, 'invocation.json'), 'utf8')).rejects.toThrow();
  });
});
