import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const LINT = new URL('../../../scripts/lint-arch.mjs', import.meta.url).pathname;
const ARCH = new URL('../../../arch.json', import.meta.url).pathname;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });

async function fixture(files: Record<string, string>, tiersEnforce = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lint-arch-')); roots.push(root);
  const arch = JSON.parse(await (await import('node:fs/promises')).readFile(ARCH, 'utf8')) as { tiers: { enforce: boolean }; i18n: { catalogDir: string } };
  arch.tiers.enforce = tiersEnforce;
  await writeFile(join(root, 'arch.json'), JSON.stringify(arch));
  await cp(new URL('../../../scripts', import.meta.url).pathname, join(root, 'scripts'), { recursive: true });
  const catalogs = { [`${arch.i18n.catalogDir}/en.json`]: '{}', [`${arch.i18n.catalogDir}/tr.json`]: '{}' };
  for (const [path, content] of Object.entries({ 'README.md': '#', 'ARCHITECTURE.md': '#', 'PLAN.md': '#', 'CHANGELOG.md': '#', ...catalogs, ...files })) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
async function lint(root: string): Promise<{ code: number; out: string }> {
  try { const { stdout } = await run(process.execPath, [LINT, '--root', root]); return { code: 0, out: stdout }; }
  catch (error) { const e = error as { code: number; stdout: string }; return { code: e.code, out: e.stdout }; }
}

describe('lint-arch tier contract', () => {
  it('accepts lower-tier imports through unit indexes and package indexes across tiers', async () => {
    const root = await fixture({
      'src/kernel/core/errors/index.ts': "export const x = 1;\n",
      'src/kernel/base/defaults/index.ts': "import { x } from '../../core/errors/index.js';\nexport const y = x;\n",
      'src/kernel/index.ts': "export { y } from './base/defaults/index.js';\n",
    });
    const result = await lint(root);
    expect(result.out).toContain('tiers=enforced');
    expect(result.code).toBe(0);
  });
  it('rejects a core module importing base, a bypass of a unit index, and a stray file under the package root', async () => {
    const root = await fixture({
      'src/kernel/core/errors/index.ts': "import { y } from '../../base/defaults/internal/impl.js';\nexport const x = y;\n",
      'src/kernel/base/defaults/index.ts': "export { y } from './internal/impl.js';\n",
      'src/kernel/base/defaults/internal/impl.ts': "export const y = 2;\n",
      'src/kernel/stray.ts': "export const s = 0;\n",
      'src/kernel/index.ts': "export { x } from './core/errors/index.js';\n",
    });
    const result = await lint(root);
    expect(result.code).toBe(1);
    expect(result.out).toContain('[tier-direction]');
    expect(result.out).toContain('[unit-api]');
    expect(result.out).toContain('[layout] src/kernel/stray.ts');
  });
  it('leaves layout unchecked while tiers.enforce is false', async () => {
    const root = await fixture({ 'src/kernel/stray.ts': "export const s = 0;\n", 'src/kernel/index.ts': "export { s } from './stray.js';\n" }, false);
    const result = await lint(root);
    expect(result.out).toContain('tiers=off');
    expect(result.code).toBe(0);
  });
});
