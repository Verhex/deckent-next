import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inventoryLegacyContract, readLegacyInventory } from './legacy-surface-inventory.mjs';
const row = (path, extra = '') => `c({path:'${path}',summaryKey:'example',effect:'read',defaultExecution:'read',authority:'open',output:'text'${extra}})`;
const source = (rows, fallback = "['cli']") => `
function c(init) { return { surfaces: Object.freeze([...(init.surfaces ?? ${fallback})]) }; }
export const CLI_COMMAND_CONTRACTS = Object.freeze([${rows.join(',')}]);`;

test('counts path-level and overlapping surfaces, including REPL-only and factory fallback', () => {
  const text = source([row('task'), row('task inspect', ",surfaces:['cli','mcp'],opts:{'--json':'option.json'}"), row('clear', ",surfaces:['repl']")]);
  const report = inventoryLegacyContract(text, 'fixture.ts');
  assert.deepEqual(report.counts, { paths: 3, bySurface: { cli: 2, mcp: 1, repl: 1 }, replOnly: 1 });
  assert.deepEqual(report.rows.map(r => r.surfacesSource), ['factory-fallback', 'row', 'row']);
  assert.equal(report.rows[1].authored.opts['--json'], 'option.json');
  assert.equal(report.source.sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(report.rows[0].sourceLine, 3);
  const changed = inventoryLegacyContract(source([row('task')], "['mcp']"));
  assert.deepEqual(changed.rows[0].surfaces, ['mcp']);
});

test('refuses dynamic rows, duplicate identities, unknown surfaces and ambiguous declarations', () => {
  const invalid = [
    source([row('same'), row('same')]), source([row('x', ",surfaces:['other']")]),
    source([row('x', ',surfaces:null')]), source([row('x', ",surfaces:['cli','cli']")]),
    source([row('x', ',opts:dangerous()')]), source([row('x', ",...{hidden:true}")]),
    source([row('x', ",path:'replacement'")]), source(['c({path:"missing-fields"})']),
    source([row('x')], 'getDefaults()'), source([row('x')]).replace('Object.freeze([c(', 'dynamic([c('),
    source([row('x')]) + '\nconst CLI_COMMAND_CONTRACTS = [];', source([row('x')]) + '\nfunction c() {}',
    'export const CLI_COMMAND_CONTRACTS = [',
  ];
  for (const text of invalid) assert.throws(() => inventoryLegacyContract(text), /LEGACY_CONTRACT_UNSUPPORTED/);
});

test('does not execute arbitrary legacy statements or expressions while reading a real file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-legacy-inventory-'));
  try {
    const path = join(root, 'legacy.ts');
    const text = 'throw new Error("must-never-execute");\n' + source([row('read')]);
    await writeFile(path, text);
    assert.equal((await readLegacyInventory(path)).counts.paths, 1);
    assert.equal(await readFile(path, 'utf8'), text);
    await writeFile(path, source([row('read', ',surfaces:(()=>{throw new Error("executed")})()')]));
    await assert.rejects(readLegacyInventory(path), /LEGACY_CONTRACT_UNSUPPORTED/);
    await writeFile(path, Buffer.alloc(2_097_153));
    await assert.rejects(readLegacyInventory(path), /LEGACY_CONTRACT_UNSUPPORTED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real Next host CLI emits JSON or a bounded error without modifying its source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-legacy-cli-'));
  try {
    const path = join(root, 'legacy.ts'), text = source([row('inspect')]); await writeFile(path, text);
    const binary = fileURLToPath(new URL('./legacy-surface-inventory.mjs', import.meta.url));
    const good = spawnSync(process.execPath, [binary, path], { encoding: 'utf8', timeout: 10000 });
    assert.equal(good.status, 0, good.stderr); assert.equal(JSON.parse(good.stdout).counts.paths, 1);
    assert.equal(await readFile(path, 'utf8'), text);
    for (const args of [[], [join(root, 'missing.ts')], [path, 'extra']]) {
      const bad = spawnSync(process.execPath, [binary, ...args], { encoding: 'utf8', timeout: 10000 });
      assert.equal(bad.status, 1); assert.equal(bad.stdout, '');
      assert.match(JSON.parse(bad.stderr).error, /^LEGACY_CONTRACT_(USAGE|UNSUPPORTED)$/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
