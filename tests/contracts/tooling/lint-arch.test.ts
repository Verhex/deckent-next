import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const LINT = fileURLToPath(new URL('../../../scripts/lint-arch.mjs', import.meta.url));
const ARCH = fileURLToPath(new URL('../../../arch.json', import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });

type FixtureDependencies = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; registry?: unknown };
const emptyRegistry = { schemaVersion: 2, policy: { reviewIntervalDays: { P0: 30, P1: 60, P2: 90 }, licenses: { runtime: ['MIT'], dev: ['MIT'] }, failSeverities: ['HIGH', 'CRITICAL'] }, dependencies: {}, platform: {}, acceptedRisks: [] as unknown[] };
async function fixture(files: Record<string, string>, tiersEnforce = true, importsEnforce = false, deps: FixtureDependencies = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lint-arch-')); roots.push(root);
  const arch = JSON.parse(await (await import('node:fs/promises')).readFile(ARCH, 'utf8')) as { tiers: { enforce: boolean }; imports: { enforce: boolean }; units: Record<string, { dependencies: string[]; plan: string }>; packages: Record<string, unknown>; i18n: { catalogDir: string; families: string[] } };
  arch.tiers.enforce = tiersEnforce;
  arch.imports.enforce = importsEnforce;
  await cp(fileURLToPath(new URL('../../../scripts', import.meta.url)), join(root, 'scripts'), { recursive: true });
  const packages = Object.keys(arch.packages);
  await writeFile(join(root, 'package.json'), JSON.stringify({ imports: Object.fromEntries(packages.map(p => [`#${p}/*`, `./dist/${p}/*`])),
    dependencies: deps.dependencies ?? {}, devDependencies: deps.devDependencies ?? {} }));
  if (deps.registry !== null) await writeFile(join(root, 'dependencies.json'), JSON.stringify(deps.registry ?? emptyRegistry));
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: Object.fromEntries(packages.map(p => [`#${p}/*`, [`./src/${p}/*`]])) } }));
  const catalogs = Object.fromEntries(arch.i18n.families.flatMap(family => ['en', 'tr'].map(locale => [`${arch.i18n.catalogDir}/locales/${locale}/${family}.json`, '{}'])));
  const fixtureFiles = { 'README.md': '#', 'ARCHITECTURE.md': '#', 'PLAN.md': '| ID | Scope |\n|---|---|\n| FOUNDATION | fixture |', 'COMPLETED-PLAN.md': '#', 'CHANGELOG.md': '#', ...catalogs, ...files };
  const sourceFiles = Object.keys(fixtureFiles).filter(path => /\.tsx?$/.test(path));
  const unit = (path: string) => { const parts = path.split('/'); return parts[0] === 'src' && parts.length >= 5 ? parts.slice(0, 4).join('/') : null; };
  const dependency = (path: string) => { const parts = path.split('/'); return parts[0] !== 'src' ? null : parts.length >= 5 ? parts.slice(0, 4).join('/') : parts.length === 3 ? `src/${parts[1]}` : null; };
  arch.units = Object.fromEntries([...new Set(sourceFiles.map(unit).filter((value): value is string => value !== null))].sort().map(id => [id, { dependencies: [], plan: 'FOUNDATION' }]));
  const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const path of sourceFiles) {
    const from = unit(path); if (!from) continue;
    const dependencies = new Set<string>();
    for (const match of fixtureFiles[path]!.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2]!;
      const target = specifier.startsWith('#') ? `src/${specifier.slice(1).replace(/\.js$/, '.ts')}`
        : specifier.startsWith('.') ? posix.normalize(posix.join(dirname(path), specifier.replace(/\.js$/, '.ts'))) : null;
      const targetDependency = target ? dependency(target) : null;
      if (targetDependency && targetDependency !== from) dependencies.add(targetDependency);
    }
    arch.units[from]!.dependencies = [...dependencies].sort();
  }
  await writeFile(join(root, 'arch.json'), JSON.stringify(arch));
  for (const [path, content] of Object.entries(fixtureFiles)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
async function lint(root: string, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; out: string }> {
  try { const { stdout } = await run(process.execPath, [LINT, '--root', root], { timeout: 20_000, killSignal: 'SIGKILL', env }); return { code: 0, out: stdout }; }
  catch (error) {
    const e = error as { code?: number | string | null; signal?: string | null; killed?: boolean;
      stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    if (typeof e.code === 'number') return { code: e.code, out: String(e.stdout ?? '') };
    const bounded = (value: unknown) => String(value ?? '').slice(0, 4096);
    throw new Error(`lint-arch subprocess failed: ${JSON.stringify({ code: e.code ?? null, signal: e.signal ?? null,
      killed: e.killed ?? false, stdout: bounded(e.stdout), stderr: bounded(e.stderr), error: bounded(e.message) })}`, { cause: error });
  }
}

describe('lint-arch tier contract', () => {
  it('rejects side-by-side current version modules and V2 APIs, while allowing migration history', async () => {
    const rejected = await fixture({
      'src/engine/core/dispatch/internal/version-two.ts': 'export const dispatchRecordV2Schema = {} as const;\n',
      'src/engine/core/dispatch/internal/version-three.ts': 'export const TaskGraphV3 = {} as const;\n// export const CommentV4Schema = {};\nexport const ProviderV2Client = {} as const;\n',
      'src/engine/core/dispatch/index.ts': "export {\n  dispatchRecordV2Schema,\n  TaskGraphV3,\n  ProviderV2Client,\n} from './internal/version-two.js';\n",
    });
    const rejectedResult = await lint(rejected);
    expect(rejectedResult.code).toBe(1);
    expect(rejectedResult.out).toContain('[versioning] src/engine/core/dispatch/internal/version-two.ts');
    expect(rejectedResult.out).toContain('parallel versioned contract API');
    expect(rejectedResult.out).not.toContain('ProviderV2Client');
    expect(rejectedResult.out).not.toContain('CommentV4Schema');

    const history = await fixture({
      'src/adapters/core/attempt-store/index.ts': 'export {};\n',
      'src/adapters/core/attempt-store/migration-v5.ts': 'export const dispatchRecordV2Schema = {} as const;\n',
      'src/adapters/core/attempt-store/migrations/version-two.ts': 'export const dispatchRecordV2Schema = {} as const;\n',
      'src/adapters/core/attempt-store/migrations/index.ts': "export { dispatchRecordV2Schema } from './version-two.js';\n",
      'src/adapters/core/sqlite-ledger/index.ts': 'export {};\n',
      'src/adapters/core/sqlite-ledger/internal/migration-v5.ts': 'export const dispatchRecordV2Schema = {} as const;\n',
    });
    const historyResult = await lint(history);
    expect(historyResult.code).toBe(0);

    const misplaced = await fixture({
      'src/engine/core/dispatch/index.ts': 'export {};\n',
      'src/engine/core/dispatch/migration-v5.ts': 'export const dispatchRecordV2Schema = {} as const;\n',
      'src/adapters/core/sqlite-ledger/index.ts': 'export {};\n',
      'src/adapters/core/sqlite-ledger/internal/version-two.ts': 'export const dispatchRecordV2Schema = {} as const;\n',
    });
    const misplacedResult = await lint(misplaced);
    expect(misplacedResult.code).toBe(1);
    expect(misplacedResult.out).toContain('migration-v5.ts');
    expect(misplacedResult.out).toContain('[versioning] src/adapters/core/sqlite-ledger/internal/version-two.ts');
  });

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
  it('rejects provider credential environment literals including the former registry exception', async () => {
    const formerRegistry = await fixture({
      'src/adapters/core/registry/index.ts': "export { key } from './internal/auth.js';\n",
      'src/adapters/core/registry/internal/auth.ts': "export const key = 'ANTHROPIC_API_KEY';\n",
    });
    const registryResult = await lint(formerRegistry);
    expect(registryResult.code).toBe(1);
    expect(registryResult.out).toContain('[literal]');
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

describe('lint-arch unit contract', () => {
  it('rejects dependency cycles from the observed graph', async () => {
    const root = await fixture({
      'src/platform/core/a/index.ts': "import { b } from '#platform/core/b/index.js'; export const a = b;",
      'src/platform/core/b/index.ts': "import { a } from '#platform/core/a/index.js'; export const b = a;",
    }, true, true);
    expect((await lint(root)).out).toContain('[unit-cycle]');
  });

  it('requires exact dependencies and a real PLAN row', async () => {
    const root = await fixture({
      'src/platform/core/a/index.ts': "import { b } from '#platform/core/b/index.js'; export const a = b;",
      'src/platform/core/b/index.ts': 'export const b = 1;',
    }, true, true);
    const arch = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'arch.json'), 'utf8')) as { units: Record<string, { dependencies: string[]; plan: string }> };
    arch.units['src/platform/core/a']!.dependencies = [];
    arch.units['src/platform/core/a']!.plan = 'MISSING-CARD';
    await writeFile(join(root, 'arch.json'), JSON.stringify(arch));
    const undeclared = await lint(root);
    expect(undeclared.out).toContain('[unit-dependency]');
    expect(undeclared.out).toContain('[unit-plan]');
  });

  it('rejects a source unit missing from the declaration graph', async () => {
    const root = await fixture({ 'src/platform/core/a/index.ts': 'export const a = 1;' });
    const arch = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'arch.json'), 'utf8')) as { units: Record<string, { dependencies: string[]; plan: string }> };
    delete arch.units['src/platform/core/a'];
    await writeFile(join(root, 'arch.json'), JSON.stringify(arch));
    expect((await lint(root)).out).toContain('[unit-declaration]');
  });

  it('resolves package-barrel symbol origins before checking unit cycles', async () => {
    const root = await fixture({
      'src/platform/index.ts': "export { a } from './core/a/index.js';",
      'src/platform/core/a/index.ts': "import { b } from '#platform/core/b/index.js'; export const a = b;",
      'src/platform/core/b/index.ts': "import { a } from '#platform/index.js'; export const b = a;",
    }, true, true);
    const result = await lint(root);
    expect(result.out).toContain('[unit-cycle]');
    expect(result.out).toContain('src/platform/core/a → src/platform/core/b → src/platform/core/a');
  });

  it('rejects named, namespace, default and callable-alias domain decisions while allowing schemas and types', async () => {
    const root = await fixture({
      'src/domain/index.ts': "export { default, decide, decideAlias, schema } from './core/decision/index.js'; export type { Input } from './core/decision/index.js';",
      'src/domain/core/decision/index.ts': "export interface Input { id: string } export const schema = {}; export function decide(_: Input) { return true; } export const decideAlias = decide; export default function decideDefault(_: Input) { return true; }",
      'src/composition/core/app/index.ts': "import decideDefault, { decide, decideAlias, schema, type Input } from '#domain/index.js'; import * as domain from '#domain/index.js'; export const run = (input: Input) => decide(input) && decideAlias(input) && decideDefault(input) && domain.decide(input) && !!schema;",
    }, true, true);
    const result = await lint(root);
    expect(result.out).toContain('[composition-purity]');
    expect(result.out).toContain('domain decision function decide');
    expect(result.out).toContain('domain decision function decideAlias');
    expect(result.out).toContain('domain decision function decideDefault');
    expect(result.out).not.toContain('domain decision function schema');
  });

  it('enforces canonical vocabulary and the aggregate 2,000-line unit budget', async () => {
    const root = await fixture({
      'src/platform/core/large/index.ts': 'export {};\n',
      'src/platform/core/large/internal/a.ts': '// line\n'.repeat(1001),
      'src/platform/core/large/internal/b.ts': '// line\n'.repeat(1001),
      'tests/legacy.test.ts': `test('legacy', () => {}); // ${['Sp', 'rint'].join('')}\n`,
    });
    const result = await lint(root);
    expect(result.out).toContain('[unit-budget]');
    expect(result.out).toContain('[vocabulary]');
  });

});

