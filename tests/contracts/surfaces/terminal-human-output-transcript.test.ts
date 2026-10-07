import { describe, expect, it } from 'vitest';
import type { Locale } from '#platform/index.js';
import type { WorkerObservationReport } from '#engine/index.js';
import { runLedgerCommand, TRANSCRIPT_PAGE_LINES } from '#surfaces/core/terminal-work/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';

// TUI2 L3: /transcript shows the newest lines first and says where the earlier ones are; the headline carries short identities, the details line the full ones.
const ATTEMPT = '5d3c1b2a-9e8f-4a7b-8c6d-0e1f2a3b4c5d', TASK = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const report = { schemaVersion: 1, observedAt: 1, scopeId: 's', control: 'observe-only', sources: [{ workers: [
  { taskId: TASK, identity: { scopeId: 's', runId: 'r', taskId: TASK, attemptId: ATTEMPT, generation: 1, layoutRevision: 'l' }, provider: 'claude', process: 'running', authority: 'next-ledger', files: null }] }] } as unknown as WorkerObservationReport;
const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');
const ledger = (count: number) => ({ scopeId: 's', async listWorkers() { return report; }, async inspectRun() { return null; }, async inspectTranscript() { return lines(count); } });
const labelsFor = (locale: Locale) => ({ work: workSurfaceLabels(locale) }) as never;
const show = async (locale: Locale, args: string, count = 100) => (await runLedgerCommand('transcript', args, ledger(count) as never, labelsFor(locale)))[0] as { level: string; text: string };

describe('/transcript paging', () => {
  it('EN page 1 is the newest 40 lines with the way to the earlier ones', async () => {
    const entry = await show('en', '1');
    expect(entry.level).toBe('info');
    expect(entry.text.split('\n')).toEqual([`Transcript · worker 1 · task a1b2c3d4 · attempt 5d3c1b2a`, `Details: task ${TASK} · attempt ${ATTEMPT}`,
      ...Array.from({ length: TRANSCRIPT_PAGE_LINES }, (_, index) => `line ${61 + index}`), 'Lines 61–100 of 100 (page 1 of 3). Earlier lines: /transcript 1 2']);
  });
  it('TR page 3 is the start of the transcript', async () => {
    const entry = await show('tr', '1 3');
    const rows = entry.text.split('\n');
    expect(rows.slice(0, 2)).toEqual(['Döküm · işçi 1 · görev a1b2c3d4 · deneme 5d3c1b2a', `Ayrıntı: görev ${TASK} · deneme ${ATTEMPT}`]);
    expect(rows.slice(2)).toEqual([...Array.from({ length: 20 }, (_, index) => `line ${index + 1}`), 'Satır 1–20 / 100 (sayfa 3/3): dökümün başı.']);
  });
  it('a short transcript is shown whole and a page past the end says how many pages there are', async () => {
    expect((await show('en', '1', 10)).text.endsWith('line 10')).toBe(true);
    const range = await show('tr', '1 9');
    expect(range).toMatchObject({ level: 'error', text: 'Bu dökümde yalnız 3 sayfa var: /transcript 1 1 en yeni satırları gösterir.' });
  });
  it('the headline carries no raw UUID', async () => {
    for (const locale of ['en', 'tr'] as const) expect((await show(locale, '1')).text.split('\n')[0]).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/iu);
  });
  it('rejects a malformed page', async () => {
    expect((await show('en', '1 zero')).level).toBe('error');
    expect((await show('en', '1 2 3')).text).toContain('Usage: /transcript');
  });
});
