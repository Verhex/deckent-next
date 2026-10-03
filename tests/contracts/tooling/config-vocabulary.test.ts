import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Tooling intentionally runs against source, with no dist dependency.
// @ts-expect-error JavaScript build tooling has no declaration file.
import { projectVocabulary, lintConfigVocabulary, registryPath, projectionPath, projectionText, projectionStale } from '../../../scripts/config-vocabulary.mjs';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-vocabulary-')); roots.push(root);
  await cp(new URL('../../../src', import.meta.url), join(root, 'src'), { recursive: true });
  await cp(new URL('../../../tsconfig.json', import.meta.url), join(root, 'tsconfig.json'));
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, projectionPath), JSON.stringify(projectVocabulary(root)));
  return root;
}
function check(root: string, file: string) {
  const errors: string[] = [];
  lintConfigVocabulary(root, [file], (rule: string) => errors.push(rule)); return errors;
}
describe('source-derived config vocabulary gate', () => {
  it('rejects stale source even without dist and refuses a missing projection', async () => {
    const root = await fixture(), file = join(root, registryPath);
    await writeFile(file, '// changed source\n', { flag: 'a' });
    expect(check(root, file)).toContain('config-vocabulary-stale');
    await rm(join(root, projectionPath));
    expect(check(root, file)).toContain('config-vocabulary');
  });
  it('detects duplicated defaults, field assignments and enum schemas but allows semantics and registry access', async () => {
    const root = await fixture(), file = join(root, 'src/probe.ts');
    await writeFile(file, "const output_mode = 'json'; const opts = {output_mode: 'standard'}; const x = z.enum(['explanatory']); const y = settings.output_mode ?? 'verbose';");
    expect(check(root, file)).toHaveLength(4);
    await writeFile(file, "const output_mode = getConfigFieldDefault('output_mode'); if (output_mode === 'standard') consume(); type X = 'json';");
    expect(check(root, file)).toEqual([]);
  });
  it('is identical for a CRLF read view of every consumed source (Windows autocrlf)', async () => {
    const root = await fixture(), stored = await readFile(join(root, projectionPath), 'utf8');
    const read = ts.sys.readFile, converted = new Set<string>();
    // Apply autocrlf at the compiler's byte-read boundary, including every imported .ts source.
    // Avoid ~960 additional file reads AND writes; keep the 30s ceiling and exact projection equality.
    const view = vi.spyOn(ts.sys, 'readFile').mockImplementation((path, encoding) => {
      const text = read(path, encoding), name = relative(join(root, 'src'), path);
      if (text === undefined || isAbsolute(name) || name === '..' || name.startsWith('..') || !name.endsWith('.ts')) return text;
      converted.add(relative(root, path).replaceAll('\\', '/'));
      return text.replace(/\r?\n/gu, '\r\n');
    });
    let projected;
    try { projected = projectVocabulary(root); } finally { view.mockRestore(); }
    expect(converted.size).toBeGreaterThan(10);
    for (const source of Object.keys(projected.sources)) expect(converted.has(source), source).toBe(true);
    expect(JSON.stringify(projected)).toBe(stored);
  });
  it('build check reads a CRLF projection as the same text and still rejects a changed one', async () => {
    const root = await fixture(), file = join(root, projectionPath), text = projectionText(root) as string;
    await writeFile(file, text.replace(/\n/gu, '\r\n'));
    expect(projectionStale(root)).toBe(false);
    await writeFile(file, text.replace(/\n/gu, '\r\n').replace('"schemaVersion": 1', '"schemaVersion": 2'));
    expect(projectionStale(root)).toBe(true);
  });
});

describe('config binding ratchet', () => {
  it('rejects a declared consumer whose unit never references its field', async () => {
    const root = await fixture();
    // @ts-expect-error JavaScript tooling contract has no declarations.
    const { lintConfigBindings } = await import('../../../scripts/config-vocabulary.mjs');
    const errors: string[] = [];
    // Consumer exists but reads a different config field.
    const file = join(root, 'src/platform/core/config-fields/internal/fields.ts');
    const before = await readFile(file, 'utf8');
    await writeFile(file, before.replace("consumers: ['src/composition/core/storage']", "consumers: ['src/platform/core/output']"));
    lintConfigBindings(root, (rule: string) => errors.push(rule));
    expect(errors).toContain('config-binding-consumer');
  });
  it('rejects new declared-only knobs against the frozen empty baseline', async () => {
    const root = await fixture();
    // @ts-expect-error JavaScript tooling contract has no declarations.
    const { lintConfigBindings } = await import('../../../scripts/config-vocabulary.mjs');
    const file = join(root, registryPath), before = await readFile(file, 'utf8');
    await writeFile(file, before.replace("{ state: 'bound', consumers: ['src/platform/core/config'] }", "{ state: 'declared-only', reason: 'test fixture' }"));
    const errors: string[] = [];
    lintConfigBindings(root, (rule: string) => errors.push(rule));
    expect(errors).toContain('config-binding-declared-only');
  });
});
