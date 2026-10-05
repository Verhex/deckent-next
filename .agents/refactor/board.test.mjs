import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initBoard, readBoard, setOwnRow, setMap, clearRow, renderHtml, renderText, renderOwnerReport, writeAtomic, DEFAULT_SLOTS } from './board.mjs';

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

test('a closed main is replaced with the new body, previous identity and takeover time; old work is cleared', t => {
  const { file } = fixture(t); initBoard(file);
  const worker = { id: 'old-worker', kind: 'codex-exec', model: 'test-model', worktree: '/old', card: 'old-card', status: 'running', since: '2026-10-03T00:00:00.000Z' };
  setOwnRow(file, 'main', { name: 'Old', channel: 'old-channel', cwd: '/old', workRef: 'old-work', focus: 'old-focus',
    status: 'closed', waitingOn: 'owner', next: 'old-next', workers: [worker] }, { session: 'old-main', revision: 0 });
  const before = readBoard(file), now = new Date('2026-10-05T10:00:00.000Z');
  assert.deepEqual(setOwnRow(file, 'main', { name: 'New', focus: 'new-focus' }, { session: 'new-main', revision: 1, now }),
    { revision: 2, updatedAt: now.toISOString() });
  const board = readBoard(file);
  assert.deepEqual(board.sessions[0], { slot: 'main', role: before.sessions[0].role, name: 'New', sessionId: 'new-main',
    channel: null, cwd: null, workRef: null, focus: 'new-focus', status: 'active', waitingOn: null, next: null,
    updatedAt: now.toISOString(), workers: [], previousSessionId: 'old-main', takenOverAt: now.toISOString() });
  assert.equal(board.schemaVersion, 1);
  assert.deepEqual(board.sessions.slice(1), before.sessions.slice(1)); assert.deepEqual(board.dogfood, before.dogfood);
  setOwnRow(file, 'main', { next: 'continue' }, { session: 'new-main', revision: 2 });
  assert.equal(readBoard(file).sessions[0].takenOverAt, now.toISOString());
  assert.equal(readBoard(file).sessions[0].previousSessionId, 'old-main');
});

