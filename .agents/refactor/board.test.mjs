import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initBoard, readBoard, setOwnRow, setMap, clearRow, renderHtml, renderText, DEFAULT_SLOTS } from './board.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckent-board-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'process-board.json') };
}
const code = fn => { try { fn(); } catch (error) { return error.code ?? error.message; } return null; };

test('init creates the board once with role slots, revision 0 and the dogfood mirror; a second init is refused', t => {
  const { file } = fixture(t);
  const board = initBoard(file);
  assert.equal(board.schemaVersion, 1); assert.equal(board.revision, 0);
  assert.deepEqual(board.sessions.map(s => s.slot), DEFAULT_SLOTS.map(s => s.slot));
  assert.ok(board.sessions.every(s => s.status === 'unassigned' && s.sessionId === null));
  assert.equal(board.dogfood.mode, 'OFF'); assert.match(board.dogfood.source, /AGENTS\.md/);
  assert.equal(code(() => initBoard(file)), 'BOARD_EXISTS');
  assert.deepEqual(readBoard(file), board);
});

test('a session claims an unassigned row, later writes need the same session id; a stranger is refused without changing the file', t => {
  const { file } = fixture(t); initBoard(file);
  const first = setOwnRow(file, 'review', { name: 'Sol', focus: 'batch review', status: 'active' }, { session: 'sol-1', revision: 0 });
  assert.equal(first.revision, 1);
  const row = readBoard(file).sessions.find(s => s.slot === 'review');
  assert.equal(row.sessionId, 'sol-1'); assert.equal(row.name, 'Sol'); assert.ok(Date.parse(row.updatedAt) > 0);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(code(() => setOwnRow(file, 'review', { focus: 'hijack' }, { session: 'other', revision: 1 })), 'BOARD_IDENTITY_MISMATCH');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(setOwnRow(file, 'review', { focus: 'next batch' }, { session: 'sol-1', revision: 1 }).revision, 2);
});