describe('lint-arch external dependency contract', () => {
  const review = { lastReview: '2026-09-29', nextReview: '2026-10-29' };
  const entry = (kind: 'runtime' | 'dev', owners: string[], extra: Record<string, unknown> = {}) => ({ kind, owners, purpose: 'fixture', features: ['fixture'],
    criticality: 'P0', reviewedVersion: '1.0.0', alternatives: [], ownSolution: 'none', ...review, ...extra });
  const registry = (dependencies: Record<string, unknown>, platform: Record<string, unknown> = {}, acceptedRisks: unknown[] = []) => ({ ...emptyRegistry, dependencies, platform, acceptedRisks });
  const owned = { dependencies: { 'acme-lib': '1.0.0', 'shared-lib': '1.0.0' }, devDependencies: { 'dev-lib': '1.0.0' },
    registry: registry({ 'acme-lib': entry('runtime', ['src/adapters/core/acme']), 'shared-lib': entry('runtime', ['src/domain', 'src/engine']),
      'dev-lib': entry('dev', ['package.json']) }) };

  it('accepts owned static, subpath, dynamic and type-position imports, node: built-ins and a domain-owned pure package', async () => {
    const root = await fixture({
      'src/adapters/core/acme/index.ts': "import { a } from 'acme-lib'; import 'acme-lib/sub'; import { readFileSync } from 'node:fs';\n"
        + "export const load = () => import('acme-lib'); export type Lib = typeof import('acme-lib/types'); export const v = [a, readFileSync];\n",
      'src/domain/core/task/index.ts': "import { z } from 'shared-lib'; export const schema = z;\n",
      'src/engine/core/run/index.ts': "export { z } from 'shared-lib';\n",
    }, true, false, owned);
    const result = await lint(root);
    expect(result.out).not.toMatch(/\[(?:external-[a-z]+|domain-purity|dependency-registry)\]/);
    expect(result.code).toBe(0);
  });

  it('rejects unowned, undeclared, dev-only, unprefixed built-in, non-literal and stale-owner imports', async () => {
    const root = await fixture({
      'src/adapters/core/acme/index.ts': 'export const idle = 1;\n',
      'src/surfaces/core/view/index.ts': "import { a } from 'acme-lib'; import { g } from 'ghost-lib'; import { d } from 'dev-lib'; import fs from 'fs';\n"
        + "import { createRequire } from 'node:module'; const name = 'acme-lib'; export const late = () => import(name);\n"
        + "export const req = createRequire(import.meta.url)('@scope/hidden/deep'); export type T = typeof import('acme-lib'); export const v = [a, g, d, fs];\n",
      'src/domain/core/task/index.ts': "export const idle = 1;\n",
      'src/engine/core/run/index.ts': "import { z } from 'shared-lib'; export const v = z;\n",
    }, true, false, owned);
    const result = await lint(root);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/\[external-owner\] src\/surfaces\/core\/view\/index\.ts:1 — acme-lib may only be imported by \[src\/adapters\/core\/acme\]/);
    expect(result.out).toMatch(/\[external-owner\] src\/surfaces\/core\/view\/index\.ts:3 — acme-lib/);
    expect(result.out).toMatch(/\[external-undeclared\] src\/surfaces\/core\/view\/index\.ts:1 — ghost-lib/);
    expect(result.out).toMatch(/\[external-undeclared\] src\/surfaces\/core\/view\/index\.ts:3 — @scope\/hidden/);
    expect(result.out).toMatch(/\[external-dev-only\] src\/surfaces\/core\/view\/index\.ts:1 — dev-lib/);
    expect(result.out).toMatch(/\[external-builtin\] src\/surfaces\/core\/view\/index\.ts:1 — fs/);
    expect(result.out).toMatch(/\[external-dynamic\] src\/surfaces\/core\/view\/index\.ts:2/);
    expect(result.out).toMatch(/\[external-stale-owner\] dependencies\.json — acme-lib owner src\/adapters\/core\/acme/);
    expect(result.out).toMatch(/\[external-stale-owner\] dependencies\.json — shared-lib owner src\/domain/);
  });

  it('keeps the pure domain closed to packages the registry does not assign to it', async () => {
    const root = await fixture({ 'src/domain/core/task/index.ts': "import { a } from 'acme-lib'; export const v = a;\n",
      'src/adapters/core/acme/index.ts': "import { a } from 'acme-lib'; export const v = a;\n" }, true, false, owned);
    const out = (await lint(root)).out;
    expect(out).toContain('[domain-purity] src/domain/core/task/index.ts — external dependency acme-lib');
  });

  it('fails closed on a missing or invalid registry and on drift from package.json', async () => {
    const missing = await lint(await fixture({}, true, false, { registry: null }));
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('[dependency-registry] dependencies.json');
    const drift = await lint(await fixture({ 'src/adapters/core/acme/index.ts': "import { a } from 'acme-lib'; export const v = a;\n" }, true, false, {
      dependencies: { 'acme-lib': '1.0.0', 'extra-lib': '1.0.0' }, devDependencies: { 'dev-lib': '1.0.0' },
      registry: registry({ 'acme-lib': entry('runtime', ['src/adapters/core/acme']), 'dev-lib': entry('runtime', ['src/nowhere/core/x']),
        'gone-lib': entry('dev', ['no/such/path'], { lastReview: '2026-10-01', nextReview: '2026-09-30' }),
        'late-lib': entry('dev', ['package.json'], { criticality: 'P0', nextReview: '2027-01-01' }),
        'bad-lib': { kind: 'runtime', owners: [] } }),
    }));
    expect(drift.code).toBe(1);
    expect(drift.out).toContain('[dependency-registry] package.json — extra-lib is declared in package.json but missing from dependencies.json');
    expect(drift.out).toContain('[dependency-registry] dependencies.json — dev-lib is kind "runtime" but package.json declares it in devDependencies');
    expect(drift.out).toContain('[dependency-registry] dependencies.json — dev-lib owner src/nowhere/core/x is not an arch.json unit or package');
    expect(drift.out).toContain('[dependency-registry] dependencies.json — gone-lib owner no/such/path does not exist');
    expect(drift.out).toContain('[dependency-registry] dependencies.json — gone-lib nextReview 2026-09-30 is not after lastReview 2026-10-01');
    expect(drift.out).toContain('[dependency-registry] dependencies.json — late-lib review interval 94 days exceeds the P0 limit of 30');
    expect(drift.out).toMatch(/\[dependency-registry\] dependencies\.json — dependencies\.bad-lib/);
  });

  it('warns without failing when a review date has passed', async () => {
    const root = await fixture({ 'src/adapters/core/acme/index.ts': "import { a } from 'acme-lib'; export const v = a;\n" }, true, false, {
      dependencies: { 'acme-lib': '1.0.0' }, registry: registry({ 'acme-lib': entry('runtime', ['src/adapters/core/acme']) },
        { bwrap: { requirement: '>=0.13', owners: ['src/adapters/core/acme'], purpose: 'p', criticality: 'P1', alternatives: [], ownSolution: 'none', ...review } }) });
    const due = await lint(root, { ...process.env, DECKENT_DEPS_TODAY: '2026-12-01' });
    expect(due.code).toBe(0);
    expect(due.out).toContain('⚠ [dependency-review] dependencies.json — acme-lib review is overdue (nextReview 2026-10-29)');
    expect(due.out).toContain('⚠ [dependency-review] dependencies.json — platform bwrap review is overdue (nextReview 2026-10-29)');
    const fresh = await lint(root, { ...process.env, DECKENT_DEPS_TODAY: '2026-10-01' });
    expect(fresh.out).not.toContain('[dependency-review]');
  });

  it('requires the declared embedded components to match the installed sourcemaps', async () => {
    const files = { 'src/adapters/core/acme/index.ts': "import { a } from 'acme-lib'; export const v = a;\n",
      'node_modules/acme-lib/package.json': JSON.stringify({ name: 'acme-lib', version: '1.0.0' }),
      'node_modules/acme-lib/dist/index.js.map': JSON.stringify({ sources: ['../../../node_modules/.pnpm/fast-uri@3.1.0/node_modules/fast-uri/index.js'] }) };
    const undeclared = await lint(await fixture(files, true, false, { dependencies: { 'acme-lib': '1.0.0' },
      registry: registry({ 'acme-lib': entry('runtime', ['src/adapters/core/acme']) }) }));
    expect(undeclared.code).toBe(1);
    expect(undeclared.out).toContain('[external-embedded] dependencies.json — acme-lib embeds undeclared fast-uri@3.1.0');
    const declared = await lint(await fixture(files, true, false, { dependencies: { 'acme-lib': '1.0.0' },
      registry: registry({ 'acme-lib': entry('runtime', ['src/adapters/core/acme'], { embedded: [{ name: 'fast-uri', version: '3.1.0' }, { name: 'ajv', version: '8.18.0' }] }) }) }));
    expect(declared.out).toContain('[external-embedded] dependencies.json — acme-lib declares ajv@8.18.0 but the installed sourcemaps no longer embed it');
    expect(declared.out).not.toContain('undeclared fast-uri');
  });

  it('validates accepted risks: evidence required, 30-day HIGH window, embedding carrier, expiry warning', async () => {
    const risk = (extra: Record<string, unknown>) => ({ id: 'r', package: 'fast-uri', version: '3.1.0', carriers: ['acme-lib@1.0.0'], advisories: ['GHSA-a'],
      severity: 'HIGH', mitigation: 'm', evidence: ['proof/X/review.md'], decidedBy: 'lead', decided: '2026-09-29', expires: '2026-10-29', ...extra });
    const files = { 'src/adapters/core/acme/index.ts': "import { a } from 'acme-lib'; export const v = a;\n" };
    const acme = entry('runtime', ['src/adapters/core/acme'], { embedded: [{ name: 'fast-uri', version: '3.1.0' }] });
    const ok = await fixture(files, true, false, { dependencies: { 'acme-lib': '1.0.0' }, registry: registry({ 'acme-lib': acme }, {}, [risk({})]) });
    const valid = await lint(ok, { ...process.env, DECKENT_DEPS_TODAY: '2026-10-01' });
    expect(valid.code).toBe(0);
    expect(valid.out).not.toContain('accepted');
    const expired = await lint(ok, { ...process.env, DECKENT_DEPS_TODAY: '2026-10-30' });
    expect(expired.code).toBe(0);
    expect(expired.out).toContain('⚠ [accepted-risk] dependencies.json — accepted risk r expired 2026-10-29; deps-watch fails on its advisories again');
    const bad = await lint(await fixture(files, true, false, { dependencies: { 'acme-lib': '1.0.0' }, registry: registry({ 'acme-lib': acme }, {}, [
      risk({ id: 'no-evidence', evidence: [] }), risk({ id: 'long', expires: '2026-10-30' }), risk({ id: 'foreign', carriers: ['other@1.0.0', 'acme-lib@1.0.0'], version: '3.0.0' })]) }));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('[dependency-registry] dependencies.json — acceptedRisks.0.evidence: an accepted risk needs at least one evidence reference');
    expect(bad.out).toContain('[dependency-registry] dependencies.json — accepted risk long window 31 days exceeds 30 for HIGH');
    expect(bad.out).toContain('accepted risk foreign carrier other@1.0.0 is neither "tree" nor a runtime dependency that embeds fast-uri@3.0.0');
    expect(bad.out).toContain('accepted risk foreign carrier acme-lib@1.0.0 is neither');
  });
});
