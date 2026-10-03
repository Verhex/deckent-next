import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { append, dailyFile, parseStats, sample, idleStep } from './measure.mjs';

test('measurements go to one JSONL file per UTC day, private, never one growing file', t => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'measure-')), 'm'); t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const a = append(dir, { kind: 'note', tag: 'x' }, new Date('2026-10-03T23:59:59Z'));
  const b = append(dir, { kind: 'note', tag: 'x' }, new Date('2026-10-04T00:00:01Z'));
  assert.equal(path.basename(a), '2026-10-03.jsonl'); assert.equal(path.basename(b), '2026-10-04.jsonl');
  assert.equal(dailyFile(dir, new Date('2026-10-03T12:00:00Z')), a);
  assert.deepEqual(JSON.parse(fs.readFileSync(a, 'utf8')), { at: '2026-10-03T23:59:59.000Z', kind: 'note', tag: 'x' });
});
test('docker stats are reduced to Deckent workers only, with CPU percent and memory in MiB', () => {
  const lines = [JSON.stringify({ ID: 'aaaaaaaaaaaa', Name: 'deckent-1', CPUPerc: '87.5%', MemUsage: '812.3MiB / 2GiB' }),
    JSON.stringify({ ID: 'bbbbbbbbbbbb', Name: 'deckent-qwen38-vllm', CPUPerc: '300%', MemUsage: '4.1GiB / 60GiB' }), ''];
  assert.deepEqual(parseStats(lines, new Set(['aaaaaaaaaaaa'])), [{ name: 'deckent-1', cpuPct: 87.5, memMiB: 812 }]);
});

// POSIX mode bits are not private-ACL evidence on Windows; the positive variant is a typed not-run there (Sol 2294 R1).
test('measurement files are private (0600 file, 0700 directory)', { skip: process.platform === 'win32' && 'MEASURE_PRIVATE_MODE_UNSUPPORTED: POSIX mode bits are not Windows ACL proof' }, t => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'measure-')), 'm'); t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const file = append(dir, { kind: 'note' }, new Date('2026-10-03T00:00:00Z'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});
const fake = map => (cmd, args) => map[`${cmd} ${args[0]}`] ?? { ok: true, out: '' };
test('a failed or timed-out docker observation is recorded as unavailable, never as zero workers (Sol 2294 R2)', () => {
  const psDown = sample(null, fake({ 'docker ps': { ok: false, error: 'timeout' } })).record;
  assert.equal(psDown.observation.inventory, 'unavailable'); assert.equal(psDown.observation.inventoryError, 'timeout');
  assert.equal(psDown.workers, null); assert.equal(psDown.workerCpuPct, null); assert.equal(psDown.perWorker, null);
  const statsDown = sample(null, fake({ 'docker ps': { ok: true, out: 'aaaaaaaaaaaa\nbbbbbbbbbbbb\n' }, 'docker stats': { ok: false, error: 'EACCES' } })).record;
  assert.equal(statsDown.workers, 2); assert.equal(statsDown.observation.stats, 'unavailable'); assert.equal(statsDown.workerCpuPct, null); assert.equal(statsDown.perWorker, null);
  const empty = sample(null, fake({ 'docker ps': { ok: true, out: '' } })).record;
  assert.equal(empty.workers, 0); assert.equal(empty.observation.inventory, 'ok'); assert.equal(empty.observation.stats, 'not-needed'); assert.deepEqual(empty.perWorker, []);
  const back = sample(null, fake({ 'docker ps': { ok: true, out: 'aaaaaaaaaaaa\n' }, 'docker stats': { ok: true, out: JSON.stringify({ ID: 'aaaaaaaaaaaa', Name: 'deckent-1', CPUPerc: '50%', MemUsage: '100MiB / 2GiB' }) } })).record;
  assert.equal(back.workers, 1); assert.equal(back.workerCpuPct, 50);
});
test('idle-stop counts only a successful empty inventory after workers were seen (Sol 2294 R2)', () => {
  let s = { seen: false, idleSince: null, stop: false };
  s = idleStep(s, { workers: 0 }, 0, 60_000); assert.equal(s.stop, false); assert.equal(s.seen, false);
  s = idleStep(s, { workers: 3 }, 1_000, 60_000); assert.equal(s.seen, true);
  s = idleStep(s, { workers: null }, 100_000, 60_000); assert.equal(s.stop, false); assert.equal(s.idleSince, null);
  s = idleStep(s, { workers: 0 }, 200_000, 60_000); assert.equal(s.stop, false);
  s = idleStep(s, { workers: null }, 300_000, 60_000); assert.equal(s.stop, false);
  s = idleStep(s, { workers: 0 }, 260_001, 60_000); assert.equal(s.stop, true);
});
