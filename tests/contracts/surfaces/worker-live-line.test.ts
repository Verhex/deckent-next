import { describe, expect, it } from 'vitest';
import { approvalWatchStep, compactCount, decisionKey, EMPTY_APPROVAL_WATCH, formatWorkerLine, ledgerEntrySummary, resolveWorkerRef, scanPendingApprovals,
  workerReportToLedgerEntries, type WorkerLineLabels, type WorkLedgerWorkerEntry, type WorklineApproval } from '#surfaces/core/terminal/index.js';
import type { WorkerObservationReport } from '#engine/index.js';
import { WORKER_LINE_EN } from '../support/worker-line-labels.js';

const EN = WORKER_LINE_EN;
const TR: WorkerLineLabels = { ...EN, numberLocale: 'tr', phases: { ...EN.phases, editing: 'düzenliyor' }, durationSeconds: '{n} sn', ago: '{duration} önce',
  tokensCache: '{tokens} token (önbellek %{ratio})' };

type Live = NonNullable<WorkLedgerWorkerEntry['live']>;
function worker(live: Partial<Live> | null, extra: Partial<WorkLedgerWorkerEntry> = {}): WorkLedgerWorkerEntry {
  return { schemaVersion: 1, kind: 'worker', id: 'w', scopeId: 's', taskId: 'task-1', process: 'running', provider: 'claude', authority: 'next-ledger',
    ordinal: 2, observedAtMs: 100_000, ...extra,
    ...(live === null ? {} : { live: { phase: 'editing', target: 'src/x.ts', detail: null, receivedAt: 88_000, provider: 'claude', model: 'claude-opus-5-5', outcome: 'running',
      tokens: 18_432, cacheReadRatio: 0.83, dropped: 0, unmapped: 0, eventsTruncated: false, ...live } }) };
}

describe('worker live line', () => {
  it('renders the owner example in Turkish and English from worker-reported activity and the host clock', () => {
    expect(formatWorkerLine(worker({}), TR)).toEqual({ text: 'worker 2 · claude claude-opus-5-5 · düzenliyor src/x.ts · 12 sn önce · 18,4k token (önbellek %83)', tone: 'normal' });
    expect(formatWorkerLine(worker({}), EN).text).toBe('worker 2 · claude claude-opus-5-5 · editing src/x.ts · 12 s ago · 18.4k tokens (cache 83%)');
  });

  it('formats ages in seconds, minutes and hours and never shows a negative age', () => {
    expect(formatWorkerLine(worker({ receivedAt: 100_000 - 3 * 60_000 - 5_000 }), EN).text).toContain('· 3 min ago ·');
    expect(formatWorkerLine(worker({ receivedAt: 100_000 - 2 * 3_600_000 }), EN).text).toContain('· 2 h ago ·');
    expect(formatWorkerLine(worker({ receivedAt: 105_000 }), EN).text).toContain('· 0 s ago ·');
    expect(formatWorkerLine(worker({ receivedAt: null }), EN).text).not.toContain('ago');
  });

  it('compacts token counts with the locale separator and omits cache when there is no prompt', () => {
    expect([compactCount(950, 'en'), compactCount(18_432, 'tr'), compactCount(1_250_000, 'en')]).toEqual(['950', '18,4k', '1.2M']);
    expect(formatWorkerLine(worker({ cacheReadRatio: null, tokens: 950 }), EN).text).toMatch(/· 950 tokens$/);
    expect(formatWorkerLine(worker({ tokens: 0 }), EN).text).not.toContain('tokens');
  });

  it('marks truncated event tails and dropped events visibly', () => {
    const text = formatWorkerLine(worker({ eventsTruncated: true, dropped: 3 }), EN).text;
    expect(text).toContain('· events truncated');
    expect(text).toContain('· 3 events dropped');
  });

  it('labels a finished or failed session as worker reported; only a reported failure uses the error tone', () => {
    expect(formatWorkerLine(worker({ phase: 'finished', target: null, outcome: 'success' }), EN)).toMatchObject({ tone: 'normal' });
    expect(formatWorkerLine(worker({ phase: 'finished', target: null, outcome: 'success' }), EN).text).toContain('· finished (worker reported) ·');
    expect(formatWorkerLine(worker({ phase: 'failed', target: null, outcome: 'error' }), EN)).toMatchObject({ tone: 'error' });
  });

  it('shows a Codex/Cursor worker that only reports session start as muted progress, not as an error', () => {
    const line = formatWorkerLine(worker({ phase: 'starting', target: null, model: null, tokens: null, cacheReadRatio: null, unmapped: 7 }, { provider: 'codex' }), EN);
    expect(line).toEqual({ text: 'worker 2 · codex · starting · 12 s ago · 7 provider events not itemized yet', tone: 'muted' });
  });

  it('keeps the process line when the worker reported no events and shows shell detail when there is no target', () => {
    expect(formatWorkerLine(worker(null, { provider: 'docker' }), EN)).toEqual({ text: 'worker 2 · docker · running', tone: 'muted' });
    // The host-known provider wins; the worker's own claim only fills an unknown provider.
    expect(formatWorkerLine(worker({ provider: 'codex' }), EN).text).toMatch(/^worker 2 · claude /);
    expect(formatWorkerLine(worker({}, { provider: 'unknown' }), EN).text).toMatch(/^worker 2 · claude claude-opus-5-5 /);
    expect(formatWorkerLine(worker({ phase: 'running', target: null, detail: 'npm test --silent' }), EN).text).toContain('· running npm test --silent ·');
    expect(ledgerEntrySummary(worker({}))).toBe('worker task-1 running editing src/x.ts');
  });

  it('maps an observation report to numbered cards carrying attempt identity, host observation time and worker activity', () => {
    const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a-1', generation: 1, layoutRevision: 'l' };
    const files = { provider: 'claude', activity: { phase: 'reading', detail: null, target: 'a.ts', atMs: 5, receivedAt: 900 }, eventsTruncated: false,
      usage: { provider: 'claude', model: 'm', outcome: 'running', tokens: { input: 10, output: 20, cacheRead: 60, cacheWrite: 10, thinking: null }, cacheReadRatio: 0.75,
        dropped: 1, unmapped: 0 } };
    const report = { schemaVersion: 1, observedAt: 1_000, scopeId: 's', control: 'observe-only', sources: [{ workers: [
      { taskId: 'legacy', identity: null, provider: 'docker', process: 'running', authority: 'legacy-activity', files: null },
      { taskId: 't', identity, provider: 'claude', process: 'running', authority: 'next-ledger', files }] }] } as unknown as WorkerObservationReport;
    const [legacy, next] = workerReportToLedgerEntries(report, 'x');
    expect(legacy).toMatchObject({ ordinal: 1, attempt: null, observedAtMs: 1_000 });
    expect(legacy!.live).toBeUndefined();
    expect(next).toMatchObject({ ordinal: 2, attempt: identity, live: { phase: 'reading', target: 'a.ts', receivedAt: 900, tokens: 100, cacheReadRatio: 0.75, dropped: 1 } });
    expect(JSON.stringify(next)).not.toContain('"atMs"');
    expect(resolveWorkerRef('2', [legacy!, next!])).toBe(next);
    expect(resolveWorkerRef('a-1', [legacy!, next!])).toBe(next);
    expect(resolveWorkerRef('3', [legacy!, next!])).toBeNull();
  });
});

