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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fixture patches an arbitrary slice of arch.json per test
type ArchPatch = (arch: any) => void;
async function fixture(files: Record<string, string>, tiersEnforce = true, importsEnforce = false, deps: FixtureDependencies = {}, patch?: ArchPatch): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lint-arch-')); roots.push(root);
  const arch = JSON.parse(await (await import('node:fs/promises')).readFile(ARCH, 'utf8')) as { hardcodeRatchet: { frozen: string[]; allowlist: string }; tiers: { enforce: boolean }; imports: { enforce: boolean }; markdown: { trackedAllow: string[] }; units: Record<string, { dependencies: string[]; plan: string }>; packages: Record<string, unknown>; i18n: { catalogDir: string; families: string[] } };
  arch.tiers.enforce = tiersEnforce;
  arch.imports.enforce = importsEnforce;
  await cp(fileURLToPath(new URL('../../../scripts', import.meta.url)), join(root, 'scripts'), { recursive: true });
  arch.hardcodeRatchet.frozen = [];
  await writeFile(join(root, arch.hardcodeRatchet.allowlist), '[]');
  const packages = Object.keys(arch.packages);
  await writeFile(join(root, 'package.json'), JSON.stringify({ imports: Object.fromEntries(packages.map(p => [`#${p}/*`, `./dist/${p}/*`])),
    dependencies: deps.dependencies ?? {}, devDependencies: deps.devDependencies ?? {} }));
  if (deps.registry !== null) await writeFile(join(root, 'dependencies.json'), JSON.stringify(deps.registry ?? emptyRegistry));
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: Object.fromEntries(packages.map(p => [`#${p}/*`, [`./src/${p}/*`]])) } }));
  const catalogs = Object.fromEntries(arch.i18n.families.flatMap(family => ['en', 'tr'].map(locale => [`${arch.i18n.catalogDir}/locales/${locale}/${family}.json`, '{}'])));
  const requiredDocuments = Object.fromEntries(arch.markdown.trackedAllow.map(path => [path, '#']));
  const fixtureFiles = { ...requiredDocuments, 'README.md': '#', 'ARCHITECTURE.md': '#', 'PLAN.md': '| ID | Scope |\n|---|---|\n| FOUNDATION | fixture |', 'COMPLETED-PLAN.md': '#', 'CHANGELOG.md': '#', ...catalogs, ...files };
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
  // Shrink-only repository debt (allowlists, caps, frozen lists) describes the real tree, not a fixture: start every fixture from zero.
  const guards = (arch as unknown as { guards: { hostWords: { allow: unknown[] }; vendorSlugCaps: Record<string, number>; effectFlows: { frozen: string[] } } }).guards;
  guards.hostWords.allow = []; guards.vendorSlugCaps = {}; guards.effectFlows.frozen = [];
  (arch as unknown as { literals: { allowUnits: unknown[] } }).literals.allowUnits = [];
  patch?.(arch);
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
    expect(rejectedResult.code, rejectedResult.out).toBe(1);
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
    expect(historyResult.code, historyResult.out).toBe(0);

    const misplaced = await fixture({
      'src/engine/core/dispatch/index.ts': 'export {};\n',
      'src/engine/core/dispatch/migration-v5.ts': 'export const dispatchRecordV2Schema = {} as const;\n',
      'src/adapters/core/sqlite-ledger/index.ts': 'export {};\n',
      'src/adapters/core/sqlite-ledger/internal/version-two.ts': 'export const dispatchRecordV2Schema = {} as const;\n',
    });
    const misplacedResult = await lint(misplaced);
    expect(misplacedResult.code, misplacedResult.out).toBe(1);
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
    expect(result.code, result.out).toBe(0);
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
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('[tier-direction]');
    expect(result.out).toContain('[unit-api]');
    expect(result.out).toContain('[layout] src/platform/stray.ts');
  });
  it('leaves layout unchecked while tiers.enforce is false', async () => {
    const root = await fixture({ 'src/platform/stray.ts': "export const s = 0;\n", 'src/platform/index.ts': "export { s } from './stray.js';\n" }, false);
    const result = await lint(root);
    expect(result.out).toContain('tiers=off');
    expect(result.code, result.out).toBe(0);
  });
  it('rejects provider credential environment literals including the former registry exception', async () => {
    const formerRegistry = await fixture({
      'src/adapters/core/registry/index.ts': "export { key } from './internal/auth.js';\n",
      'src/adapters/core/registry/internal/auth.ts': "export const key = 'ANTHROPIC_API_KEY';\n",
    });
    const registryResult = await lint(formerRegistry);
    expect(registryResult.code, registryResult.out).toBe(1);
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
      expect(result.code, result.out).toBe(1);
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
    expect(result.code, result.out).toBe(0);
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
    expect(result.code, result.out).toBe(1);
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
    expect(missing.code, missing.out).toBe(1);
    expect(missing.out).toContain('[dependency-registry] dependencies.json');
    const drift = await lint(await fixture({ 'src/adapters/core/acme/index.ts': "import { a } from 'acme-lib'; export const v = a;\n" }, true, false, {
      dependencies: { 'acme-lib': '1.0.0', 'extra-lib': '1.0.0' }, devDependencies: { 'dev-lib': '1.0.0' },
      registry: registry({ 'acme-lib': entry('runtime', ['src/adapters/core/acme']), 'dev-lib': entry('runtime', ['src/nowhere/core/x']),
        'gone-lib': entry('dev', ['no/such/path'], { lastReview: '2026-10-01', nextReview: '2026-09-30' }),
        'late-lib': entry('dev', ['package.json'], { criticality: 'P0', nextReview: '2027-01-01' }),
        'bad-lib': { kind: 'runtime', owners: [] } }),
    }));
    expect(drift.code, drift.out).toBe(1);
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
    expect(due.code, due.out).toBe(0);
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
    expect(undeclared.code, undeclared.out).toBe(1);
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
    expect(valid.code, valid.out).toBe(0);
    expect(valid.out).not.toContain('accepted');
    const expired = await lint(ok, { ...process.env, DECKENT_DEPS_TODAY: '2026-10-30' });
    expect(expired.code, expired.out).toBe(0);
    expect(expired.out).toContain('⚠ [accepted-risk] dependencies.json — accepted risk r expired 2026-10-29; deps-watch fails on its advisories again');
    const bad = await lint(await fixture(files, true, false, { dependencies: { 'acme-lib': '1.0.0' }, registry: registry({ 'acme-lib': acme }, {}, [
      risk({ id: 'no-evidence', evidence: [] }), risk({ id: 'long', expires: '2026-10-30' }), risk({ id: 'foreign', carriers: ['other@1.0.0', 'acme-lib@1.0.0'], version: '3.0.0' })]) }));
    expect(bad.code, bad.out).toBe(1);
    expect(bad.out).toContain('[dependency-registry] dependencies.json — acceptedRisks.0.evidence: an accepted risk needs at least one evidence reference');
    expect(bad.out).toContain('[dependency-registry] dependencies.json — accepted risk long window 31 days exceeds 30 for HIGH');
    expect(bad.out).toContain('accepted risk foreign carrier other@1.0.0 is neither "tree" nor a runtime dependency that embeds fast-uri@3.0.0');
    expect(bad.out).toContain('accepted risk foreign carrier acme-lib@1.0.0 is neither');
  });
});

