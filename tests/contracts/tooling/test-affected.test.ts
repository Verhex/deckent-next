import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error Executable JS tooling has no declaration file.
import { catalogMentions, dependencyIndex, loadMap, selectTests } from '../../../scripts/test-affected.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tree = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'deckent-test-affected-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); }
  return { root, inventory: Object.keys(files) };
};
type Graph = { index: Map<string, string[]>; builtIndex: Map<string, string[]>; builtTests: Set<string> };

it('selects through barrels, literal fixture paths and the built product only where the test reaches; unmapped widens, empty stays empty', async () => {
  const { root, inventory } = tree({
    'src/domain/index.ts': "export * from './a.js';\nexport * from './b.js';\n",
    'src/domain/a.ts': "export const a = () => 'a';\n",
    // A top-level call, like the zod schemas in real units: without per-file tree shaking the barrel would keep b for every importer.
    'src/domain/b.ts': "import { a } from './a.js';\nexport const B = Object.freeze({ b: `${a()}b` });\n",
    'tests/x.test.ts': "import { readFileSync } from 'node:fs';\nimport { a } from '#domain/index.js';\nexport const x = [a(), readFileSync(new URL('./fixtures/in.json', import.meta.url))];\n",
    'tests/fixtures/in.json': '{}\n',
    'tests/y.test.ts': "import { join } from 'node:path';\nexport const entry = join('root', 'dist/domain/b.js');\n",
  });
  const tests = ['tests/x.test.ts', 'tests/y.test.ts'];
  const graph: Graph = await dependencyIndex(root, tests, inventory, { 'dist/': 'src/' }, ['domain']);
  expect(graph.index.get('src/domain/a.ts')).toEqual(['tests/x.test.ts']);
  expect(graph.index.get('src/domain/b.ts')).toBeUndefined(); // the barrel re-exports b, but x never uses it
  expect(graph.index.get('tests/fixtures/in.json')).toEqual(['tests/x.test.ts']);
  expect(graph.builtIndex.get('src/domain/b.ts')).toEqual(['tests/y.test.ts']);
  expect([...graph.builtTests]).toEqual(['tests/y.test.ts']);

  const map = loadMap({ version: 1, mirror: {}, rules: [{ inputs: ['vitest.config.ts'], widen: true, reason: 'config' },
    { inputs: ['**/*.md'], none: true, reason: 'docs' }] }, {});
  const pick = (changed: string[], built = false) => selectTests(changed, graph, map, tests, built);
  expect(pick(['src/domain/a.ts', 'tests/fixtures/in.json']).selected).toEqual(['tests/x.test.ts']);
  // Reached only through the built product: counted next to a direct selection, and never an empty pass on its own.
  expect(pick(['src/domain/a.ts']).lines[0]).toContain('1 test file(s); 1 more reach it only through the built product');
  expect(pick(['src/domain/b.ts'])).toMatchObject({ selected: [], widen: ['src/domain/b.ts'] });
  expect(pick(['src/domain/b.ts'], true)).toMatchObject({ selected: ['tests/y.test.ts'], widen: [] });
  expect(pick(['README.md']).selected).toEqual([]); // declared test-free: the command reports an empty selection, never a pass
  expect(pick(['notes.txt', 'vitest.config.ts']).widen).toEqual(['notes.txt', 'vitest.config.ts']);
  expect(() => loadMap({ version: 1, mirror: {}, rules: [{ inputs: ['x'], reason: 'no effect' }] }, {})).toThrow('TEST_AFFECTED_MAP_INVALID');
});

it('narrows a catalog edit: text changes to the tests that assert it, added or removed keys also to the source that names them', () => {
  const texts: Record<string, string> = { 'src/old.ts': "t('run.started')", 'src/use.ts': "t('run.added')", 'src/dynamic.ts': 't(`run.${phase}`)',
    'src/other.ts': "t('run.same')", 'src/noise.ts': 'Run started at noon', 'tests/key.test.ts': "'run.started'",
    'tests/snap.txt': 'Run started at noon', 'tests/whole.test.ts': 'MESSAGE_KEYS' };
  const mentions = catalogMentions({ 'run.started': 'Run started at {time}', 'run.same': 'Same' },
    { 'run.started': 'Run began at {time}', 'run.same': 'Same', 'run.added': 'Added' }, ['MESSAGE_KEYS'], Object.keys(texts), (file: string) => texts[file]);
  expect([...mentions].sort()).toEqual(['src/dynamic.ts', 'src/use.ts', 'tests/key.test.ts', 'tests/snap.txt', 'tests/whole.test.ts']);
  expect(catalogMentions(['not', 'flat'], {}, [], [], () => '')).toBeNull();
  expect(JSON.parse(readFileSync(new URL('../../../scripts/test-affected-map.json', import.meta.url), 'utf8')).version).toBe(1);
});
