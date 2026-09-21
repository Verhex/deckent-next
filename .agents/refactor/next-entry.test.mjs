import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
test('Next host launchers pin both surfaces and SDK to Next without legacy data override or HOME mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-entry-'));
  try {
    await mkdir(join(root, '.agents/refactor'), { recursive: true });
    const entry = join(root, '.agents/refactor/next-entry.mjs'); await copyFile(join(here, 'next-entry.mjs'), entry);
    const probe = 'console.log(JSON.stringify({cwd:process.cwd(),global:process.env.DECKENT_GLOBAL_HOME,data:process.env.DECKENT_HOME??null,home:process.env.HOME,args:process.argv.slice(2)}));';
    for (const surface of ['cli', 'mcp']) {
      const target = join(root, `dist/composition/core/${surface}/internal/entry.js`);
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, probe);
      const bin = join(root, surface === 'cli' ? 'deckent' : 'deckent-mcp'); await symlink(entry, bin);
      const run = spawnSync(process.execPath, [bin, '--probe'], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, DECKENT_HOME: '/legacy/runtime', DECKENT_GLOBAL_HOME: '/legacy/global' } });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), { cwd: root, global: join(root, '.deckent/host/global'), data: null, home: process.env.HOME, args: ['--probe'] });
    }
    const run = spawnSync(process.execPath, [entry, 'node', '-e', probe], { encoding: 'utf8' });
    assert.equal(run.status, 0); assert.equal(JSON.parse(run.stdout).cwd, root);
    assert.equal((await readFile(entry, 'utf8')).includes('deckent-dev/dist'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