describe('ARCH-GUARDS: layer-drift guards (each rule has a deliberate violation that must stay red)', () => {
  const unit = (layer: string, tier: string, name: string, file: string, body: string) => ({
    [`src/${layer}/${tier}/${name}/index.ts`]: `export * from './internal/${file}.js';\n`, [`src/${layer}/${tier}/${name}/internal/${file}.ts`]: body });
  const clean = unit('engine', 'core', 'a', 'x', 'export const x = 1;\n');

  it('G-b: product source may import outside src only from assets/', async () => {
    const files = (specifier: string) => ({ ...clean, 'assets/y.json': '{}', 'scripts/s.mjs': '', 'tests/t.ts': '', '.agents/refactor/h.mjs': '',
      'src/engine/core/a/internal/x.ts': `import data from '${specifier}' with { type: 'json' };\nexport const x = data;\n` });
    const up = '../../../../../';
    const green = await lint(await fixture(files(`${up}assets/y.json`)));
    expect(green.out).not.toContain('[src-boundary]');
    for (const [target, text] of [['scripts/s.mjs', 'may not import scripts/'], ['tests/t.ts', 'may not import tests/'], ['.agents/refactor/h.mjs', 'may not import .agents/'],
      ['other/z.json', 'relative import leaves src/']] as const) {
      const red = await lint(await fixture(files(`${up}${target}`)));
      expect(red.code, red.out).toBe(1);
      expect(red.out, target).toContain(`[src-boundary] src/engine/core/a/internal/x.ts:1 — `);
      expect(red.out, target).toContain(text);
    }
  });

  it('G-c: product tests may not import .agents host tooling', async () => {
    const red = await lint(await fixture({ ...clean, '.agents/refactor/h.mjs': 'export const h = 1;\n',
      'tests/contracts/tooling/host.test.ts': ['import { h } from ', "'../../../.agents/refactor/h.mjs';\nexport const v = h;\n"].join('') }));
    expect(red.code, red.out).toBe(1);
    expect(red.out).toContain('[test-host-import] tests/contracts/tooling/host.test.ts:1 — product tests may not import .agents/');
    const green = await lint(await fixture({ ...clean, 'tests/contracts/tooling/ok.ts': 'export const ok = 1;\n', 'tests/contracts/tooling/other.test.ts': "import { ok } from './ok.js';\nexport const v = ok;\n" }));
    expect(green.out).not.toContain('[test-host-import]');
  });

  it('G-d: host words are red in src comments and strings (case-insensitive), frozen hits only shrink, and \\n1 is not N1', async () => {
    const body = (text: string) => unit('engine', 'core', 'a', 'x', text);
    // Independent fixtures run concurrently: ten sequential lint-arch processes exceeded the 30 s CI test timeout under load.
    const texts = ['// run it on the dogfood board\nexport const x = 1;\n', "export const x = 'QWEN';\n", "export const x = '/home/me';\n", '/** pre-N1 note */\nexport const x = 1;\n', '// dev-release switch\nexport const x = 1;\n'];
    const reds = await Promise.all(texts.map(async text => lint(await fixture(body(text)))));
    reds.forEach((red, index) => {
      expect(red.code, texts[index]).toBe(1);
      expect(red.out, texts[index]).toContain('[host-word] src/engine/core/a/internal/x.ts:');
    });
    const harmless = await lint(await fixture(body("export const x = 'exit\\n1 error; dashboard; onboard';\n")));
    expect(harmless.out).not.toContain('[host-word]');
    const allow = (count: number): ArchPatch => arch => { arch.guards.hostWords.allow = [{ file: 'src/engine/core/a/internal/x.ts', count, reason: 'fixture' }]; };
    const one = '// legacy dogfood note\nexport const x = 1;\n', two = '// legacy dogfood and qwen note\nexport const x = 1;\n';
    const [within, over, stale, loose] = await Promise.all([[one, 1], [two, 1], ['export const x = 1;\n', 1], [one, 2]].map(async ([text, count]) =>
      lint(await fixture(body(text as string), true, false, {}, allow(count as number)))));
    expect(within!.out).not.toContain('[host-word]');
    expect(over!.out).toContain('2 host-word hits > allowed 1');
    expect(stale!.out).toContain('stale hostWords.allow entry');
    expect(loose!.out).toContain('lower the allowance (shrink-only)');
  });

  it('G-e: vendor slugs in a layer are capped; a new literal exceeds the cap and a smaller count demands a lower cap', async () => {
    const files = unit('engine', 'core', 'a', 'x', "export const x = (id: string) => id === 'claude';\n");
    const cap = (n: number): ArchPatch => arch => { arch.guards.vendorSlugCaps = { engine: n }; };
    const over = await lint(await fixture(files, true, false, {}, cap(0)));
    expect(over.out).toContain('[slug-cap] src/engine — 1 vendor-slug findings > cap 0');
    const exact = await lint(await fixture(files, true, false, {}, cap(1)));
    expect(exact.out).not.toContain('[slug-cap]');
    const stale = await lint(await fixture(files, true, false, {}, cap(2)));
    expect(stale.out).toContain('[slug-cap] arch.json — guards.vendorSlugCaps.engine is 2 but only 1 remain; lower the cap');
  });

  it('G-g: forbidden model literals are case-insensitive and exempt only by file or declared unit', async () => {
    const files = unit('adapters', 'core', 'vendor', 'x', "export const x = 'CLAUDE-5-x and OPUS 5.5';\n");
    const red = await lint(await fixture(files));
    expect(red.code, red.out).toBe(1);
    expect(red.out).toContain('hardcoded model/provider literal "CLAUDE-5-x"');
    expect(red.out).toContain('hardcoded model/provider literal "OPUS"');
    const exempt = await lint(await fixture(files, true, false, {}, arch => { arch.literals.allowUnits = [{ unit: 'src/adapters/core/vendor', reason: 'fixture' }]; }));
    expect(exempt.out).not.toContain('hardcoded model/provider literal');
    const noReason = await lint(await fixture(files, true, false, {}, arch => { arch.literals.allowUnits = [{ unit: 'src/adapters/core/vendor' }]; }));
    expect(noReason.out).toContain('literals.allowUnits entry needs a reason');
  });

  it('G-a: a core unit may not reach a higher-tier unit across packages through a package index re-export', async () => {
    const files = (tier: string) => ({ ...unit('engine', 'enterprise', 'up', 'u', 'export const up = 1;\n'),
      'src/engine/index.ts': "export { up } from './enterprise/up/index.js';\n",
      [`src/adapters/${tier}/c/index.ts`]: "export { c } from './internal/c.js';\n",
      [`src/adapters/${tier}/c/internal/c.ts`]: "import { up } from '#engine/index.js';\nexport const c = up;\n" });
    const red = await lint(await fixture(files('core')));
    expect(red.code, red.out).toBe(1);
    expect(red.out).toContain('[tier-direction] src/adapters/core/c — core unit depends on enterprise unit src/engine/enterprise/up');
    const green = await lint(await fixture(files('enterprise')));
    expect(green.out).not.toContain('[tier-direction]');
  });

  it('G-l: a tier with its own budget does not consume the package budget; its own budget is enforced', async () => {
    const enterprise = unit('engine', 'enterprise', 'up', 'u', `${'export const a = 1;\n'.repeat(30)}`);
    const budgets = (tier: Record<string, number> | undefined, pkg: number): ArchPatch => arch => { arch.budgets.packageLines.engine = pkg; arch.budgets.tierLines = tier; };
    const files = { ...clean, ...enterprise };
    const shared = await lint(await fixture(files, true, false, {}, budgets({}, 20)));
    expect(shared.out).toContain('[package-budget] src/engine');
    const own = await lint(await fixture(files, true, false, {}, budgets({ 'engine/enterprise': 100 }, 20)));
    expect(own.out).not.toContain('[package-budget]');
    expect(own.out).not.toContain('[tier-budget]');
    const over = await lint(await fixture(files, true, false, {}, budgets({ 'engine/enterprise': 10 }, 20)));
    expect(over.out).toContain('[tier-budget] src/engine/enterprise');
    const bad = await lint(await fixture(files, true, false, {}, budgets({ 'engine/nope': 10, 'ghost/core': 5 }, 20)));
    expect(bad.out).toContain('budgets.tierLines key "engine/nope"');
    expect(bad.out).toContain('budgets.tierLines key "ghost/core"');
  });

  it('G-h: claim/delivery/adoption/lease flow files belong to the effect port owner; legacy files are a shrink-only list', async () => {
    const flow = unit('engine', 'core', 'a', 'run-delivery', 'export const x = 1;\n');
    const red = await lint(await fixture(flow));
    expect(red.out).toContain('[effect-flow] src/engine/core/a/internal/run-delivery.ts — new claim/delivery/adoption/lease flow file outside src/engine/core/effect/');
    const owner = await lint(await fixture(unit('engine', 'core', 'effect', 'target-delivery', 'export const x = 1;\n')));
    expect(owner.out).not.toContain('[effect-flow]');
    const frozen = (list: string[]): ArchPatch => arch => { arch.guards.effectFlows.frozen = list; };
    expect((await lint(await fixture(flow, true, false, {}, frozen(['src/engine/core/a/internal/run-delivery.ts'])))).out).not.toContain('[effect-flow]');
    expect((await lint(await fixture(clean, true, false, {}, frozen(['src/engine/core/gone/internal/old-claim.ts'])))).out).toContain('stale guards.effectFlows.frozen entry');
  });
});
