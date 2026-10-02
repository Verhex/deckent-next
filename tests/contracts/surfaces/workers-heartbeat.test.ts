import { existsSync } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readWorkerSidecars } from '#adapters/index.js';
import type { WorkerObservation, WorkerSidecars } from '#engine/index.js';
import { renderWorkerRow } from '../../../src/surfaces/core/monitor/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'attempt1', generation: 1, layoutRevision: 'l' };
const worker = (files: WorkerSidecars | null, diagnostics: string[] = []): WorkerObservation => ({
  taskId: 't', identity, authority: 'next-ledger', provider: 'codex', workspace: null, process: 'running',
  handle: null, terminal: null, outputRecorded: false, patchRecorded: false, files, diagnostics,
});
const sidecars = (state: string, freshness: WorkerSidecars['heartbeat']['freshness'] = 'fresh'): WorkerSidecars => ({
  provider: 'codex', heartbeat: { state, freshness, ageMs: 0, phase: 'running' },
  log: { state: 'missing', byteLength: 0, truncated: false, sampledLines: 0, diagnostics: [], events: [] },
  result: { state: 'missing', exitCode: null, reportedAssessment: null }, pid: null, activity: null, usage: null, eventsTruncated: false,
});
const label = (w: WorkerObservation, locale: 'en' | 'tr') => renderWorkerRow(w, locale).split(' · heartbeat ')[1]!.split(' · ')[0];

it.each([
  ['identity-mismatch', 'identity-mismatch', 'kimlik uyuşmazlığı'],
  ['malformed', 'malformed', 'bozuk biçim'],
  ['too-large', 'too-large', 'çok büyük'],
  ['unavailable', 'unavailable (unknown)', 'erişilemiyor (bilinmiyor)'],
  ['future-state', 'state: future-state', 'durum: future-state'],
])('shows %s instead of fresh mtime for invalid heartbeat evidence', (state, en, tr) => {
  const w = worker(sidecars(state!));
  expect(label(w, 'en')).toBe(en); expect(label(w, 'tr')).toBe(tr);
  for (const locale of ['en', 'tr'] as const) expect(label(w, locale)).not.toMatch(/fresh|missing|güncel|eksik/);
});

it.each([
  ['output-denied', 'denied', 'erişim reddedildi'],
  ['custody-released', 'released', 'serbest bırakıldı'],
  ['info:ledger-only', 'ledger-only', 'yalnız kayıt'],
  ['observation-unavailable', 'unavailable (unknown)', 'erişilemiyor (bilinmiyor)'],
  ['activity-unavailable', 'unavailable (unknown)', 'erişilemiyor (bilinmiyor)'],
  ['unexpected-diagnostic', 'unavailable (unknown)', 'erişilemiyor (bilinmiyor)'],
  ['', 'unavailable (unknown)', 'erişilemiyor (bilinmiyor)'],
])('does not assert missing for null files with diagnostic %s', (diagnostic, en, tr) => {
  const w = worker(null, diagnostic ? ['process-unavailable', diagnostic] : []);
  expect(label(w, 'en')).toBe(en); expect(label(w, 'tr')).toBe(tr);
  for (const locale of ['en', 'tr'] as const) expect(label(w, locale)).not.toMatch(/fresh|missing|güncel|eksik/);
});

it('keeps genuine missing distinct, even with fresh metadata or denial diagnostics', () => {
  const w = worker(sidecars('missing'), ['output-denied']);
  expect(label(w, 'en')).toBe('missing'); expect(label(w, 'tr')).toBe('eksik');
});
it.each([
  ['fresh', 'güncel'], ['stale', 'eski'], ['future', 'gelecek tarihli'], ['unknown', 'bilinmiyor'],
] as const)('retains available %s freshness and the rest of the row', (freshness, tr) => {
  const w = worker(sidecars('available', freshness), ['output-denied']);
  expect(renderWorkerRow(w, 'en')).toBe(`  r/t · attempt attempt1 · gen 1 · running · heartbeat ${freshness} · codex`);
  expect(label(w, 'tr')).toBe(tr);
});

it.skipIf(process.platform !== 'linux' || !existsSync('/proc/self/fd'))('[requires Linux /proc/self/fd observation custody] carries fresh wrong-attempt and malformed sidecars through the reader into the human row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-heartbeat-row-')); roots.push(root);
  const hb = join(root, 'worker.hb'), now = 1_800_000_000_000;
  for (const [content, state] of [
    [JSON.stringify({ identity: { ...identity, attemptId: 'other' }, process: 'running' }), 'identity-mismatch'],
    ['{broken', 'malformed'],
  ]) {
    await writeFile(hb, content!, { mode: 0o600 }); await utimes(hb, new Date(now), new Date(now));
    const files = await readWorkerSidecars(root, 'worker', { maxFileBytes: 4096, maxEntries: 64, staleMs: 1000 }, now, identity);
    expect(files.heartbeat).toMatchObject({ state, freshness: 'fresh' });
    expect(label(worker(files), 'en')).toBe(state);
  }
});
