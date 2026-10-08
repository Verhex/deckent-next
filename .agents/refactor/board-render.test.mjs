import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { renderBoardPage, ownerActions, filterCounts, readReviews, readDecisions, collectSources, BOARD_STYLE, FILTER_HASH } from './board-render.mjs';

const now = new Date('2026-10-09T12:00:00.000Z');
const worker = (id, status, extra = {}) => ({ id, kind: 'codex-exec', model: 'gpt-6.1-sol', worktree: `${os.homedir()}/wt-${id}`, card: `Kart ${id}`, status, since: '2026-10-09T11:00:00.000Z', ...extra });
const row = (slot, extra = {}) => ({ slot, role: slot, name: null, sessionId: null, channel: null, cwd: null, workRef: null, focus: null, status: 'unassigned', waitingOn: null, next: null, updatedAt: null, ...extra });
const board = (extra = {}, workers = []) => ({ schemaVersion: 1, revision: 7, updatedAt: '2026-10-09T11:50:00.000Z', dogfood: { mode: 'OFF', source: 'AGENTS.md', observedAt: '2026-10-09T11:00:00.000Z' },
  sessions: [row('main', { name: 'Ana', status: 'active', sessionId: 's', workers, ...extra }), row('review')] });
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'br-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('owner callout comes only from owner/sahip mentions in waitingOn/next; hidden when there are none', () => {
  assert.equal(renderBoardPage(board({ next: 'build the thing', waitingOn: 'CI' }), {}, { now }).includes('Sahip eylemi gerekiyor'), false);
  const items = ownerActions(board({ waitingOn: 'CI', next: 'S1 → owner DOGFOOD kararı; W2 hatları; Sahip onayı: repo adı' }));
  assert.deepEqual(items.map(i => i.title), ['S1 → owner DOGFOOD kararı', 'Sahip onayı: repo adı']);
  assert.equal(items[0].dogfood, true);
  const html = renderBoardPage(board({ next: 'owner karar ver' }), {}, { now });
  assert.match(html, /Sahip eylemi gerekiyor/); assert.match(html, /1 kayıt/);
});

test('a pending DOGFOOD decision is derived from the main row text only while DOGFOOD is OFF; a closed/unassigned row never raises it', () => {
  const text = 'Beta pazar. DOGFOOD şartı: S1 + owner kararı.';
  assert.equal(ownerActions(board({ focus: text })).filter(i => i.dogfood).length, 1);
  assert.equal(ownerActions({ ...board({ focus: text }), dogfood: { mode: 'ON', source: 's', observedAt: now.toISOString() } }).length, 0);
  assert.equal(ownerActions(board({ status: 'closed', next: 'owner karar' })).length, 0);
  assert.equal(ownerActions(board({ focus: 'DOGFOOD durumu' })).length, 0);
});

test('filter counts come from worker data and the chips are real, keyboard-reachable buttons', () => {
  const ws = [worker('a', 'running'), worker('b', 'running'), worker('c', 'review'), worker('d', 'landed'), worker('e', 'failed')];
  assert.deepEqual(filterCounts(ws), { all: 5, running: 2, review: 1, landed: 1 });
  const html = renderBoardPage(board({}, ws), {}, { now });
  for (const label of ['Tümü (5)', 'Çalışıyor (2)', 'İncelemede (1)', 'İndi (1)']) assert.ok(html.includes(label), label);
  assert.match(html, /<button type="button" data-filter="all" aria-pressed="true"/);
  assert.equal([...html.matchAll(/<tr data-state=/g)].length, 5);
  assert.match(html, /~\/wt-a/); assert.match(html, /<small class="mono">a<\/small>/);
});

test('the inline script filters rows, updates pressed state and counts, and reports an empty selection', () => {
  const ws = [worker('a', 'running'), worker('b', 'review'), worker('c', 'landed')];
  const html = renderBoardPage(board({}, ws), {}, { now });
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  assert.equal(crypto.createHash('sha256').update(script).digest('base64'), FILTER_HASH);
  assert.ok(html.includes(`script-src 'sha256-${FILTER_HASH}'`));
  const mk = attrs => { const el = { hidden: false, textContent: '', attrs: { ...attrs }, listeners: {}, getAttribute: k => el.attrs[k], setAttribute: (k, v) => { el.attrs[k] = v; }, addEventListener: (k, f) => { el.listeners[k] = f; }, focus() {} }; return el; };
  const rows = ws.map(w => mk({ 'data-state': w.status })), btns = ['all', 'running', 'review', 'landed'].map(k => mk({ 'data-filter': k, 'aria-pressed': String(k === 'all') }));
  const out = mk({}), empty = mk({}), age = mk({}); empty.hidden = true;
  const document = { querySelectorAll: s => (s === '#lane-rows tr' ? rows : btns), getElementById: id => ({ 'filter-result': out, 'filter-empty': empty, age }[id]), body: { dataset: { updated: '2026-10-09T11:50:00.000Z' } } };
  vm.runInNewContext(script, { document, Date, Number, Math, setInterval: () => 0 });
  btns[1].listeners.click();
  assert.deepEqual(rows.map(r => r.hidden), [false, true, true]); assert.equal(out.textContent, '1 kayıt gösteriliyor');
  assert.equal(btns[1].attrs['aria-pressed'], 'true'); assert.equal(btns[0].attrs['aria-pressed'], 'false');
  btns[0].listeners.click(); assert.deepEqual(rows.map(r => r.hidden), [false, false, false]);
  btns[2].listeners.click(); assert.equal(empty.hidden, true); btns[3].listeners.click(); assert.equal(empty.hidden, true);
  rows.forEach(r => { r.attrs['data-state'] = 'failed'; }); btns[1].listeners.click(); assert.equal(empty.hidden, false); assert.equal(out.textContent, '0 kayıt gösteriliyor');
});

