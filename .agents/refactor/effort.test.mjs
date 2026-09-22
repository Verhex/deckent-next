import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { record, summarize, report, events, table, validateConfig, KINDS } from './effort.mjs';

const config = { schemaVersion: 1, journalRoot: 'unused', longIntervalMinutes: 60, reportLimit: 100 };
const revision = () => 'fixture-rev';
const T = m => `2026-09-22T${String(8 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00Z`;
async function sandbox(fn) {
  const root = await mkdtemp(join(tmpdir(), 'effort-test-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const start = (root, id, at, extra = {}) => record(root, id, 'start', { milestone: 'M1', title: 'Fixture slice', actor: 'test', kind: 'active', at, ...extra }, T(600), revision);

test('explicit events account active/blocked/verification/rework; pause is unknown, never active', () => sandbox(async root => {
  const id = 'A02-fixture';
  await start(root, id, T(0));
  await record(root, id, 'phase', { kind: 'blocked', reason: 'owner-decision', at: T(30) }, T(600), revision);
  await record(root, id, 'phase', { kind: 'active', at: T(45) }, T(600), revision);
  await record(root, id, 'pause', { at: T(60), note: 'session ended' }, T(600), revision);
  await record(root, id, 'phase', { kind: 'verification', at: T(120), evidenceRefs: ['verify.log'] }, T(600), revision);
  await record(root, id, 'phase', { kind: 'rework', at: T(130) }, T(600), revision);
  await record(root, id, 'end', { status: 'done', at: T(140) }, T(600), revision);
  const s = summarize(await events(root, id), config, T(600));
  assert.deepEqual(s.observedMs, { active: 45 * 60_000, blocked: 15 * 60_000, verification: 10 * 60_000, rework: 10 * 60_000 });
  assert.deepEqual(s.blockedReasons, { 'owner-decision': 15 * 60_000 });
  assert.equal(s.unknownMs, 60 * 60_000);
  assert.deepEqual(s.unknownGaps, [{ from: T(60), to: T(120), ms: 60 * 60_000, open: false }]);
  assert.equal(s.status, 'done'); assert.equal(s.openSinceMs, null); assert.equal(s.endedAt, T(140));
  assert.equal(s.card, 'A02'); assert.equal(s.operatorSuppliedTimestamps, 7); assert.deepEqual(s.evidenceRefs, ['verify.log']);
  assert.equal(s.revisionAtStart, 'fixture-rev');
  const files = await readdir(join(root, id));
  assert.deepEqual(files.sort(), ['0001-start.json', '0002-phase.json', '0003-phase.json', '0004-pause.json', '0005-phase.json', '0006-phase.json', '0007-end.json']);
  for (const f of files) assert.equal((await stat(join(root, id, f))).mode & 0o077, 0);
}));

test('open tail is reported separately, not counted; paused open tail is an open unknown gap; long intervals flagged without reaccounting', () => sandbox(async root => {
  await start(root, 'B05-open', T(0));
  await record(root, 'B05-open', 'phase', { kind: 'active', at: T(100) }, T(600), revision);
  let s = summarize(await events(root, 'B05-open'), config, T(160));
  assert.equal(s.status, 'active'); assert.equal(s.observedMs.active, 100 * 60_000); assert.equal(s.openSinceMs, 60 * 60_000);
  assert.equal(s.longIntervals.length, 1); assert.equal(s.longIntervals[0].ms, 100 * 60_000); assert.equal(s.endedAt, null);
  await record(root, 'B05-open', 'pause', { at: T(170) }, T(600), revision);
  s = summarize(await events(root, 'B05-open'), config, T(200));
  assert.equal(s.status, 'paused'); assert.equal(s.openSinceMs, null);
  assert.deepEqual(s.unknownGaps.at(-1), { from: T(170), to: null, ms: null, open: true }); assert.equal(s.unknownMs, 0);
}));

test('rejections: ids, enum values, monotonic and future timestamps, lifecycle order', () => sandbox(async root => {
  await assert.rejects(start(root, 'Z99-bad', T(0)), /EFFORT_SLICE_ID/);
  await assert.rejects(start(root, 'A02-Bad', T(0)), /EFFORT_SLICE_ID/);
  await assert.rejects(record(root, 'A02-x', 'phase', { kind: 'active', at: T(0) }, T(600), revision), /EFFORT_NOT_STARTED/);
  await assert.rejects(record(root, 'A02-x', 'start', { milestone: 'M6', title: 't', actor: 'a', at: T(0) }, T(600), revision), /EFFORT_START/);
  await start(root, 'A02-x', T(10));
  await assert.rejects(start(root, 'A02-x', T(11)), /EFFORT_ALREADY_STARTED/);
  await assert.rejects(record(root, 'A02-x', 'phase', { kind: 'waiting', at: T(20) }, T(600), revision), /EFFORT_KIND/);
  await assert.rejects(record(root, 'A02-x', 'phase', { kind: 'blocked', at: T(20) }, T(600), revision), /EFFORT_BLOCKED_REASON/);
  await assert.rejects(record(root, 'A02-x', 'phase', { kind: 'active', reason: 'other', at: T(20) }, T(600), revision), /EFFORT_BLOCKED_REASON/);
  await assert.rejects(record(root, 'A02-x', 'phase', { kind: 'active', at: T(5) }, T(600), revision), /EFFORT_NOT_MONOTONIC/);
  await assert.rejects(record(root, 'A02-x', 'phase', { kind: 'active', at: T(700) }, T(600), revision), /EFFORT_AT_FUTURE/);
  await assert.rejects(record(root, 'A02-x', 'phase', { kind: 'active', at: '2026-02-30T00:00:00Z' }, T(600), revision), /EFFORT_AT/);
  await record(root, 'A02-x', 'pause', { at: T(20) }, T(600), revision);
  await assert.rejects(record(root, 'A02-x', 'pause', { at: T(21) }, T(600), revision), /EFFORT_ALREADY_PAUSED/);
  await assert.rejects(record(root, 'A02-x', 'end', { status: 'finished', at: T(30) }, T(600), revision), /EFFORT_END_STATUS/);
  await record(root, 'A02-x', 'end', { status: 'handed-off', at: T(30) }, T(600), revision);
  await assert.rejects(record(root, 'A02-x', 'phase', { kind: 'active', at: T(40) }, T(600), revision), /EFFORT_ENDED/);
  await assert.rejects(record(root, 'A02-x', 'end', { status: 'done', at: T(40) }, T(600), revision), /EFFORT_ENDED/);
  await assert.rejects(record(root, 'A02-y', 'start', { milestone: 'M1', title: 't', actor: 'a', note: '-----BEGIN PRIVATE KEY-----', at: T(0) }, T(600), revision), /JEV_SECRET_IN_JOURNAL/);
  assert.throws(() => validateConfig({ ...config, longIntervalMinutes: 0 }), /EFFORT_CONFIG/);
}));

test('clock timestamps are recorded as clock source; a tampered sequence is refused', () => sandbox(async root => {
  const ev = await record(root, 'C10-clock', 'start', { milestone: 'M2', title: 't', actor: 'a' }, T(50), revision);
  assert.equal(ev.at, T(50)); assert.equal(ev.atSource, 'clock'); assert.equal(ev.kind, null);
  const s = summarize(await events(root, 'C10-clock'), config, T(60));
  assert.equal(s.status, 'started'); assert.equal(s.openSinceMs, null); assert.deepEqual(s.unknownGaps, [{ from: T(50), to: null, ms: null, open: true }]);
  await writeFile(join(root, 'C10-clock', '0003-phase.json'), JSON.stringify({ ...ev, sequence: 3, type: 'phase', kind: 'active' }), { mode: 0o600 });
  await assert.rejects(events(root, 'C10-clock'), /EFFORT_SEQUENCE_GAP/);
}));

test('report aggregates observed and unknown time per milestone, filters, and never derives effort from commits', () => sandbox(async root => {
  await start(root, 'A02-one', T(0)); await record(root, 'A02-one', 'end', { status: 'done', at: T(30) }, T(600), revision);
  await start(root, 'A02-two', T(0), { milestone: 'M2' }); await record(root, 'A02-two', 'pause', { at: T(10) }, T(600), revision);
  await record(root, 'A02-two', 'phase', { kind: 'verification', at: T(40) }, T(600), revision);
  const r = await report(root, config, {}, T(50));
  assert.equal(r.slices.length, 2);
  assert.deepEqual(r.milestones.M1, { slices: 1, ended: 1, observedMs: { active: 30 * 60_000, blocked: 0, verification: 0, rework: 0 }, unknownMs: 0, openSlices: 0 });
  assert.deepEqual(r.milestones.M2, { slices: 1, ended: 0, observedMs: { active: 10 * 60_000, blocked: 0, verification: 0, rework: 0 }, unknownMs: 30 * 60_000, openSlices: 1 });
  assert.match(r.basis, /commit counts are not effort/); assert.equal(JSON.stringify(r).includes('"commits"'), false);
  const only = await report(root, config, { milestone: 'M2' }, T(50));
  assert.deepEqual(only.slices.map(s => s.sliceId), ['A02-two']);
  const text = table(r);
  assert.match(text, /A02-one\s+M1\s+done\s+0\.50/); assert.match(text, /A02-two\s+M2\s+verification/); assert.match(text, /unknown_h/);
  assert.equal(Object.keys(r.milestones.M1.observedMs).length, KINDS.length);
}));

test('CLI records through a configured private root and reports usage errors as codes', () => sandbox(async root => {
  const script = fileURLToPath(new URL('./effort.mjs', import.meta.url));
  const configPath = join(root, 'effort.config.json');
  await writeFile(configPath, JSON.stringify({ ...config, journalRoot: './journal' }));
  const env = { ...process.env, DECKENT_EFFORT_CONFIG: configPath };
  const run = args => JSON.parse(execFileSync('node', [script, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const started = run(['start', 'A02-cli', '--milestone', 'M1', '--title', 'CLI fixture', '--actor', 'test', '--kind', 'active', '--evidence', 'ref-1']);
  assert.equal(started.sequence, 1); assert.equal(started.atSource, 'clock'); assert.deepEqual(started.evidenceRefs, ['ref-1']);
  assert.equal((await stat(join(root, 'journal'))).mode & 0o077, 0);
  run(['phase', 'A02-cli', 'blocked', '--reason', 'quota']);
  assert.equal(run(['status', 'A02-cli']).status, 'blocked');
  assert.equal(run(['report']).slices.length, 1);
  assert.match(execFileSync('node', [script, 'report', '--format', 'table'], { env, encoding: 'utf8' }), /A02-cli\s+M1\s+blocked/);
  for (const bad of [['phase', 'A02-cli'], ['end', 'A02-cli', 'done', 'extra'], ['start'], ['status']]) {
    assert.throws(() => run(bad), e => /EFFORT_USAGE/.test(String(e.stderr)));
  }
  assert.throws(() => run(['phase', 'A02-cli', 'blocked', '--reason', 'weather']), e => /EFFORT_BLOCKED_REASON/.test(String(e.stderr)));
}));
