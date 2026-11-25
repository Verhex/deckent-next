import { describe, expect, it, vi } from 'vitest';
import type { Locale } from '#platform/index.js';
import type { WorkerObservationReport } from '#engine/index.js';
import { runLedgerCommand, TRANSCRIPT_PAGE_LINES } from '#surfaces/core/terminal-work/index.js';
import { fillTemplate, type WorkerAttemptIdentity } from '#surfaces/core/terminal-ledger/index.js';
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
    const { ports, observe } = workerSession();
    const legacy = { ...workerA, taskId: 'legacy-1', identity: null, authority: 'legacy-activity' } as const;
    observe(workerA, workerD, workerC, legacy);
    const inspectTranscript = vi.fn<typeof ports.inspectTranscript>(async () => lines(100));
    const pagingPorts = { ...ports, inspectTranscript };
    const [entry] = await runLedgerCommand('transcript', '1', pagingPorts, labelsFor('en'));
    if (entry?.kind !== 'notice') throw new Error('Expected transcript notice');
    expect(entry.level).toBe('info');
    expect(entry.text.split('\n')).toEqual([`Transcript · worker 1 · task a1b2c3d4 · attempt 5d3c1b2a`, `Details: task ${TASK} · attempt ${ATTEMPT}`,
      ...Array.from({ length: TRANSCRIPT_PAGE_LINES }, (_, index) => `line ${61 + index}`), 'Lines 61–100 of 100 (page 1 of 3). Earlier lines: /transcript 1 2']);
    expect(await runLedgerCommand('transcript', '3', pagingPorts, labelsFor('en'))).toMatchObject([
      { level: 'info', text: expect.stringContaining('Transcript · worker 3 · task a1b2c3d4 · attempt 7d3c1b2a') },
    ]);
    observe(workerB, workerA);
    expect(await runLedgerCommand('transcript', '1 2', pagingPorts, labelsFor('en'))).toMatchObject([
      { level: 'info', text: expect.stringContaining(`Details: task ${TASK} · attempt ${ATTEMPT}`) },
    ]);
    observe(workerA, workerB, workerC, legacy);
    expect(await runLedgerCommand('transcript', '4', pagingPorts, labelsFor('tr'))).toMatchObject([
      { level: 'error', text: 'İşçi 4 için deneme kimliği yok (eski kaynak); mühürlü döküm bulunmaz.' },
    ]);
    observe(workerA, workerB, workerC, workerD);
    expect(await runLedgerCommand('transcript', '2', pagingPorts, labelsFor('en'))).toMatchObject([
      { level: 'info', text: expect.stringContaining('Transcript · worker 2 · task a1b2c3d4 · attempt 6d3c1b2a') },
    ]);
    expect(await runLedgerCommand('transcript', '4', pagingPorts, labelsFor('tr'))).toMatchObject([
      { level: 'info', text: expect.stringContaining('Döküm · işçi 4 · görev a1b2c3d4 · deneme 8d3c1b2a') },
    ]);
    observe(workerA, { ...workerB, identity: { ...workerB.identity, generation: 3 } });
    expect(await runLedgerCommand('transcript', '2', pagingPorts, labelsFor('tr'))).toMatchObject([
      { level: 'error', text: 'Bu kapsamda gözlenen 2 işçisi yok.' },
    ]);
    expect(inspectTranscript.mock.calls).toEqual([[workerA.identity], [workerC.identity], [workerA.identity], [workerB.identity], [workerD.identity]]);
  });
  it('TR page 3 is the start of the transcript', async () => {
    const entry = await show('tr', '1 3');
    const rows = entry.text.split('\n');
    expect(rows.slice(0, 2)).toEqual(['Döküm · işçi 1 · görev a1b2c3d4 · deneme 5d3c1b2a', `Ayrıntı: görev ${TASK} · deneme ${ATTEMPT}`]);
    expect(rows.slice(2)).toEqual([...Array.from({ length: 20 }, (_, index) => `line ${index + 1}`), 'Satır 1–20 / 100 (sayfa 3/3): dökümün başı.']);
  });
  it('a short transcript is shown whole and a page past the end says how many pages there are', async () => {
    expect((await show('en', '1', 10)).text.endsWith('line 10')).toBe(true);
    const { ports, observe } = workerSession();
    const inspectTranscript = vi.fn<typeof ports.inspectTranscript>(async () => lines(100));
    const pagingPorts = { ...ports, inspectTranscript };
    const [range] = await runLedgerCommand('transcript', '1 9', pagingPorts, labelsFor('tr'));
    if (range?.kind !== 'notice') throw new Error('Expected range notice');
    expect(range).toMatchObject({ level: 'error', text: `Bu dökümde yalnız 3 sayfa var: /transcript ${ATTEMPT} 1 en yeni satırları gösterir.` });
    expect(fillTemplate(workSurfaceLabels('en').transcriptPage!.range, { pages: 3, ref: ATTEMPT }))
      .toBe(`This transcript has only 3 page(s): /transcript ${ATTEMPT} 1 shows the newest lines.`);
    observe(workerB, workerA);
    const [newest] = await runLedgerCommand('transcript', '1 1', pagingPorts, labelsFor('en'));
    expect(newest).toMatchObject({ level: 'info', text: expect.stringContaining('Transcript · worker 1 · task a1b2c3d4 · attempt 6d3c1b2a') });
    const suggestedArgs = range.text.match(/\/transcript (\S+ 1) /u)![1]!;
    const [suggested] = await runLedgerCommand('transcript', suggestedArgs, pagingPorts, labelsFor('en'));
    expect(suggested).toMatchObject({ level: 'info', text: expect.stringContaining(`Details: task ${TASK} · attempt ${ATTEMPT}`) });
    expect(inspectTranscript.mock.calls).toEqual([[workerA.identity], [workerB.identity], [workerA.identity]]);
  });
  it('the headline carries no raw UUID', async () => {
    for (const locale of ['en', 'tr'] as const) expect((await show(locale, '1')).text.split('\n')[0]).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/iu);
  });
  it('rejects a malformed page', async () => {
    expect((await show('en', '1 zero')).level).toBe('error');
    expect((await show('en', '1 2 3')).text).toContain('Usage: /transcript');
  });
});