test('missing sources render "veri yok" and never throw; a missing file reports an unreadable source', t => {
  const html = renderBoardPage(board(), {}, { now });
  assert.ok((html.match(/veri yok/g) ?? []).length >= 4);
  assert.match(html, /Kuyruk|kanal dosyası okunamadı/); assert.doesNotMatch(html, /undefined|NaN|\[object/);
  const d = tmp(t);
  const sources = collectSources({ channelFile: path.join(d, 'nope.md'), journalRoot: path.join(d, 'nojev'), projectRoot: path.join(d, 'noproj') });
  assert.deepEqual(sources, { reviews: null, decisions: null, release: null });
  assert.doesNotThrow(() => renderBoardPage(board(), sources, { now }));
  assert.match(renderBoardPage(board(), { reviews: [], decisions: [] }, { now }), /Kuyruk boş[\s\S]*Kayıtlı karar yok/);
});

test('DOGFOOD OFF is an informational state, not an error tone', () => {
  const html = renderBoardPage(board(), {}, { now });
  assert.match(html, /<div class="vcard tone-info"><span class="vl">DOGFOOD<\/span><strong>KAPALI<\/strong>/);
  assert.match(renderBoardPage({ ...board(), dogfood: { mode: 'ON', source: 'x', observedAt: now.toISOString() } }, {}, { now }), /vcard tone-warn"><span class="vl">DOGFOOD/);
});

test('release strip shows only the supplied dev-release fields', () => {
  const v = { id: 'a-b', commit: '94a8d0898d82aaaaaaaaaaaaaaaaaaaaaaaaaaaa', version: '1.0.0-alpha.18', ledger: 49, protocol: 25 };
  const html = renderBoardPage(board(), { release: { current: v, previous: null } }, { now });
  assert.match(html, /1\.0\.0-alpha\.18/); assert.match(html, /commit 94a8d089</); assert.match(html, /Ledger şeması<\/span><strong>49/); assert.match(html, /Protokol<\/span><strong>25/);
  assert.match(html, /Önceki sürüm<\/span><strong><span class="m">veri yok/);
});

const entry = (seq, from, to, body, at) => {
  const h = crypto.createHash('sha256').update(body).digest('hex');
  return `\n## ENTRY ${seq} · from=${from} · to=${to} · at=${at} · sha256=${h}\n<!-- body:start seq=${seq} -->\n${body}<!-- body:end seq=${seq} -->\n`;
};
test('review queue pairs REQUEST_REVIEW with its REVIEW, shows verdict and P-counts, and pending when unanswered', t => {
  const d = tmp(t), file = path.join(d, 'c.md');
  const req = 'REQUEST_REVIEW Kart X paketi\ndetay\n', hash = crypto.createHash('sha256').update(req).digest('hex').slice(0, 12);
  const rev = `REVIEW re=3001:${hash}\nREVISE — iki bulgu\n1. P1: a.mjs:1 x\n2. P2: b.mjs:2 y\n`;
  fs.writeFileSync(file, '# c\n<!-- channel next-seq=3004 -->\n' + entry(3001, 'opus', 'astra', req, '2026-10-09T10:00:00.000Z') + entry(3002, 'astra', 'opus', rev, '2026-10-09T10:30:00.000Z')
    + entry(3003, 'opus', 'astra', 'REQUEST_REVIEW <b>Kart Y</b>\n', '2026-10-09T11:00:00.000Z'));
  const items = readReviews(file, 2000);
  assert.deepEqual(items.map(i => [i.seq, i.pending, i.verdict]), [[3003, true, null], [3001, false, 'REVISE']]);
  assert.deepEqual(items[1].findings, { P0: 0, P1: 1, P2: 1 });
  const html = renderBoardPage(board(), { reviews: items }, { now });
  assert.match(html, /REVISE/); assert.match(html, /P1 1 · P2 1/); assert.match(html, /Bekliyor/); assert.ok(html.includes('&lt;b&gt;Kart Y&lt;/b&gt;'));
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Kart X paketi', 'tampered')); // digest mismatch: the whole source is unreadable, not half-trusted
  assert.equal(readReviews(file, 2000), null);
});

test('decision feed reads the Jev journal newest first with scores and actor kind; malformed records are skipped', t => {
  const root = tmp(t), id = n => `0000000${n}-0000-4000-8000-000000000000`;
  const put = (n, at, actor, selected, p, suff) => { const dir = path.join(root, id(n)); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'decision.json'), JSON.stringify({ at, actor, selectedOption: selected }));
    fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ case: { objective: `Soru <i>${n}</i>` } }));
    fs.writeFileSync(path.join(dir, 'response.json'), JSON.stringify({ answers: { next_action: { probabilities: { [selected]: p }, confidence: 0.1 }, sufficiency: { noul: suff } } })); };
  put(1, '2026-10-08T10:00:00.000Z', 'owner (AskUser)', 'a', 0.97, 0.8); put(2, '2026-10-09T10:00:00.000Z', 'opus', 'b', 1, 0.75);
  fs.mkdirSync(path.join(root, id(3))); fs.writeFileSync(path.join(root, id(3), 'decision.json'), '{bad'); fs.mkdirSync(path.join(root, 'not-a-call'));
  const items = readDecisions(root);
  assert.deepEqual(items.map(i => [i.selected, i.choice, i.sufficiency]), [['b', 1, 0.75], ['a', 0.97, 0.8]]);
  const html = renderBoardPage(board(), { decisions: items }, { now });
  assert.match(html, /seçim 0,97 · yeterlilik 0,80/); assert.match(html, /Sahip<\/span>[\s\S]*Lead \/ ajan|Lead \/ ajan[\s\S]*Sahip/); assert.ok(html.includes('Soru &lt;i&gt;1&lt;/i&gt;'));
  assert.equal(readDecisions(root, 1).length, 1);
});

