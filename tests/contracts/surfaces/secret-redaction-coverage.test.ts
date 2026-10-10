import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCrashArtifact, createHmacIntegrity, ErrorRegistry, reportFatal, snapshotKnownSecrets, writeCrashArtifact } from '#platform/index.js';
import { buildInferenceServingPlan, AuditApplication, recordAuditSummary, type TaskBrief } from '#engine/index.js';
import { describeMcpResult, openSqliteAuditStore, openSqliteLedger } from '#adapters/index.js';
import { buildWorklineBridgeSnapshot, type TurnDelta } from '#surfaces/core/terminal/index.js';
import { renderBriefLines } from '#surfaces/core/monitor/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { SLASH_WINDOW_TEST_LABELS } from '../support/slash-window-labels.js';

// One registered, credential-shaped canary across the actual exported surfaces. It is a fictitious fixture, never a credential.
const CANARY = 'sk-w12FictitiousCanaryQ7x8Y9z0', known = snapshotKnownSecrets([{ name: 'W12', value: CANARY }]);
const MASK = '‹secret:W12›';
const noLeak = (text: string) => { for (let at = 3; at + 5 <= CANARY.length; at++) expect(text).not.toContain(CANARY.slice(at, at + 5)); };
const roots: string[] = [], views: ReturnType<typeof mountWorkline>[] = [];
afterEach(async () => { for (const view of views.splice(0)) view.instance.unmount(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// Exported snapshot builder is the current Desktop contract, not a running Desktop application.
const profile = { schemaVersion: 1 as const, id: 'fixture', scopeId: 'scope', hardware: { gpus: 1, vramGbPerGpu: 32, arch: 'blackwell_consumer' as const, topology: 'single' as const },
  model: { modelId: 'fixture-model', weightGb: 1, kvBytesPerTokenBf16: 1, kvBytesPerTokenFp8: 1, deltaNetStateGbPerSeq: 0 },
  serving: { backend: 'llama_cpp' as const, weightQuant: 'q4' as const, kvDtype: 'fp16' as const, gpuMemUtil: 0.9, overheadGb: 1, port: 18080 },
  workload: { maxCtx: 100, avgActiveCtx: 50, roleMaxCtx: { brain: 100, worker: 100, auditor: 100 } }, calibration: { computeCap: 4 } };

describe('W12 cross-surface credential masking', () => {
  it.each([200, 40])('masks all intermediate workline frames and scratch windows at %s columns while keeping raw history', async columns => {
    const seenHistory: string[] = [];
    const view = mountWorkline({ knownSecrets: known, labels: { ...WORKLINE_TEST_LABELS, windows: SLASH_WINDOW_TEST_LABELS },
      async *streamTurn(messages) {
        seenHistory.push(JSON.stringify(messages));
        for (const text of [...CANARY, ' after\n']) { yield { kind: 'text', text } as TurnDelta; await settle(40); }
        yield { kind: 'message', message: { role: 'assistant', content: CANARY, toolCalls: [] } };
        yield { kind: 'done', finish: 'stop' };
      },
      scratch: { async inspect() { return { schemaVersion: 1 as const, path: `/tmp/${CANARY}`, exists: true, bytes: 1, truncated: false,
        files: [{ path: `/tmp/${CANARY}/notes-${CANARY}.txt`, bytes: 1, modifiedAtMs: 0 }], limits: { writeMaxBytes: 1, sessionMaxBytes: 100, retentionDays: 1 } }; },
        async clear() { return { schemaVersion: 1 as const, path: '/tmp/unused', removedFiles: 0, removedBytes: 0 }; } } }, columns, { rows: 60 });
    views.push(view);
    await until(() => view.stdout.frame.includes('READY'), 'ready'); await settle(40);
    view.stdin.write('go\r');
    await until(() => view.stdout.text.includes('after'), 'answer finished'); await until(() => view.stdout.frame.includes('READY'), 'turn done');
    noLeak(view.stdout.text); if (columns === 200) expect(view.stdout.text).toContain(MASK);
    // Next turn proves the stream presentation did not replace the message the runtime supplied for history.
    view.stdin.write('next\r'); await until(() => seenHistory.length === 2, 'second history'); expect(seenHistory[1]).toContain(CANARY);
    await until(() => view.stdout.frame.includes('READY'), 'second done');
    view.stdin.write('/scratch\r'); await until(() => view.stdout.frame.includes(SLASH_WINDOW_TEST_LABELS.scratch.title), 'scratch window'); await settle(40);
    noLeak(view.stdout.text); if (columns === 200) expect(view.stdout.frame).toContain(MASK);
  });

  it('masks the monitor report, bounded MCP results and both crash artifact and fatal diagnostic logs', async () => {
    const brief: TaskBrief = { schemaVersion: 1, task: CANARY, scopePaths: [CANARY], acceptance: CANARY, criteria: [], profile: null, model: null, effort: null, contextRefs: [] };
    const monitor = renderBriefLines(brief, undefined, 'en').join('\n'); noLeak(monitor); expect(monitor).toContain('[REDACTED]');
    // Every display cut can land inside the canary: mask the source before cutting, including the server's arbitrary known values.
    const arbitrary = 'W12-unshaped-0123456789';
    for (const value of [CANARY, arbitrary]) for (let size = 1; size <= value.length + 10; size++) {
      const result = describeMcpResult({ outcome: 'answered', result: { content: [{ type: 'text', text: `prefix ${value} suffix` }] } }, 'fixture', size, { projectReadOnly: false, secrets: [value] });
      if (value === CANARY) noLeak(result.text);
      else for (let at = 0; at + 5 <= value.length; at++) expect(result.text).not.toContain(value.slice(at, at + 5));
    }
    const root = await mkdtemp(join(tmpdir(), 'dn-w12-logs-')); roots.push(root);
    const artifact = buildCrashArtifact(new Error(CANARY), root, ['deckent', CANARY]); noLeak(JSON.stringify(artifact)); expect(artifact.message).toBe('[REDACTED]');
    const path = await writeCrashArtifact(new Error(CANARY), root, ['deckent', CANARY], { HOME: join(root, 'home') }); expect(path).not.toBeNull(); noLeak(await readFile(path!, 'utf8'));
    let log = '';
    expect(await reportFatal(ErrorRegistry.createError('UNKNOWN', { message: CANARY }), { root, env: { HOME: join(root, 'home') }, stderr: { write(text) { log += text; } } })).toBe(1);
    noLeak(log); expect(log).toContain('[REDACTED]');
  });

  it('masks before a sealed audit summary cut and snapshot delivery, preserving original input and action digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dn-w12-audit-')); roots.push(root); await mkdir(join(root, 'home'));
    const path = join(root, 'ledger.db'), options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
    openSqliteLedger(path, options).close(); const store = await openSqliteAuditStore(path, options, 'forbid');
    const head = 'x'.repeat(190) + CANARY, digest = 'a'.repeat(64), original = { kind: 'shell' as const, head, argsDigest: digest };
    try {
      const audit = new AuditApplication(store, createHmacIntegrity('fixture-key', randomBytes(32)));
      const record = audit.record({ schemaVersion: 1, eventId: 'event', scopeId: 'scope', principal: { issuer: 'fixture', subject: 'person' }, policyRevision: 'p1', atMs: 1,
        subject: { kind: 'permission-mode', mode: 'auto-edit', cell: 'shell-modify', tool: { name: 'run_shell', version: 1 }, call: { turnId: 'turn', round: 1, index: 1, callId: 'call' },
          grants: { company: 'company', person: 'person' }, decision: { previous: 'require-approval', next: 'allow' }, summary: recordAuditSummary(original, known) } });
      const stored = audit.list('scope', 0, 10); noLeak(JSON.stringify(stored)); expect(stored).toEqual([record]); expect(original.head).toBe(head);
      expect(JSON.stringify(stored)).toContain(digest);
    } finally { store.close(); }
    const notice = { schemaVersion: 1 as const, kind: 'notice' as const, id: 'notice-id', level: 'info' as const, text: `notice ${CANARY}`, identity: { model: CANARY, provider: CANARY } };
    const worker = { schemaVersion: 1 as const, kind: 'worker' as const, id: 'worker-id', scopeId: 'scope', taskId: 'task', process: CANARY, provider: CANARY, authority: CANARY,
      live: { phase: null, target: CANARY, detail: CANARY, receivedAt: 1, provider: CANARY, model: CANARY, outcome: null, tokens: null, cacheReadRatio: null, dropped: 0, unmapped: 0, eventsTruncated: false } };
    const snapshot = buildWorklineBridgeSnapshot({ profile, plan: buildInferenceServingPlan(profile), tty: { columns: 120, rows: 40 }, ledgerTail: [notice, worker], knownSecrets: known });
    noLeak(JSON.stringify(snapshot)); expect(JSON.stringify(snapshot)).toContain(MASK); expect(snapshot.ledgerTail[0]!.id).toBe('notice-id'); expect(snapshot.ledgerTail[1]!.id).toBe('worker-id');
    expect(notice.text).toContain(CANARY); expect(worker.live.target).toBe(CANARY);
  });
});
