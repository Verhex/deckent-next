import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { append, dailyFile, parseStats } from './measure.mjs';

test('measurements go to one JSONL file per UTC day, private, never one growing file', t => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'measure-')), 'm'); t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const a = append(dir, { kind: 'note', tag: 'x' }, new Date('2026-10-03T23:59:59Z'));
  const b = append(dir, { kind: 'note', tag: 'x' }, new Date('2026-10-04T00:00:01Z'));
  assert.equal(path.basename(a), '2026-10-03.jsonl'); assert.equal(path.basename(b), '2026-10-04.jsonl');
  assert.equal(dailyFile(dir, new Date('2026-10-03T12:00:00Z')), a);
  assert.equal(fs.statSync(a).mode & 0o777, 0o600); assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(a, 'utf8')), { at: '2026-10-03T23:59:59.000Z', kind: 'note', tag: 'x' });
});
test('docker stats are reduced to Deckent workers only, with CPU percent and memory in MiB', () => {
  const lines = [JSON.stringify({ ID: 'aaaaaaaaaaaa', Name: 'deckent-1', CPUPerc: '87.5%', MemUsage: '812.3MiB / 2GiB' }),
    JSON.stringify({ ID: 'bbbbbbbbbbbb', Name: 'deckent-qwen38-vllm', CPUPerc: '300%', MemUsage: '4.1GiB / 60GiB' }), ''];
  assert.deepEqual(parseStats(lines, new Set(['aaaaaaaaaaaa'])), [{ name: 'deckent-1', cpuPct: 87.5, memMiB: 812 }]);
});
