import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lintMemory, frontmatter, formatReport, MEMORY_DIR_ENV } from './memory-lint.mjs';

const TOOL = fileURLToPath(new URL('./memory-lint.mjs', import.meta.url));
const note = (name, extra = '', body = '') => `---\nname: ${name}\ndescription: ${name} note\nmetadata:\n  type: project\n${extra}---\n\n${body}\n`;
function fixture(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckent-memory-lint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
const snapshot = dir => fs.readdirSync(dir).sort().map(name => [name, fs.statSync(path.join(dir, name)).mtimeMs, fs.readFileSync(path.join(dir, name), 'utf8')]);
const codes = result => result.warnings.map(w => `${w.code} ${w.file}`).sort();

test('a consistent memory directory has no warnings', t => {
  const dir = fixture(t, {
    'MEMORY.md': '- [A](a.md) — a\n- [B](b.md) — b\n',
    'a.md': note('a', 'status: superseded\nsupersededBy: [b]\n', 'See [[b]].'),
    'b.md': note('b', 'status: active\n'),
  });
  const result = lintMemory(dir);
  assert.equal(result.skipped, false); assert.equal(result.files, 3);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.lifecycle, { status: 2, supersededBy: 1 });
  assert.match(formatReport(result), /3 file\(s\), 0 warning\(s\); lifecycle fields: status 2, supersededBy 1; read-only, exit 0/u);
});

test('every warning class is reported and the directory is left untouched', t => {
  const dir = fixture(t, {
    'MEMORY.md': '- [A](a.md) — a\n- [Gone](gone.md) — removed file\n- [web](https://example.com)\n',
    'a.md': note('a', 'supersededBy:\n  - nowhere\n', 'Links [[missing-note]] and [[a|self]].'),
    'unlisted.md': note('unlisted'),
    'bare.md': 'no frontmatter, [[a]]\n',
    'partial.md': '---\nname: other-name\nmetadata:\n  kind: x\n---\n',
    'old.md': note('old', 'status: superseded\n'),
  });
  const before = snapshot(dir);
  const result = lintMemory(dir);
  assert.deepEqual(snapshot(dir), before, 'lint must not write, rename or touch the memory directory');
  assert.deepEqual(codes(result), [
    'frontmatter-field partial.md', 'frontmatter-field partial.md',
    'frontmatter-missing bare.md',
    'index-broken-link MEMORY.md',
    'index-unlisted bare.md', 'index-unlisted old.md', 'index-unlisted partial.md', 'index-unlisted unlisted.md',
    'name-mismatch partial.md',
    'superseded-broken a.md',
    'superseded-without-target old.md',
    'wikilink-broken a.md',
  ]);
  const fields = result.warnings.filter(w => w.code === 'frontmatter-field').map(w => w.detail).sort();
  assert.deepEqual(fields, ['missing description', 'missing metadata.type']);
  assert.equal(result.warnings.find(w => w.code === 'index-broken-link').line, 2);
  assert.match(result.warnings.find(w => w.code === 'wikilink-broken').detail, /missing-note/u);
});

test('frontmatter reads metadata children and supersededBy as scalar, inline list or block list', () => {
  assert.equal(frontmatter('no block'), null);
  assert.equal(frontmatter('---\nname: x\n'), null);
  assert.deepEqual(frontmatter(note('x', 'supersededBy: "y.md"\n')).supersededBy, ['y.md']);
  assert.deepEqual(frontmatter(note('x', 'supersededBy: [y, "z"]\n')).supersededBy, ['y', 'z']);
  assert.deepEqual(frontmatter(note('x', 'supersededBy:\n  - y\n  - z\nstatus: superseded\n')).supersededBy, ['y', 'z']);
  assert.equal(frontmatter(note('x')).metadata.type, 'project');
});

test('no directory or a missing one is a skip, not a failure; the CLI always exits 0 and never writes', t => {
  assert.equal(lintMemory(null).skipped, true);
  assert.equal(lintMemory(path.join(os.tmpdir(), 'deckent-memory-lint-does-not-exist')).skipped, true);
  const env = { ...process.env }; delete env[MEMORY_DIR_ENV];
  const run = (args, extra = {}) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
  const none = run([]);
  assert.equal(none.status, 0); assert.match(none.stdout, /skipped \(no directory given/u);
  const dir = fixture(t, { 'MEMORY.md': '- [A](a.md)\n', 'a.md': note('a', '', '[[nope]]') });
  const before = snapshot(dir);
  const viaEnv = run([], { [MEMORY_DIR_ENV]: dir });
  assert.equal(viaEnv.status, 0); assert.match(viaEnv.stdout, /wikilink-broken a\.md:\d+/u); assert.match(viaEnv.stdout, /1 warning\(s\)/u);
  const viaArg = run(['--dir', dir, '--json']);
  assert.equal(viaArg.status, 0); assert.equal(JSON.parse(viaArg.stdout).warnings.length, 1);
  assert.deepEqual(snapshot(dir), before);
  assert.equal(run(['--dir']).status, 2);
});