for (const status of ['active', 'waiting', 'blocked']) test(`a stranger cannot take over a ${status} row, even with a closed body`, t => {
  const { file } = fixture(t); initBoard(file);
  setOwnRow(file, 'main', { status }, { session: 'old-main', revision: 0 });
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(code(() => setOwnRow(file, 'main', { status: 'closed' }, { session: 'new-main', revision: 1 })), 'BOARD_IDENTITY_MISMATCH');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('the new main can reconcile and clear rows; the old main loses all three write paths', t => {
  const { file } = fixture(t); initBoard(file);
  setOwnRow(file, 'main', { status: 'closed' }, { session: 'old-main', revision: 0 });
  setOwnRow(file, 'main', {}, { session: 'new-main', revision: 1 });
  assert.equal(setMap(file, { sessions: { review: { sessionId: 'reviewer' } } }, { session: 'new-main', revision: 2 }).revision, 3);
  assert.equal(clearRow(file, 'review', { session: 'new-main', revision: 3 }).revision, 4);
  assert.equal(readBoard(file).sessions.find(row => row.slot === 'review').sessionId, null);
  const before = fs.readFileSync(file, 'utf8'), auth = { session: 'old-main', revision: 4 };
  assert.equal(code(() => setOwnRow(file, 'main', {}, auth)), 'BOARD_IDENTITY_MISMATCH');
  assert.equal(code(() => setMap(file, { sessions: { review: { sessionId: 'old-main' } } }, auth)), 'BOARD_NOT_MAIN');
  assert.equal(code(() => clearRow(file, 'review', auth)), 'BOARD_NOT_MAIN');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a takeover keeps revision fencing, validates the body and does not allow forged provenance', t => {
  const { dir, file } = fixture(t); initBoard(file);
  setOwnRow(file, 'main', { status: 'closed' }, { session: 'old-main', revision: 0 });
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => setOwnRow(file, 'main', {}, { session: 'new-main', revision: 0 }),
    error => error.code === 'BOARD_REVISION_CONFLICT' && error.currentRevision === 1);
  for (const patch of [null, { workers: [{}] }, { previousSessionId: 'forged' }, { takenOverAt: '2026-10-01' }]) {
    assert.equal(code(() => setOwnRow(file, 'main', patch, { session: 'new-main', revision: 1 })), 'BOARD_FIELD');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  assert.deepEqual(fs.readdirSync(dir), ['process-board.json']);
  setOwnRow(file, 'main', {}, { session: 'new-main', revision: 1 });
  const after = fs.readFileSync(file, 'utf8');
  assert.throws(() => setOwnRow(file, 'main', {}, { session: 'racing-main', revision: 1 }),
    error => error.code === 'BOARD_REVISION_CONFLICT' && error.currentRevision === 2);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
});

test('closed row takeover accepts new workers, handles other slots and records only the immediate predecessor', t => {
  const { file } = fixture(t); initBoard(file);
  const workers = [{ id: 'new-worker', kind: 'codex-exec', model: 'test-model', worktree: '/new', card: 'new-card', status: 'running', since: '2026-10-05T00:00:00.000Z' }];
  setOwnRow(file, 'main', { status: 'closed' }, { session: 'old-main', revision: 0 });
  setOwnRow(file, 'main', { workers, status: 'waiting' }, { session: 'new-main', revision: 1 });
  assert.deepEqual(readBoard(file).sessions[0].workers, workers);
  assert.equal(readBoard(file).sessions[0].status, 'waiting');
  setOwnRow(file, 'review', { status: 'closed', focus: 'old' }, { session: 'old-review', revision: 2 });
  setOwnRow(file, 'review', { next: 'new' }, { session: 'new-review', revision: 3 });
  let row = readBoard(file).sessions.find(item => item.slot === 'review');
  assert.equal(row.previousSessionId, 'old-review'); assert.equal(row.focus, null); assert.equal('workers' in row, false);
  setOwnRow(file, 'review', { status: 'closed' }, { session: 'new-review', revision: 4 });
  const now = new Date('2026-10-05T11:00:00.000Z');
  setOwnRow(file, 'review', {}, { session: 'third-review', revision: 5, now });
  row = readBoard(file).sessions.find(item => item.slot === 'review');
  assert.equal(row.previousSessionId, 'new-review'); assert.equal(row.takenOverAt, now.toISOString()); assert.equal(row.next, null);
});

test('the same session updating its closed row retains ordinary patch semantics', t => {
  const { file } = fixture(t); initBoard(file);
  setOwnRow(file, 'main', { status: 'closed', focus: 'keep' }, { session: 'main', revision: 0 });
  setOwnRow(file, 'main', { next: 'handoff' }, { session: 'main', revision: 1 });
  const row = readBoard(file).sessions[0];
  assert.equal(row.focus, 'keep'); assert.equal(row.status, 'closed'); assert.equal('previousSessionId' in row, false);
});

test('CLI set-own-row takes over a closed main through an isolated workspace and rejects the former main', t => {
  const { dir, file } = fixture(t); initBoard(file);
  setOwnRow(file, 'main', { status: 'closed', focus: 'old' }, { session: 'old-main', revision: 0 });
  const script = path.join(dir, 'board.mjs');
  fs.copyFileSync(new URL('./board.mjs', import.meta.url), script);
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ version: 1, board: 'process-board.json' }));
  const run = session => spawnSync(process.execPath, [script, 'set-own-row', 'main', '-', '--session', session, '--revision', String(readBoard(file).revision)],
    { cwd: dir, input: JSON.stringify({ name: 'New' }), encoding: 'utf8', timeout: 10_000 });
  const result = run('new-main');
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).revision, 2);
  const row = readBoard(file).sessions[0];
  assert.equal(row.sessionId, 'new-main'); assert.equal(row.previousSessionId, 'old-main'); assert.equal(row.focus, null);
  assert.equal(row.takenOverAt, row.updatedAt); assert.ok(Number.isFinite(Date.parse(row.takenOverAt)));
  const before = fs.readFileSync(file, 'utf8'), refused = run('old-main');
  assert.equal(refused.status, 1); assert.equal(JSON.parse(refused.stderr).error, 'BOARD_IDENTITY_MISMATCH');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
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

test('views show the real session identity of an assigned row (PB-R1): text and HTML carry sessionId and cwd, escaped', t => {
  const { file } = fixture(t); initBoard(file);
  setOwnRow(file, 'review', { name: 'Sol', cwd: '/home/x/<repo>', status: 'active' }, { session: '01a0ff56-c993-7de0-b3a3-d05c1bddd63b', revision: 0 });
  const board = readBoard(file);
  assert.ok(renderText(board).includes('01a0ff56-c993-7de0-b3a3-d05c1bddd63b'));
  const html = renderHtml(board);
  assert.ok(html.includes('01a0ff56-c993-7de0-b3a3-d05c1bddd63b')); assert.ok(html.includes('/home/x/&lt;repo&gt;')); assert.equal(html.includes('<repo>'), false);
});

