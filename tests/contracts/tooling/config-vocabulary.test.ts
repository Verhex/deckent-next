import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// Tooling intentionally runs against source, with no dist dependency.
// @ts-expect-error JavaScript build tooling has no declaration file.
import { projectVocabulary, lintConfigVocabulary, registryPath, projectionPath } from '../../../scripts/config-vocabulary.mjs';
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
    await writeFile(file, "const mode = 'performance'; const opts = {output_mode: 'standard'}; const x = z.enum(['balanced']); const y = settings.mode ?? 'economic';");
    expect(check(root, file)).toHaveLength(4);
    await writeFile(file, "const mode = getConfigFieldDefault('mode'); if (mode === 'performance') consume(); type X = 'json';");
    expect(check(root, file)).toEqual([]);
  });
});