test('every untrusted string is escaped in text and attributes', () => {
  const evil = '"><img src=x onerror=alert(1)>', ws = [worker('<s>', 'running', { card: evil, model: evil, worktree: evil })];
  const html = renderBoardPage(board({ name: evil, focus: evil, waitingOn: evil, next: `owner ${evil}`, channel: evil, workRef: evil }, ws), { reviews: [{ seq: 1, at: now.toISOString(), title: evil, pending: true }],
    decisions: [{ id: 'a'.repeat(36), at: now.toISOString(), actor: evil, selected: evil, title: evil, choice: 1, sufficiency: 1 }], release: { current: { id: evil, commit: 'a'.repeat(40), version: evil, ledger: evil, protocol: evil }, previous: null } }, { now });
  assert.doesNotMatch(html, /<img|<s>|<b>|<i>/); assert.ok(html.includes("&lt;img src=x onerror"));
  assert.equal([...html.matchAll(/<script/g)].length, 1);
});

test('declared tokens meet 4.5:1 in light and dark; focus, forced-colors and narrow reflow rules exist; no network references', () => {
  const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const blocks = [/:root\{color-scheme[^}]*\}/.exec(BOARD_STYLE)[0], /prefers-color-scheme:dark\)\{:root\{([^}]*)\}/.exec(BOARD_STYLE)[1]];
  for (const block of blocks) {
    const v = Object.fromEntries([...block.matchAll(/--([a-z]+):(#[0-9a-f]{6})/g)].map(m => [m[1], m[2]]));
    for (const [fg, bg] of [['fg', 'bg'], ['fg', 'card'], ['mute', 'bg'], ['mute', 'card'], ['mute', 'neutralbg'], ['info', 'card'], ['info', 'infobg'], ['warn', 'warnbg'], ['fail', 'failbg'], ['ok', 'okbg'], ['neutral', 'neutralbg'], ['warn', 'card']]) assert.ok(ratio(v[fg], v[bg]) >= 4.5, `${fg}/${bg}`);
  }
  assert.match(BOARD_STYLE, /:focus-visible/); assert.match(BOARD_STYLE, /forced-colors:active/); assert.match(BOARD_STYLE, /max-width:640px/);
  assert.doesNotMatch(renderBoardPage(board(), {}, { now }), /https?:\/\/|@import|<link|src=/);
});

test('CLI render keeps its contract and succeeds with every optional source missing', async t => {
  const { spawnSync } = await import('node:child_process');
  const dir = tmp(t), here = new URL('.', import.meta.url);
  for (const f of ['board.mjs', 'board-render.mjs', 'channel.mjs']) fs.copyFileSync(new URL(f, here), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ version: 1, board: 'b.json', channel: 'missing.md', productRoot: 'noproject' }));
  const run = (...args) => spawnSync(process.execPath, [path.join(dir, 'board.mjs'), ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  assert.equal(run('init').status, 0);
  const out = path.join(dir, 'out.html'), result = run('render', '--out', out);
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.written, out); assert.equal(info.bytes, fs.statSync(out).size);
  assert.match(fs.readFileSync(out, 'utf8'), /veri yok/);
});