const workerA = report.sources[0]!.workers[0]!;
const workerB = { ...workerA, identity: { ...workerA.identity!, attemptId: '6d3c1b2a-9e8f-4a7b-8c6d-0e1f2a3b4c5d', generation: 2 } };
const workerC = { ...workerB, identity: { ...workerB.identity, attemptId: '7d3c1b2a-9e8f-4a7b-8c6d-0e1f2a3b4c5d' } };
const workerD = { ...workerB, identity: { ...workerB.identity, attemptId: '8d3c1b2a-9e8f-4a7b-8c6d-0e1f2a3b4c5d' } };

function workerSession() {
  let workers = [workerA, workerB];
  const inspectTranscript = vi.fn(async (attempt: WorkerAttemptIdentity) => `output from ${attempt.attemptId}`);
  const ports = { ...ledger(1), async listWorkers() { return { ...report, sources: [{ ...report.sources[0]!, workers }] }; }, inspectTranscript };
  return { ports, inspectTranscript, observe: (...next: typeof workers) => { workers = next; } };
}

describe('/transcript worker numbers', () => {
  it('reads the Attempt last listed at that number even when the observation reorders', async () => {
    const { ports, inspectTranscript, observe } = workerSession(), labels = labelsFor('en');
    // A transcript can establish the binding before the first /workers list.
    observe(workerA, workerB, { ...workerA, taskId: 'legacy-1', identity: null, authority: 'legacy-activity' });
    expect(await runLedgerCommand('transcript', ATTEMPT, ports, labels)).toMatchObject([
      { level: 'info', text: expect.stringContaining('Transcript · worker 1 · task a1b2c3d4 · attempt 5d3c1b2a') },
    ]);
    observe(workerB, workerA);
    expect(await runLedgerCommand('transcript', '1', ports, labels)).toMatchObject([
      { level: 'info', text: expect.stringContaining('Transcript · worker 1 · task a1b2c3d4 · attempt 5d3c1b2a') },
    ]);
    observe(workerB, workerC);
    expect(await runLedgerCommand('transcript', '1', ports, labels)).toMatchObject([{ level: 'error', text: 'No observed worker 1 in this scope.' }]);
    observe(workerA, workerC, workerB);
    expect([
      ...(await runLedgerCommand('transcript', '3', ports, labels)),
      ...(await runLedgerCommand('transcript', '2', ports, labels)),
    ]).toMatchObject([
      { level: 'info', text: expect.stringContaining('Transcript · worker 3 · task a1b2c3d4 · attempt 6d3c1b2a') },
      { level: 'info', text: expect.stringContaining('Transcript · worker 2 · task a1b2c3d4 · attempt 7d3c1b2a') },
    ]);
    observe(workerB, workerC, workerA);
    expect(await runLedgerCommand('transcript', workerB.identity.attemptId, ports, labels)).toMatchObject([
      { level: 'info', text: expect.stringContaining('Transcript · worker 3 · task a1b2c3d4 · attempt 6d3c1b2a') },
    ]);
    expect(inspectTranscript.mock.calls).toEqual([[workerA.identity], [workerA.identity], [workerB.identity], [workerC.identity], [workerB.identity]]);

    // The full list replaces those bindings after the observed attempts reorder.
    inspectTranscript.mockClear();
    observe(workerA, workerB);
    expect(await runLedgerCommand('workers', '', ports, labels)).toMatchObject([
      { ordinal: 1, attempt: workerA.identity }, { ordinal: 2, attempt: workerB.identity },
    ]);
    observe(workerB, { ...workerA, identity: { ...workerA.identity! } });
    const [entry] = await runLedgerCommand('transcript', '1', ports, labels);
    expect(inspectTranscript).toHaveBeenCalledExactlyOnceWith(workerA.identity);
    expect(entry).toMatchObject({ level: 'info', text: expect.stringContaining('Transcript · worker 1 · task a1b2c3d4 · attempt 5d3c1b2a') });
    expect(await runLedgerCommand('transcript', workerB.identity.attemptId, ports, labels)).toMatchObject([
      { level: 'info', text: expect.stringContaining('Transcript · worker 2 · task a1b2c3d4 · attempt 6d3c1b2a') },
    ]);
    await runLedgerCommand('transcript', '2', ports, labels);
    expect(inspectTranscript).toHaveBeenNthCalledWith(2, workerB.identity);
    expect(inspectTranscript).toHaveBeenNthCalledWith(3, workerB.identity);
  });

  it('reports a departed Attempt in EN and TR without reading the worker now at its number', async () => {
    const { ports, inspectTranscript, observe } = workerSession();
    await runLedgerCommand('workers', '', ports, labelsFor('en'));
    observe(workerB);
    expect(await runLedgerCommand('transcript', '1', ports, labelsFor('en'))).toMatchObject([{ level: 'error', text: 'No observed worker 1 in this scope.' }]);
    expect(await runLedgerCommand('transcript', '1', ports, labelsFor('tr'))).toMatchObject([{ level: 'error', text: 'Bu kapsamda gözlenen 1 işçisi yok.' }]);
    expect(inspectTranscript).not.toHaveBeenCalled();
    await runLedgerCommand('workers', '', ports, labelsFor('en'));
    await runLedgerCommand('transcript', '1', ports, labelsFor('en'));
    expect(inspectTranscript).toHaveBeenCalledExactlyOnceWith(workerB.identity);

    observe();
    await runLedgerCommand('workers', '', ports, labelsFor('en'));
    observe(workerB);
    expect(await runLedgerCommand('transcript', workerB.identity.attemptId, ports, labelsFor('en'))).toMatchObject([
      { level: 'info', text: expect.stringContaining(`Transcript · worker ${workerB.identity.attemptId} · task a1b2c3d4 · attempt 6d3c1b2a`) },
    ]);
    expect(await runLedgerCommand('transcript', '1', ports, labelsFor('en'))).toMatchObject([{ level: 'error', text: 'No observed worker 1 in this scope.' }]);
    expect(inspectTranscript.mock.calls).toEqual([[workerB.identity], [workerB.identity]]);
  });
});
