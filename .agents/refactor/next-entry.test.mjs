import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink, rename } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
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
      const run = spawnSync(process.execPath, [bin, '--probe'], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, DECKENT_HOME: '/legacy/runtime', DECKENT_GLOBAL_HOME: '/legacy/global', DECKENT_NEXT_INSTALL_ROOT: join(root, 'no-install') } });
      assert.equal(run.status, 0, run.stderr);
      // The global root lives outside the checkout (a bundled bwrap copy inside the project is refused; live 2026-09-29).
      const seen = JSON.parse(run.stdout);
      assert.deepEqual(seen, { cwd: root, global: join(process.env.HOME, '.local/state/deckent-next-dev'), data: null, home: process.env.HOME, args: ['--probe'] });
      assert.equal(seen.global.startsWith(`${root}/`), false);
    }
    const run = spawnSync(process.execPath, [entry, 'node', '-e', probe], { encoding: 'utf8', env: { ...process.env, DECKENT_NEXT_INSTALL_ROOT: join(root, 'no-install') } });
    assert.equal(run.status, 0); assert.equal(JSON.parse(run.stdout).cwd, root);
    assert.equal((await readFile(entry, 'utf8')).includes('deckent-dev/dist'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('DEV-U2-0: with a staged `current` the launchers run that version by real path with the project as cwd; an invalid `current` is refused', async () => {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'next-entry-current-')));
  try {
    const root = join(base, 'checkout'), install = join(base, 'install'), id = '0123456789ab-ba9876543210', version = join(install, 'versions', id);
    await mkdir(join(root, '.agents/refactor'), { recursive: true });
    const entry = join(root, '.agents/refactor/next-entry.mjs'); await copyFile(join(here, 'next-entry.mjs'), entry);
    const probe = 'console.log(JSON.stringify({cwd:process.cwd(),script:process.argv[1],install:process.env.DECKENT_NEXT_INSTALL_ROOT??null}));';
    for (const dir of [root, version]) for (const surface of ['cli', 'mcp']) {
      const target = join(dir, `dist/composition/core/${surface}/internal/entry.js`); await mkdir(dirname(target), { recursive: true }); await writeFile(target, probe);
    }
    await writeFile(join(version, 'dist/build-identity.json'), '{}'); await writeFile(join(version, 'release.json'), JSON.stringify({ versionId: id }));
    const env = { ...process.env, DECKENT_NEXT_INSTALL_ROOT: install };
    const launch = surface => spawnSync(process.execPath, [entry, surface], { cwd: tmpdir(), encoding: 'utf8', env });
    // No `current`: today's behaviour (the checkout's dist).
    assert.equal(JSON.parse(launch('cli').stdout).script, join(root, 'dist/composition/core/cli/internal/entry.js'));
    await symlink(`versions/${id}`, join(install, 'current'));
    for (const surface of ['cli', 'mcp']) {
      const run = launch(surface); assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), { cwd: root, script: join(version, `dist/composition/core/${surface}/internal/entry.js`), install: null });
    }
    // A `current` that does not name a staged version is refused, never silently replaced by the checkout.
    await rename(join(version, 'release.json'), join(version, 'release.moved'));
    const unreleased = launch('cli'); assert.equal(unreleased.status, 2); assert.match(unreleased.stderr, /NEXT_ENTRY_CURRENT_INVALID/);
    await rename(join(version, 'release.moved'), join(version, 'release.json'));
    await rm(join(install, 'current')); await symlink(join(root), join(install, 'current'));
    const outside = launch('cli'); assert.equal(outside.status, 2); assert.match(outside.stderr, /NEXT_ENTRY_CURRENT_INVALID/);
    await rm(join(install, 'current')); await symlink('versions/missing', join(install, 'current'));
    const dangling = launch('mcp'); assert.equal(dangling.status, 2); assert.match(dangling.stderr, /NEXT_ENTRY_CURRENT_INVALID/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