test('a failed write after the temporary exists leaves no temporary, keeps the previous board bytes and releases the lock (PB-N1)', t => {
  const { dir, file } = fixture(t); initBoard(file);
  setOwnRow(file, 'main', { status: 'active' }, { session: 'm', revision: 0 });
  const before = fs.readFileSync(file, 'utf8');
  const origWrite = fs.writeFileSync; let armed = false;
  fs.writeFileSync = (...args) => { if (armed && typeof args[0] === 'number') { const e = new Error('EIO injected'); e.code = 'EIO'; throw e; } return origWrite(...args); };
  t.after(() => { fs.writeFileSync = origWrite; });
  armed = true;
  assert.throws(() => setOwnRow(file, 'main', { focus: 'x' }, { session: 'm', revision: 1 }), /EIO/);
  armed = false;
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('.tmp') || name.endsWith('.lock')), []);
  assert.equal(setOwnRow(file, 'main', { focus: 'after' }, { session: 'm', revision: 1 }).revision, 2);
});

test('the HTML view is written atomically and a failed publish leaves no temporary (PB-N1)', t => {
  const { dir, file } = fixture(t); initBoard(file);
  const out = path.join(dir, 'board.html');
  writeAtomic(out, '<p>a</p>', { create: true }); writeAtomic(out, '<p>b</p>');
  assert.equal(fs.readFileSync(out, 'utf8'), '<p>b</p>');
  const origRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error('EXDEV injected'); e.code = 'EXDEV'; throw e; };
  t.after(() => { fs.renameSync = origRename; });
  assert.throws(() => writeAtomic(out, '<p>c</p>'), /EXDEV/);
  assert.equal(fs.readFileSync(out, 'utf8'), '<p>b</p>');
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('.tmp')), []);
});

test('a failed rename after the temporary was written removes that temporary and keeps the board (PB-N1)', t => {
  const { dir, file } = fixture(t); initBoard(file);
  const before = fs.readFileSync(file, 'utf8');
  const origRename = fs.renameSync; let armed = true;
  fs.renameSync = (...args) => { if (armed && String(args[0]).includes('.tmp')) { const e = new Error('EXDEV injected'); e.code = 'EXDEV'; throw e; } return origRename(...args); };
  t.after(() => { fs.renameSync = origRename; });
  assert.throws(() => setOwnRow(file, 'main', { status: 'active' }, { session: 'm', revision: 0 }), /EXDEV/);
  armed = false;
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('.tmp') || name.endsWith('.lock')), []);
});