function approval(id: string, patch: Partial<WorklineApproval> = {}): WorklineApproval {
  return { approvalId: id, runId: 'r', taskId: 't', summary: `do ${id}`, requester: 'svc', revision: 0, status: 'pending', decision: null, expiresAt: 10_000, ...patch };
}

describe('approval decision keys and scans', () => {
  it('approves only on a single typed y/Y; n, Enter and Esc deny; paste, always-keys and control sequences never decide', () => {
    expect([decisionKey('y', {}), decisionKey('Y', {})]).toEqual(['yes', 'yes']);
    expect([decisionKey('n', {}), decisionKey('N', {}), decisionKey('\r', { return: true }), decisionKey('', { escape: true })]).toEqual(['no', 'no', 'no', 'no']);
    for (const input of ['a', 'A', '3', 'yes', 'y\r', ' ', 'x']) expect(decisionKey(input, {})).toBeNull();
    expect(decisionKey('y', { ctrl: true })).toBeNull();
    expect(decisionKey('y', { meta: true })).toBeNull();
  });

  it('scans pages for pending unexpired approvals, oldest expiry first, and reports a bounded scan as truncated', async () => {
    const pages: Record<string, { items: WorklineApproval[]; nextAfter: string | null }> = {
      start: { items: [approval('b', { expiresAt: 9_000 }), approval('c', { status: 'decided', revision: 1, decision: 'allow' })], nextAfter: 'c' },
      c: { items: [approval('d', { expiresAt: 500 }), approval('e', { expiresAt: 2_000 })], nextAfter: null },
    };
    const seen: (string | null)[] = [];
    const list = async (after: string | null) => { seen.push(after); return pages[after ?? 'start']!; };
    const result = await scanPendingApprovals(list, 1_000);
    expect(result.pending.map(item => item.approvalId)).toEqual(['e', 'b']);
    expect(result.truncated).toBe(false); expect(seen).toEqual([null, 'c']);
    expect((await scanPendingApprovals(list, 1_000, 1)).truncated).toBe(true);
  });

  it('announces each pending approval once while rotating one page per poll and forgets decided ones', () => {
    let step = approvalWatchStep(EMPTY_APPROVAL_WATCH, { items: [approval('a'), approval('b')], nextAfter: 'b' }, 0);
    expect(step.fresh.map(item => item.approvalId)).toEqual(['a', 'b']); expect(step.state.cursor).toBe('b');
    step = approvalWatchStep(step.state, { items: [approval('c')], nextAfter: null }, 0);
    expect(step.fresh.map(item => item.approvalId)).toEqual(['c']); expect(step.state.cursor).toBeNull();
    step = approvalWatchStep(step.state, { items: [approval('a', { status: 'decided', revision: 1, decision: 'deny' }), approval('b')], nextAfter: 'b' }, 0);
    expect(step.fresh).toEqual([]); expect(step.state.notified.has('a')).toBe(false);
    expect(approvalWatchStep(step.state, { items: [approval('x', { expiresAt: 5 })], nextAfter: null }, 10).fresh).toEqual([]);
  });
});
