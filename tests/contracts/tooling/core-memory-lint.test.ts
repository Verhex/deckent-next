import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const lint = (root: string) => spawnSync(process.execPath, [join(root, 'scripts/lint-core-memory.mjs')], { encoding: 'utf8' });
async function copy() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-core-memory-')); roots.push(root);
  await cp(new URL('../../../.deckent/docs/core-memory', import.meta.url), join(root, '.deckent/docs/core-memory'), { recursive: true });
  await cp(new URL('../../../scripts/lint-core-memory.mjs', import.meta.url), join(root, 'scripts/lint-core-memory.mjs'));
  await cp(new URL('../../../scripts/core-memory.sha256', import.meta.url), join(root, 'scripts/core-memory.sha256'));
  return root;
}
describe('core-memory manifest gate', () => {
  it('hashes text, so a CRLF checkout (Windows autocrlf) matches the LF manifest, while a real edit is still caught', async () => {
    const root = await copy(), dir = join(root, '.deckent/docs/core-memory');
    expect(lint(root).status).toBe(0);
    for (const name of (await readdir(dir)).filter(entry => entry.endsWith('.md'))) await writeFile(join(dir, name), (await readFile(join(dir, name), 'utf8')).replace(/\r?\n/gu, '\r\n'));
    expect(lint(root)).toMatchObject({ status: 0 });
    await writeFile(join(dir, 'MEMORY.md'), '\r\nunauthorized edit\r\n', { flag: 'a' });
    const edited = lint(root);
    expect(edited.status).toBe(1); expect(edited.stderr).toContain('"MEMORY.md" changed since the manifest was written');
  });
});