test('a stale revision is refused and the error names the current revision; the file is unchanged', t => {
  const { file } = fixture(t); initBoard(file);
  setOwnRow(file, 'main', { status: 'active' }, { session: 'm', revision: 0 });
  const before = fs.readFileSync(file, 'utf8');
  let error; try { setOwnRow(file, 'main', { focus: 'late' }, { session: 'm', revision: 0 }); } catch (e) { error = e; }
  assert.equal(error.code, 'BOARD_REVISION_CONFLICT'); assert.equal(error.currentRevision, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('unknown slot, unknown field, bad status, protected field and oversize value are refused', t => {
  const { file } = fixture(t); initBoard(file);
  assert.equal(code(() => setOwnRow(file, 'nope', {}, { session: 'x', revision: 0 })), 'BOARD_SLOT');
  assert.equal(code(() => setOwnRow(file, 'main', { color: 'red' }, { session: 'x', revision: 0 })), 'BOARD_FIELD');
  assert.equal(code(() => setOwnRow(file, 'main', { status: 'done' }, { session: 'x', revision: 0 })), 'BOARD_FIELD');
  assert.equal(code(() => setOwnRow(file, 'main', { sessionId: 'y' }, { session: 'x', revision: 0 })), 'BOARD_FIELD');
  assert.equal(code(() => setOwnRow(file, 'main', { focus: 'a'.repeat(5000) }, { session: 'x', revision: 0 })), 'BOARD_FIELD');
  assert.equal(code(() => setOwnRow(file, 'main', { focus: 'ok' }, { revision: 0 })), 'BOARD_SESSION');
  assert.equal(readBoard(file).revision, 0);
});

test('writer refuses lock contention and a symlinked board without corrupting or leaving residue', t => {
  const { dir, file } = fixture(t); initBoard(file);
  const before = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(`${file}.lock`);
  assert.equal(code(() => setOwnRow(file, 'main', { focus: 'x' }, { session: 'm', revision: 0 })), 'BOARD_LOCKED');
  fs.rmdirSync(`${file}.lock`);
  const link = path.join(dir, 'link.json'); fs.symlinkSync(file, link);
  assert.notEqual(code(() => setOwnRow(link, 'main', { focus: 'x' }, { session: 'm', revision: 0 })), null);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['link.json', 'process-board.json']);
});

test('only the main session reconciles the map: assigns rows, mirrors dogfood with a source, clears a row to no residue', t => {
  const { file } = fixture(t); initBoard(file);
  setOwnRow(file, 'main', { name: 'Fable main', status: 'active' }, { session: 'main-1', revision: 0 });
  assert.equal(code(() => setMap(file, { sessions: { review: { sessionId: 'sol-9' } } }, { session: 'sol-9', revision: 1 })), 'BOARD_NOT_MAIN');
  const result = setMap(file, { sessions: { review: { sessionId: 'sol-9', name: 'GPT-6.1 Sol', channel: 'astra', status: 'active' } },
    dogfood: { mode: 'OFF', source: 'AGENTS.md · Current development phase', observedAt: '2026-10-03T00:00:00.000Z' } }, { session: 'main-1', revision: 1 });
  assert.equal(result.revision, 2);
  let review = readBoard(file).sessions.find(s => s.slot === 'review');
  assert.equal(review.sessionId, 'sol-9'); assert.equal(review.channel, 'astra');
  assert.equal(code(() => setMap(file, { dogfood: { mode: 'ON' } }, { session: 'main-1', revision: 2 })), 'BOARD_FIELD'); // dogfood needs a source
  assert.equal(code(() => clearRow(file, 'review', { session: 'sol-9', revision: 2 })), 'BOARD_NOT_MAIN');
  clearRow(file, 'review', { session: 'main-1', revision: 2 });
  review = readBoard(file).sessions.find(s => s.slot === 'review');
  assert.equal(review.status, 'unassigned');
  for (const [key, value] of Object.entries(review)) if (!['slot', 'role', 'status'].includes(key)) assert.equal(value, null, key);
  assert.equal(code(() => clearRow(file, 'main', { session: 'main-1', revision: 3 })), 'BOARD_SLOT'); // main never clears itself
});

test('workers live only as a sub-list of the main row and each item is validated', t => {
  const { file } = fixture(t); initBoard(file);
  const worker = { id: 'codex-a1', kind: 'codex-exec', model: 'gpt-6.1-sol', worktree: '/wt/a1', card: 'AOF-HANDOFF', status: 'running', since: '2026-10-03T00:00:00.000Z' };
  setOwnRow(file, 'main', { status: 'active', workers: [worker] }, { session: 'main-1', revision: 0 });
  assert.deepEqual(readBoard(file).sessions.find(s => s.slot === 'main').workers, [worker]);
  assert.equal(code(() => setOwnRow(file, 'review', { workers: [worker] }, { session: 'sol', revision: 1 })), 'BOARD_FIELD');
  assert.equal(code(() => setOwnRow(file, 'main', { workers: [{ id: 'x' }] }, { session: 'main-1', revision: 1 })), 'BOARD_FIELD');
  assert.equal(code(() => setOwnRow(file, 'main', { workers: [{ ...worker, kind: 'robot' }] }, { session: 'main-1', revision: 1 })), 'BOARD_FIELD');
  setOwnRow(file, 'main', { workers: [] }, { session: 'main-1', revision: 1 });
  assert.deepEqual(readBoard(file).sessions.find(s => s.slot === 'main').workers, []);
});

test('render escapes every field, shows age without a liveness claim and marks unassigned rows', t => {
  const { file } = fixture(t); initBoard(file);
  const hostile = '</script><img src=x onerror=alert(1)> "q" \'s\' & <!-- c -->';
  setOwnRow(file, 'main', { name: hostile, focus: hostile, next: hostile, status: 'waiting', waitingOn: 'owner',
    workers: [{ id: hostile, kind: 'codex-exec', model: hostile, worktree: hostile, card: hostile, status: 'running', since: '2026-10-03T00:00:00.000Z' }] },
  { session: 'main-1', revision: 0 });
  const board = readBoard(file);
  const now = new Date(Date.parse(board.sessions[0].updatedAt) + 7 * 60_000);
  const html = renderHtml(board, { now });
  assert.equal(html.includes('<img'), false); assert.equal(html.includes('</script><img'), false);
  assert.equal((html.match(/<script/g) ?? []).length, 0);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(/7 dk önce/.test(html)); assert.ok(!/canlı|live/i.test(html.replace(/yalnız pano verisi[^<]*/g, '')));
  assert.ok(/Atanmadı/.test(html)); assert.ok(/Dogfood[^<]*OFF/.test(html) || /OFF/.test(html));
  const text = renderText(board, { now });
  assert.ok(text.includes('7 dk önce')); assert.ok(text.includes('Atanmadı')); assert.ok(!/<img/.test(text) || text.includes(hostile));
});

test('readBoard rejects a foreign schema, a non-object file and oversize content', t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, revision: 0, sessions: [] }));
  assert.equal(code(() => readBoard(file)), 'BOARD_SCHEMA');
  fs.writeFileSync(file, '[]'); assert.equal(code(() => readBoard(file)), 'BOARD_SCHEMA');
  fs.writeFileSync(file, 'x'.repeat(300_000)); assert.notEqual(code(() => readBoard(file)), null);
});