test('owner report renders the interactive owner panel (four sections, board-derived workers, copyable commands/places), escaped, with one fixed data-free script', t => {
  const { file } = fixture(t); initBoard(file);
  setOwnRow(file, 'main', { name: 'main', status: 'waiting', waitingOn: 'owner', next: 'alpha.4',
    workers: [{ id: 'codex-ci', kind: 'codex-exec', model: 'gpt-6.1-sol', worktree: '/w/ci', card: 'CI-FIX', status: 'review', since: new Date().toISOString() }] }, { session: 'm', revision: 0 });
  const body = { title: 'Owner raporu', headline: 'Parti push edildi <b>', impact: 'Run paralel.',
    flow: [{ label: 'Dün', text: 'Tasarım', who: 'owner' }, { label: 'Şimdi', text: 'Push', who: 'main' }],
    limits: ['CI kırmızı'], decisions: ['alpha.4 canlıya alınsın mı?'], next: { who: 'Main', text: 'alpha.4 hazırla' }, details: ['proof/X'],
    version: { live: 'alpha.4', n1: 'alpha.4', ci: 'kırmızı' }, commands: [{ label: 'Canlıya al', command: 'node x.mjs switch "a"' }],
    places: [{ label: 'Kanıt', path: '/proof/X', what: 'günlükler' }, { label: 'CI', path: 'https://github.com/o/r/actions', what: 'koşular' }] };
  const board = readBoard(file), html = renderOwnerReport(body, board, { now: new Date() });
  for (const part of ['Owner raporu', 'Senden beklenenler', 'Kim ne yapıyor', 'Akış ve sürüm', 'Nerede ne var', 'Açık sınır', 'Sıradaki adım · Main', 'Kanıt ve ayrıntı', 'Süreç panosu', 'codex-ci', 'İncelemede', 'gpt-6.1-sol'])
    assert.ok(html.includes(part), part);
  assert.ok(html.includes('&lt;b&gt;')); assert.equal(html.includes('<b>'), false);
  assert.ok(html.includes('data-copy="node x.mjs switch &quot;a&quot;"')); assert.ok(html.includes('data-copy="/proof/X"'));
  assert.ok(html.includes('href="https://github.com/o/r/actions"')); assert.equal(html.includes('href="/proof/X"'), false);
  const script = page => { const found = page.match(/<script>[\s\S]*?<\/script>/g) ?? []; assert.equal(found.length, 1); return found[0]; };
  const other = renderOwnerReport({ ...body, headline: 'başka', commands: [{ label: 'x', command: 'y' }] }, board, { now: new Date() });
  assert.equal(script(html), script(other)); assert.equal(script(html).includes('Parti'), false);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-/);
  assert.ok(html.indexOf('Dün') < html.indexOf('Şimdi'));
  assert.ok(renderOwnerReport({ ...body, version: undefined, commands: undefined, places: undefined }, board).includes('Senden beklenenler'));
  assert.throws(() => renderOwnerReport({ ...body, headline: '' }, board), /BOARD_REPORT/);
  assert.throws(() => renderOwnerReport({ ...body, flow: [] }, board), /BOARD_REPORT/);
  assert.throws(() => renderOwnerReport({ ...body, extra: 1 }, board), /BOARD_REPORT/);
  assert.throws(() => renderOwnerReport({ ...body, commands: [{ label: 'x' }] }, board), /BOARD_REPORT/);
  assert.throws(() => renderOwnerReport({ ...body, places: [{ label: 'x', path: 'javascript:alert(1)', what: 'y' }] }, board), /BOARD_REPORT/);
});

test('owner panel copy reports success only when a copy really happened; a refused or throwing fallback shows a manual-copy failure and cleans up (Sol 2290 R1)', async t => {
  const { file } = fixture(t); initBoard(file);
  const body = { title: 'T', headline: 'H', impact: 'I', flow: [{ label: 'a', text: 'b', who: 'c' }, { label: 'd', text: 'e', who: 'f' }],
    limits: [], decisions: [], next: { who: 'M', text: 'n' }, details: [], commands: [{ label: 'x', command: 'node run.mjs' }] };
  const source = renderOwnerReport(body, readBoard(file)).match(/<script>([\s\S]*?)<\/script>/)[1];
  async function click({ clipboard, exec }) {
    const toast = { hidden: true, textContent: '', className: '' }, areas = [];
    let handler; const document = {
      getElementById: id => (id === 'toast' ? toast : { textContent: '', className: '' }),
      addEventListener: (_type, fn) => { handler = fn; },
      createElement: () => { const area = { removed: false, select() {}, remove() { area.removed = true; } }; areas.push(area); return area; },
      execCommand: () => exec(), body: { dataset: { generated: new Date().toISOString() }, append() {} } };
    vm.runInNewContext(source, { document, navigator: { clipboard }, setTimeout: () => 0, clearTimeout() {}, setInterval() {}, Date });
    await handler({ target: { closest: () => ({ getAttribute: () => 'node run.mjs' }) } });
    return { toast, areas };
  }
  const native = await click({ clipboard: { writeText: async () => {} }, exec: () => assert.fail('no fallback') });
  assert.match(native.toast.textContent, /^Kopyalandı/); assert.equal(native.areas.length, 0);
  const fallback = await click({ clipboard: undefined, exec: () => true });
  assert.match(fallback.toast.textContent, /^Kopyalandı/); assert.ok(fallback.areas.every(area => area.removed));
  for (const exec of [() => false, () => { throw new Error('denied'); }]) {
    const failed = await click({ clipboard: { writeText: async () => { throw new Error('blocked'); } }, exec });
    assert.match(failed.toast.textContent, /^Kopyalanamadı/); assert.equal(failed.toast.className, 'bad');
    assert.equal(failed.areas.length, 1); assert.equal(failed.areas[0].removed, true);
  }
});
