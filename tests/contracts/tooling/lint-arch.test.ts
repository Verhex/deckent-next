import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const LINT = fileURLToPath(new URL('../../../scripts/lint-arch.mjs', import.meta.url));
const ARCH = fileURLToPath(new URL('../../../arch.json', import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });

async function fixture(files: Record<string, string>, tiersEnforce = true, importsEnforce = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lint-arch-')); roots.push(root);
  const arch = JSON.parse(await (await import('node:fs/promises')).readFile(ARCH, 'utf8')) as { tiers: { enforce: boolean }; imports: { enforce: boolean }; packages: Record<string, unknown>; i18n: { catalogDir: string; families: string[] } };
  arch.tiers.enforce = tiersEnforce;
  arch.imports.enforce = importsEnforce;
  await writeFile(join(root, 'arch.json'), JSON.stringify(arch));
  await cp(fileURLToPath(new URL('../../../scripts', import.meta.url)), join(root, 'scripts'), { recursive: true });
  const packages = Object.keys(arch.packages);
  await writeFile(join(root, 'package.json'), JSON.stringify({ imports: Object.fromEntries(packages.map(p => [`#${p}/*`, `./dist/${p}/*`])) }));
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: Object.fromEntries(packages.map(p => [`#${p}/*`, [`./src/${p}/*`]])) } }));
  const catalogs = Object.fromEntries(arch.i18n.families.flatMap(family => ['en', 'tr'].map(locale => [`${arch.i18n.catalogDir}/locales/${locale}/${family}.json`, '{}'])));
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
      'src/platform/core/errors/index.ts': "export const x = 1;\n",
      'src/platform/base/defaults/index.ts': "import { x } from '../../core/errors/index.js';\nexport const y = x;\n",
      'src/platform/index.ts': "export { y } from './base/defaults/index.js';\n",
    });
    const result = await lint(root);
    expect(result.out).toContain('tiers=enforced');
    expect(result.code).toBe(0);
  });
  it('rejects a core module importing base, a bypass of a unit index, and a stray file under the package root', async () => {
    const root = await fixture({
      'src/platform/core/errors/index.ts': "import { y } from '../../base/defaults/internal/impl.js';\nexport const x = y;\n",
      'src/platform/base/defaults/index.ts': "export { y } from './internal/impl.js';\n",
      'src/platform/base/defaults/internal/impl.ts': "export const y = 2;\n",
      'src/platform/stray.ts': "export const s = 0;\n",
      'src/platform/index.ts': "export { x } from './core/errors/index.js';\n",
    });
    const result = await lint(root);
    expect(result.code).toBe(1);
    expect(result.out).toContain('[tier-direction]');
    expect(result.out).toContain('[unit-api]');
    expect(result.out).toContain('[layout] src/platform/stray.ts');
  });
  it('leaves layout unchecked while tiers.enforce is false', async () => {
    const root = await fixture({ 'src/platform/stray.ts': "export const s = 0;\n", 'src/platform/index.ts': "export { s } from './stray.js';\n" }, false);
    const result = await lint(root);
    expect(result.out).toContain('tiers=off');
    expect(result.code).toBe(0);
  });
  it('rejects provider credential environment literals outside the registry', async () => {
    const allowed = await fixture({
      'src/adapters/core/registry/index.ts': "export { key } from './internal/auth.js';\n",
      'src/adapters/core/registry/internal/auth.ts': "export const key = 'ANTHROPIC_API_KEY';\n",
    });
    expect((await lint(allowed)).code).toBe(0);
    const rejected = await fixture({ 'src/platform/core/config/index.ts': "export const key = 'ANTHROPIC_API_KEY';\n" });
    expect((await lint(rejected)).out).toContain('[literal]');
  });

  it('rejects duplicate JSON keys, cross-family duplicates and placeholder drift', async () => {
    const cases = [
      { 'src/platform/core/i18n/locales/en/cli.json': '{"x":"One","x":"Two"}', 'src/platform/core/i18n/locales/tr/cli.json': '{"x":"Bir"}' },
      { 'src/platform/core/i18n/locales/en/cli.json': '{"x":"One"}', 'src/platform/core/i18n/locales/en/tui.json': '{"x":"Two"}' },
      { 'src/platform/core/i18n/locales/en/cli.json': '{"x":"Name {name}"}', 'src/platform/core/i18n/locales/tr/cli.json': '{"x":"Ad {other}"}' },
    ];
    for (const [i, files] of cases.entries()) {
      const result = await lint(await fixture(files));
      expect(result.code).toBe(1);
      expect(result.out).toContain(i === 2 ? '[i18n-placeholder]' : '[i18n-duplicate]');
    }
  });
  it('rejects concatenated translation keys outside the registry', async () => {
    const result = await lint(await fixture({ 'src/platform/core/example/index.ts': "export const label = t('prefix.' + suffix);\n" }));
    expect(result.out).toContain('[i18n-dynamic]');
  });

  it('enforces native aliases and rejects missing targets, private imports and mapping drift', async () => {
    const files = {
      'src/platform/core/common/index.ts': "export const x = 1;\n",
      'src/platform/core/example/index.ts': "import { x } from '#platform/core/common/index.js'; export const y = x;\n",
    };
    const root = await fixture(files, true, true);
    expect((await lint(root)).code).toBe(0);
    await writeFile(join(root, 'src/platform/core/example/index.ts'), "import { x } from '../common/index.js'; export const y = x;");
    expect((await lint(root)).out).toContain('[import-style]');
    await writeFile(join(root, 'src/platform/core/example/index.ts'), "import { x } from '#platform/core/common/internal/missing.js'; export const y = x;");
    const bad = await lint(root);
    expect(bad.out).toContain('[import-target]'); expect(bad.out).toContain('[unit-api]');
    await writeFile(join(root, 'src/platform/core/example/index.ts'), files['src/platform/core/example/index.ts']);
    await writeFile(join(root, 'package.json'), '{"imports":{}}');
    expect((await lint(root)).out).toContain('[import-map]');
  });

  it('enforces the shared file cap for native and application sources without an extra EOF line', async () => {
    const root = await fixture({
      'native/supervisor/main.go': '// line\n'.repeat(1500),
      'native/authority/main.c': '// line\n'.repeat(1500),
      'apps/desktop/view.js': '// line\n'.repeat(1500),
    });
    expect((await lint(root)).code).toBe(0);
    for (const file of ['native/supervisor/main.go', 'native/authority/main.c', 'apps/desktop/view.js']) {
      await writeFile(join(root, file), '// line\n'.repeat(1501));
      expect((await lint(root)).out).toContain(`[file-size] ${file}`);
      await writeFile(join(root, file), '// line\n'.repeat(1500));
    }
  });

  it('blocks adapter ownership in surfaces and host dependencies in the pure domain', async () => {
    const surface = await fixture({
      'src/adapters/index.ts': 'export const adapter = 1;',
      'src/surfaces/core/example/index.ts': "import { adapter } from '#adapters/index.js'; export const value = adapter;",
    });
    expect((await lint(surface)).out).toContain('[direction]');
    const domain = await fixture({ 'src/domain/core/task/index.ts': "import fs from 'node:fs'; export const value = process.pid;" });
    expect((await lint(domain)).out).toContain('[domain-purity]');
  });

});
