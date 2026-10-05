import { panelFixture } from '../support/workline-panel-fixture.js';
import { PassThrough, Writable } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { WorklineApp, WorklinePaletteProvider, resolveWorklinePalette, type WorklineLabels, type WorklineProps, type WorklineApproval,
  type WorkSurfaceLabels } from '#surfaces/core/terminal/index.js';
import type { RunView, WorkerObservationReport } from '#engine/index.js';
import { WORKER_LINE_EN as EN } from '../support/worker-line-labels.js';

const work: WorkSurfaceLabels = { workerLine: EN, panel: { title: 'LIVE-PANEL', more: '+{count} MORE' }, unavailable: 'UNWIRED',
  transcriptUsage: 'T-USAGE', transcriptNotFound: 'T-NOTFOUND {ref}', transcriptNoAttempt: 'T-NOATTEMPT {ref}', transcriptHeader: 'T-HEADER {n} {attempt}',
  approvalsNone: 'A-NONE', approvalItem: 'A-ITEM {n} {id} {summary}', approvalsTruncated: 'A-TRUNC {pages}', approvalNotFound: 'A-NOTFOUND {ref}',
  approvalTitle: 'A-TITLE', approvalSubject: 'A-SUBJECT {id} {run} {task} {requester}', approvalPreviewMore: 'A-PREVIEW-MORE {count}', approvalExpires: 'A-EXPIRES {duration}', approvalPrompt: 'A-PROMPT',
  approvalPending: 'A-PENDING', approvalAllowed: 'A-ALLOWED {id}', approvalDenied: 'A-DENIED {id}', approvalUnsettled: 'A-UNSETTLED {id}', approvalMore: 'A-MORE {count}',
  approvalNotify: 'A-NOTIFY {count}', approvalPollFailed: 'A-POLLFAIL', approvalCard: { risk: 'R-RISK {risk} {undo}', notDeclared: 'R-UNDECLARED', onExpiry: 'R-NOTHING-RUNS', assuranceTurnHere: 'R-TURN-HERE',
    assuranceTurnElsewhere: 'R-TURN-ELSEWHERE', assurancePeer: 'R-PEER', assuranceOther: 'R-OTHER {level}' },
  approvalStanding: { covers: 'S-COVERS {pattern}', promptBoth: 'S-PROMPT-BOTH', promptSession: 'S-PROMPT-SESSION', promptAlways: 'S-PROMPT-ALWAYS', savedSession: 'S-SAVED-SESSION {id}',
    savedAlways: 'S-SAVED-ALWAYS {id}', notSavedSession: 'S-NOT-SAVED-SESSION {id} {reason}', notSavedAlways: 'S-NOT-SAVED-ALWAYS {id} {reason}' }, cancelUsage: 'C-USAGE', cancelTitle: 'C-TITLE {run}',
  cancelDetail: 'C-DETAIL {revision} {phases}', cancelAlreadyRequested: 'C-ALREADY', cancelPrompt: 'C-PROMPT', cancelPending: 'C-PENDING', cancelKept: 'C-KEPT {run}' };
const labels: WorklineLabels = { banner: 'BANNER', prompt: '> ', statusReady: 'READY', statusBusy: 'BUSY', statusCancelling: 'CANCELLING',
  hint: 'HINT', roleUser: 'you', roleAssistant: 'bot', runCard: 'Run', workerCard: 'Worker', watchFailed: 'WATCH-FAILED',
  ledgerUnavailable: 'NO-LEDGER', runNotFound: 'NO-RUN', workersEmpty: 'NO-WORKERS', runsEmpty: 'NO-RUNS', serviceRestartUnavailable: 'NO-RESTART', queued: 'QUEUED', runUsage: 'USAGE',
  watchStarted: 'WATCH-ON', watchRunsStarted: 'RUNS-ON', watchStopped: 'WATCH-OFF', statusLine: 'STATUS-LINE', unknownCommand: 'UNKNOWN', work,
  render: { assistant: 'bot', thinking: 'THINKING {tokens} tok {seconds}s', thought: 'THOUGHT {seconds}s {tokens} tok', elapsed: '{seconds}s',
    tokens: '{prompt} in {completion} out', reasoningTokens: '{count} reasoning', truncated: 'TRUNCATED', cancelled: 'CANCELLED', failed: 'FAILED',
    code: 'code', moreAbove: '{count} more above', queued: '{count} queued' },
  composer: { pasteChip: '[PASTE {lines}]', search: 'SEARCH', exitArmed: 'EXIT-ARMED', shortcuts: 'KEYS\nENTER-SENDS', slash: { 'terminal.slash.run': 'RUN-DESC', 'terminal.slash.runArgument': '<RUN-ID>' } } };

class Screen extends Writable {
  text = '';
  /** Ink debug mode writes every frame whole (all static rows + the dynamic region) in one write. */
  frame = '';
  readonly isTTY = true; readonly columns = 220; readonly rows = 60;
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.frame = chunk.toString('utf8'); this.text += this.frame; done(); }
}
function keyboard() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  return stdin;
}
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 300; attempt++) { if (check()) return; await settle(10); }
  throw new Error(`timed out waiting for ${label}`);
}
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });

function mount(props: Partial<WorklineProps>) {
  const stdout = new Screen(), stdin = keyboard();
  const instance = render(createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'), children: createElement(WorklineApp, {
    labels, target: 'scope-a · model', systemPrompt: 'SYSTEM', historyMessages: 4, errorText: (error: unknown) => `ERR:${(error as Error).message}`,
    completeTurn: async () => 'unused', ...props, ...panelFixture(props),
  }) }), { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  mounted.push(instance);
  const type = async (text: string) => { for (const char of text) { stdin.write(char); await settle(2); } };
  const frame = () => stdout.frame;
  const count = (text: string) => stdout.frame.split(text).length - 1;
  /** Waits until a decision card is on screen and its key handler is subscribed (effects run after the frame is written). */
  const card = async (text: string, label: string) => { await until(() => frame().includes(text), label).catch(error => { throw new Error(`${String(error)}\n${frame()}`); }); await settle(40); };
  return { stdout, stdin, instance, type, frame, count, card };
}

const identity = (attemptId: string) => ({ scopeId: 'scope-a', runId: 'r', taskId: `t-${attemptId}`, attemptId, generation: 1, layoutRevision: 'l' });
function report(now: number): WorkerObservationReport {
  const usage = (tokens: number) => ({ provider: 'claude', model: 'claude-model', outcome: 'running', dropped: 0, unmapped: 0, cacheReadRatio: 0.5,
    tokens: { input: tokens / 2, output: 0, cacheRead: tokens / 2, cacheWrite: 0, thinking: null } });
  return { schemaVersion: 1, observedAt: now, scopeId: 'scope-a', control: 'observe-only', sources: [{ workers: [
    { taskId: 't-a1', identity: identity('a1'), provider: 'claude', process: 'running', authority: 'next-ledger',
      files: { provider: 'claude', eventsTruncated: false, activity: { phase: 'editing', target: 'src/x.ts', detail: null, atMs: 1, receivedAt: now - 12_000 }, usage: usage(18_400) } },
    { taskId: 't-a2', identity: identity('a2'), provider: 'codex', process: 'running', authority: 'next-ledger',
      files: { provider: 'codex', eventsTruncated: false, activity: { phase: 'starting', target: null, detail: null, atMs: 0, receivedAt: now - 2_000 },
        usage: { ...usage(0), provider: 'codex', model: null, cacheReadRatio: null, unmapped: 4 } } },
    { taskId: 'legacy-1', identity: null, provider: 'docker', process: 'running', authority: 'legacy-activity', files: null },
  ] }] } as unknown as WorkerObservationReport;
}
const baseLedger = { scopeId: 'scope-a', async listWorkers() { return report(Date.now()); }, async inspectRun() { return null; } };

describe('work surface: live worker panel', () => {
  it('shows human-readable worker lines in the dynamic region fed only by the heartbeat poll', async () => {
    const polls: number[] = [];
    const view = mount({ pollMs: 60, ledger: { ...baseLedger, async listWorkers() { polls.push(performance.now()); return report(Date.now()); } } });
    await view.type('/watch-workers\r');
    await until(() => view.stdout.text.includes('LIVE-PANEL'), 'panel');
    expect(view.stdout.text).toContain('worker 1 · claude claude-model · editing src/x.ts · 12 s ago · 18.4k tokens (cache 50%)');
    expect(view.stdout.text).toContain('worker 2 · codex · starting · 2 s ago · 4 provider events not itemized yet');
    expect(view.stdout.text).toContain('worker 3 · docker · running');
    await settle(400);
    // Single-flight polls never run faster than the heartbeat: at most one per interval after the first. Intervals use the
    // monotonic clock: the WSL wall clock steps back by seconds (a -2877 ms interval was observed in a full verify).
    for (let index = 1; index < polls.length; index++) expect(polls[index]! - polls[index - 1]!).toBeGreaterThanOrEqual(55);
    await view.type('/watch-stop\r');
    await until(() => view.frame().includes('WATCH-OFF') && !view.frame().includes('LIVE-PANEL'), 'panel cleared when the watch stops');
  });

  it('prints the live line on worker cards from /workers', async () => {
    const view = mount({ ledger: baseLedger });
    await view.type('/workers\r');
    await until(() => view.stdout.text.includes('t-a2'), 'cards');
    expect(view.stdout.text).toContain('worker 1 · claude claude-model · editing src/x.ts');
  });
});

describe('work surface: /transcript', () => {
  it('reads the sealed transcript by worker number or attempt id and shows denial, missing and legacy states without prompting', async () => {
    const asked: string[] = [];
    const view = mount({ ledger: { ...baseLedger, async inspectTranscript(attempt) {
      asked.push(attempt.attemptId);
      if (attempt.attemptId === 'a2') throw new Error('POLICY_DENIED');
      return 'RENDERED-TIMELINE';
    } } });
    await view.type('/transcript 1\r');
    await until(() => view.stdout.text.includes('RENDERED-TIMELINE'), 'transcript');
    expect(view.stdout.text).toContain('T-HEADER 1 a1');
    await view.type('/transcript a2\r');
    await until(() => view.stdout.text.includes('ERR:POLICY_DENIED'), 'policy denial visible');
    await view.type('/transcript 3\r');
    await until(() => view.stdout.text.includes('T-NOATTEMPT 3'), 'legacy worker');
    await view.type('/transcript 9\r');
    await until(() => view.stdout.text.includes('T-NOTFOUND 9'), 'missing worker');
    await view.type('/transcript\r');
    await until(() => view.stdout.text.includes('T-USAGE'), 'usage');
    expect(asked).toEqual(['a1', 'a2']);
    // Read-only: no decision card, the composer keeps the keys.
    await view.type('hello');
    await until(() => view.stdout.text.includes('> hello'), 'composer active');
    expect(view.stdout.text).not.toContain('A-PROMPT');
  });

  it('reports unwired work commands instead of guessing', async () => {
    const view = mount({ ledger: baseLedger });
    for (const command of ['/transcript 1', '/approvals', '/cancel r']) await view.type(`${command}\r`);
    await until(() => view.stdout.text.split('UNWIRED').length > 3, 'three unwired notices');
  });
});

function approval(id: string, patch: Partial<WorklineApproval> = {}): WorklineApproval {
  return { approvalId: id, runId: 'run-1', taskId: 'task-1', summary: `summary ${id}`, requester: 'svc', revision: 0, status: 'pending', decision: null,
    expiresAt: Date.now() + 600_000, ...patch };
}

describe('work surface: approvals', () => {
  function approvals(initial: WorklineApproval[]) {
    const records = new Map(initial.map(item => [item.approvalId, item]));
    const decisions: Array<{ id: string; revision: number; decision: string }> = [];
    let lists = 0;
    const ledger = { ...baseLedger,
      async listApprovalPage() { lists++; return { items: [...records.values()], nextAfter: null }; },
      async decideApproval(target: Pick<WorklineApproval, 'approvalId' | 'revision'>, decision: 'allow' | 'deny') {
        decisions.push({ id: target.approvalId, revision: target.revision, decision });
        const next = { ...records.get(target.approvalId)!, status: 'decided' as const, revision: 1, decision };
        records.set(target.approvalId, next); return next;
      } };
    return { ledger, decisions, records, lists: () => lists };
  }

  it('lists pending approvals and decides one card at a time: y approves, "a" never approves, Enter and Esc deny', async () => {
    const fake = approvals([approval('ap-1'), approval('ap-2'), approval('ap-3'), approval('done', { status: 'decided', revision: 1, decision: 'allow' })]);
    const view = mount({ ledger: fake.ledger, pollMs: 10_000 });
    await view.type('/approvals\r');
    await until(() => view.frame().includes('> A-ITEM 1 ap-1 summary ap-1') && view.frame().includes('A-ITEM 2 ap-2'), 'picker');
    expect(view.frame()).not.toContain('A-ITEM 4');
    expect(view.frame()).not.toContain('A-PROMPT');
    await view.type('\r');
    await view.card('A-SUBJECT ap-1', 'card');
    expect(view.frame()).toContain('A-SUBJECT ap-1 run-1 task-1 svc');
    // Keys that are not y/n/Enter/Esc (legacy "always" key, stray text, a paste) leave the card waiting and never reach the composer.
    await view.type('a'); view.stdin.write('yes'); await settle(60);
    expect(fake.decisions).toEqual([]);
    expect(view.frame()).toContain('A-PROMPT');
    expect(view.stdout.text).not.toContain('> a');
    await view.type('y');
    await until(() => view.frame().includes('A-ALLOWED ap-1') && !view.frame().includes('A-PROMPT'), 'approved');
    expect(view.frame()).toContain('A-MORE 2');
    await view.type('/approvals\r');
    await until(() => view.frame().includes('> A-ITEM 1 ap-2'), 'second picker'); await view.instance.waitUntilRenderFlush(); await settle(30);
    await view.type('\r');
    await view.card('A-SUBJECT ap-2', 'second card');
    view.stdin.write('\r');
    await until(() => view.frame().includes('A-DENIED ap-2'), 'enter denies');
    await view.type('/approvals\r');
    await until(() => view.frame().includes('> A-ITEM 1 ap-3'), 'third picker'); await view.instance.waitUntilRenderFlush(); await settle(30);
    await view.type('\r');
    await view.card('A-SUBJECT ap-3', 'third card');
    view.stdin.write('\u001b');
    await until(() => view.frame().includes('A-DENIED ap-3'), 'esc denies');
    expect(fake.decisions).toEqual([{ id: 'ap-1', revision: 0, decision: 'allow' }, { id: 'ap-2', revision: 0, decision: 'deny' }, { id: 'ap-3', revision: 0, decision: 'deny' }]);
    await view.type('/approvals\r');
    await until(() => view.frame().includes('A-NONE'), 'nothing pending');
  });

  it('selects an approval by number or id, reports unknown ones and shows a failed decision as an error', async () => {
    const fake = approvals([approval('ap-1'), approval('ap-2')]);
    const view = mount({ ledger: { ...fake.ledger, async decideApproval() { throw new Error('APPROVAL_CONFLICT'); } }, pollMs: 10_000 });
    await view.type('/approvals nope\r');
    await until(() => view.stdout.text.includes('A-NOTFOUND nope'), 'unknown approval');
    await view.type('/approvals ap-2\r');
    await view.card('A-SUBJECT ap-2', 'selected by id');
    await view.type('y');
    await until(() => view.frame().includes('ERR:APPROVAL_CONFLICT') && !view.frame().includes('A-PROMPT'), 'failed decision visible');
    await view.type('/approvals 2\r');
    await view.card('A-SUBJECT ap-2', 'selected by number');
  });

  it('does not list approvals more often than every 10 s by default, even with a fast worker heartbeat', async () => {
    const fake = approvals([approval('ap-1')]);
    const view = mount({ ledger: fake.ledger, pollMs: 40 });
    await until(() => view.stdout.text.includes('A-NOTIFY 1'), 'first notice');
    await settle(600);
    expect(fake.lists()).toBe(1);
  });

  it('announces new pending approvals once on the heartbeat without opening a card', async () => {
    const fake = approvals([approval('ap-1')]);
    const view = mount({ ledger: fake.ledger, pollMs: 40, approvalPollMs: 40 });
    await until(() => view.stdout.text.includes('A-NOTIFY 1'), 'first notice');
    fake.records.set('ap-9', approval('ap-9')); fake.records.set('ap-8', approval('ap-8'));
    await until(() => view.stdout.text.includes('A-NOTIFY 2'), 'second notice');
    const lists = fake.lists(); await settle(200);
    expect(fake.lists() - lists).toBeLessThanOrEqual(6);
    expect(view.count('A-NOTIFY')).toBe(2);
    expect(view.frame()).not.toContain('A-PROMPT');
    expect(fake.decisions).toEqual([]);
  });
});

describe('work surface: /cancel', () => {
  const run = { runId: 'run-7', scopeId: 'scope-a', revision: 3, cancellationRequested: false, tasks: [{ phase: 'active' }] } as unknown as RunView;
  it('asks before requesting cancellation, keeps the run on N and requests it against the inspected revision on y', async () => {
    const cancelled: Array<[string, number]> = [];
    const view = mount({ ledger: { ...baseLedger, async inspectRun(runId: string) { return runId === 'run-7' ? run : null; },
      async cancelRun(runId: string, revision: number) { cancelled.push([runId, revision]); return 'CANCEL-OUTCOME rendered'; } } });
    await view.type('/cancel missing\r');
    await until(() => view.stdout.text.includes('NO-RUN'), 'missing run');
    await view.type('/cancel\r');
    await until(() => view.stdout.text.includes('C-USAGE'), 'usage');
    await view.type('/cancel run-7\r');
    await view.card('C-PROMPT', 'confirm card');
    expect(view.frame()).toContain('C-TITLE run-7'); expect(view.frame()).toContain('C-DETAIL 3 active:1');
    await view.type('n');
    await until(() => view.frame().includes('C-KEPT run-7') && !view.frame().includes('C-PROMPT'), 'kept');
    expect(cancelled).toEqual([]);
    // Ctrl+C on an open card is the safe answer (keep running) and never exits the terminal.
    let exited = false; void view.instance.waitUntilExit().then(() => { exited = true; });
    await view.type('/cancel run-7\r');
    await view.card('C-PROMPT', 'ctrl+c card');
    view.stdin.write('\u0003');
    await until(() => view.frame().includes('C-KEPT run-7') && !view.frame().includes('C-PROMPT'), 'ctrl+c keeps the run');
    expect(exited).toBe(false); expect(cancelled).toEqual([]);
    await view.type('/cancel run-7\r');
    await view.card('C-PROMPT', 'second card');
    await view.type('y');
    await until(() => view.stdout.text.includes('CANCEL-OUTCOME rendered'), 'typed outcome');
    expect(cancelled).toEqual([['run-7', 3]]);
  });
});

describe('work surface: approval of a running turn\'s tool call (T-L4)', () => {
  it('shows the call preview on a decision card, sends a single y as allow for exactly that approval, and continues the turn', async () => {
    const decided: { approvalId: string; revision: number; decision: string }[] = [];
    let release!: () => void; const answered = new Promise<void>(resolve => { release = resolve; });
    const streamTurn = async function* () {
      yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'c1', approvalId: 'appr-1', revision: 0,
        summary: 'edit_file · src/a.ts · 0123456789ab', preview: ['--- src/a.ts', '+++ src/a.ts', '-old line', '+new line', ...Array.from({ length: 30 }, (_, i) => `ctx ${i}`)].join('\n'),
        expiresAt: Date.now() + 600_000 };
      await answered;
      yield { kind: 'approval' as const, phase: 'settled' as const, callId: 'c1', approvalId: 'appr-1', outcome: 'allow' as const };
      yield { kind: 'text' as const, text: 'Edited.' }; yield { kind: 'done' as const, finish: 'stop' as const };
    };
    const ledger = { scopeId: 'scope-a', async listWorkers() { return { schemaVersion: 1, scopeId: 'scope-a', sources: [] } as never; }, async inspectRun() { return null; },
      async decideApproval(approval: { approvalId: string; revision: number }, decision: 'allow' | 'deny') {
        decided.push({ approvalId: approval.approvalId, revision: approval.revision, decision }); release();
        return { approvalId: approval.approvalId, runId: '-', taskId: '-', summary: '', requester: '-', revision: 1, status: 'decided' as const, decision, expiresAt: 0 };
      } };
    const view = mount({ streamTurn, ledger: ledger as never });
    await settle(20); await view.type('edit it\r');
    await view.card('A-TITLE', 'turn approval card');
    expect(view.stdout.text).toContain('edit_file · src/a.ts · 0123456789ab'); expect(view.stdout.text).toContain('+new line');
    expect(view.stdout.text).toContain('A-PREVIEW-MORE 10'); expect(view.stdout.text).not.toContain('ctx 29');
    await view.type('y');
    await until(() => view.frame().includes('Edited.') && !view.frame().includes('A-TITLE'), 'turn continues with the card closed');
    expect(decided).toEqual([{ approvalId: 'appr-1', revision: 0, decision: 'allow' }]);
  });

  it('closes the card without a decision when the approval settles elsewhere (expiry, cancel)', async () => {
    const decided: unknown[] = [];
    const streamTurn = async function* () {
      yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'c1', approvalId: 'appr-2', revision: 0, summary: 'grep · x · 0123456789ab',
        preview: 'grep {}', expiresAt: Date.now() + 600_000 };
      await settle(150);
      yield { kind: 'approval' as const, phase: 'settled' as const, callId: 'c1', approvalId: 'appr-2', outcome: 'expired' as const };
      yield { kind: 'text' as const, text: 'Gave up.' }; yield { kind: 'done' as const, finish: 'stop' as const };
    };
    const ledger = { scopeId: 'scope-a', async listWorkers() { return { schemaVersion: 1, scopeId: 'scope-a', sources: [] } as never; }, async inspectRun() { return null; },
      async decideApproval(...args: unknown[]) { decided.push(args); throw new Error('must not decide'); } };
    const view = mount({ streamTurn, ledger: ledger as never });
    await settle(20); await view.type('go\r');
    await view.card('A-TITLE', 'card');
    await until(() => view.frame().includes('Gave up.') && !view.frame().includes('A-TITLE'), 'turn ends with the card closed');
    expect(decided).toEqual([]);
  });

  // Astra 2092 R1 (inverted repro): A's decision commits, the turn settles A and asks B, then A's delayed answer (success or failure)
  // arrives; it closes only its own card, so B's card stays open and B is still decided on its own.
  for (const late of ['answers', 'fails'] as const) {
    it(`keeps the newer call's card open when the earlier decision ${late} late`, async () => {
      let decideStarted!: () => void, finishDecision!: () => void, finishTurn!: () => void;
      const started = new Promise<void>(resolve => { decideStarted = resolve; });
      const reply = new Promise<void>(resolve => { finishDecision = resolve; });
      const end = new Promise<void>(resolve => { finishTurn = resolve; });
      const decided: string[] = [];
      const streamTurn = async function* () {
        yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'a', approvalId: 'approval-a', revision: 0,
          summary: 'FIRST-CARD', preview: 'read first', expiresAt: Date.now() + 600_000 };
        await started;
        yield { kind: 'approval' as const, phase: 'settled' as const, callId: 'a', approvalId: 'approval-a', outcome: 'allow' as const };
        yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'b', approvalId: 'approval-b', revision: 0,
          summary: 'SECOND-CARD', preview: 'read second', expiresAt: Date.now() + 600_000 };
        await end;
        yield { kind: 'text' as const, text: 'Both done.' }; yield { kind: 'done' as const, finish: 'stop' as const };
      };
      const ledger = { scopeId: 'scope-a', async listWorkers() { return { schemaVersion: 1, scopeId: 'scope-a', sources: [] } as never; }, async inspectRun() { return null; },
        async decideApproval(approval: { approvalId: string }, decision: 'allow' | 'deny') {
          decided.push(`${approval.approvalId}:${decision}`);
          if (approval.approvalId === 'approval-a') {
            decideStarted(); await reply;
            if (late === 'fails') throw new Error('late failure');
          } else finishTurn();
          return { approvalId: approval.approvalId, runId: '-', taskId: '-', summary: '', requester: '-', revision: 1, status: 'decided' as const, decision, expiresAt: 0 };
        } };
      const view = mount({ streamTurn, ledger: ledger as never });
      await settle(20); await view.type('go\r');
      await view.card('FIRST-CARD', 'first card'); await view.type('y');
      await view.card('SECOND-CARD', 'second card'); finishDecision();
      await until(() => view.stdout.text.includes(late === 'answers' ? 'A-ALLOWED approval-a' : 'ERR:late failure'), 'late answer shown');
      await settle(40);
      expect(view.frame()).toContain('SECOND-CARD'); expect(view.frame()).toContain('A-PROMPT');
      await view.type('y');
      await until(() => view.frame().includes('Both done.') && !view.frame().includes('A-TITLE'), 'second decided, turn ends');
      expect(decided).toEqual(['approval-a:allow', 'approval-b:allow']);
    });
  }

  it('closes the card and says so when the service could not confirm closing the request (unsettled)', async () => {
    const streamTurn = async function* () {
      yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'c1', approvalId: 'appr-3', revision: 0, summary: 'edit_file · x · 0123456789ab',
        preview: 'diff', expiresAt: Date.now() + 600_000 };
      await settle(150);
      yield { kind: 'approval' as const, phase: 'settled' as const, callId: 'c1', approvalId: 'appr-3', outcome: 'unsettled' as const };
      yield { kind: 'done' as const, finish: 'cancelled' as const };
    };
    const ledger = { scopeId: 'scope-a', async listWorkers() { return { schemaVersion: 1, scopeId: 'scope-a', sources: [] } as never; }, async inspectRun() { return null; },
      async decideApproval() { throw new Error('must not decide'); } };
    const view = mount({ streamTurn, ledger: ledger as never });
    await settle(20); await view.type('go\r');
    await view.card('A-TITLE', 'card');
    await until(() => view.stdout.text.includes('A-UNSETTLED appr-3') && !view.frame().includes('A-TITLE'), 'card closed with the unsettled notice');
  });
});

// PERSISTENT-APPROVALS G6: a card the service marks with standing scopes offers exactly those keys; the choice reaches the port as a typed
// argument; the view shows what the service answered (saved or the reason), and never offers a key the service did not name.
describe('work surface: approval card with standing scopes (G6)', () => {
  const scoped = (scopes: readonly ('session' | 'always')[], id: string) => async function* () {
    yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'c1', approvalId: id, revision: 0, summary: 'run_shell · npm test · 0123456789ab',
      preview: '$ npm test', expiresAt: Date.now() + 600_000, standing: { scopes, pattern: 'npm test' } };
    await settle(400);
    yield { kind: 'text' as const, text: 'Done.' }; yield { kind: 'done' as const, finish: 'stop' as const };
  };
  const port = (calls: unknown[][], answer: (standing: string | undefined) => unknown = () => undefined) => ({ scopeId: 'scope-a', async listWorkers() { return { schemaVersion: 1, scopeId: 'scope-a', sources: [] } as never; },
    async inspectRun() { return null; },
    async decideApproval(approval: { approvalId: string; revision: number }, decision: 'allow' | 'deny', standing?: string) {
      calls.push([approval.approvalId, decision, standing]);
      return { approvalId: approval.approvalId, runId: '-', taskId: '-', summary: '', requester: '-', revision: 1, status: 'decided' as const, decision, expiresAt: 0, ...(answer(standing) as object ?? {}) };
    } });
  const open = async (scopes: readonly ('session' | 'always')[], calls: unknown[][], answer?: (standing: string | undefined) => unknown) => {
    const view = mount({ streamTurn: scoped(scopes, 'appr-s') as never, ledger: port(calls, answer) as never });
    await settle(20); await view.type('run it\r');
    await view.card('A-TITLE', 'scoped card');
    return view;
  };

  it('shows what a standing answer covers and the offered keys; s and a decide allow with that scope and report what the service saved', async () => {
    const calls: unknown[][] = [];
    const view = await open(['session', 'always'], calls, standing => ({ standing: { scope: standing, saved: true } }));
    expect(view.stdout.text).toContain('S-COVERS npm test'); expect(view.stdout.text).toContain('S-PROMPT-BOTH');
    await view.type('a');
    await until(() => view.stdout.text.includes('S-SAVED-ALWAYS appr-s'), 'always saved shown');
    expect(calls).toEqual([['appr-s', 'allow', 'always']]);
    const session: unknown[][] = [];
    const second = await open(['session', 'always'], session, standing => ({ standing: { scope: standing, saved: true } }));
    await second.type('s');
    await until(() => second.stdout.text.includes('S-SAVED-SESSION appr-s'), 'session saved shown');
    expect(session).toEqual([['appr-s', 'allow', 'session']]);
  });

  it('a scope the service did not offer is not a key; y stays once, n and Enter deny; a not-saved answer is shown with its reason', async () => {
    const onlySession: unknown[][] = [];
    const view = await open(['session'], onlySession);
    expect(view.stdout.text).toContain('S-PROMPT-SESSION'); expect(view.stdout.text).not.toContain('S-PROMPT-BOTH');
    await view.type('a'); await settle(60);
    expect(onlySession).toEqual([]);
    await view.type('y');
    await until(() => view.stdout.text.includes('A-ALLOWED appr-s'), 'once');
    expect(onlySession).toEqual([['appr-s', 'allow', undefined]]);
    const refused: unknown[][] = [];
    const second = await open(['session', 'always'], refused, standing => ({ standing: { scope: standing, saved: false, reason: 'STANDING_DELEGATION' } }));
    await second.type('a');
    await until(() => second.stdout.text.includes('S-NOT-SAVED-ALWAYS appr-s STANDING_DELEGATION'), 'not saved shown');
    const denied: unknown[][] = [];
    const third = await open(['session', 'always'], denied);
    await third.type('\r');
    await until(() => third.stdout.text.includes('A-DENIED appr-s'), 'enter denies');
    expect(denied).toEqual([['appr-s', 'deny', undefined]]);
  });

  it('without standing scopes the card is the plain y/N card: s and a do nothing', async () => {
    const calls: unknown[][] = [];
    const view = mount({ streamTurn: (async function* () {
      yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'c1', approvalId: 'appr-p', revision: 0, summary: 's', preview: 'p', expiresAt: Date.now() + 600_000 };
      await settle(400);
      yield { kind: 'done' as const, finish: 'stop' as const };
    }) as never, ledger: port(calls) as never });
    await settle(20); await view.type('go\r');
    await view.card('A-PROMPT', 'plain card');
    await view.type('sa'); await settle(60);
    expect(calls).toEqual([]);
    await view.type('n');
    await until(() => view.stdout.text.includes('A-DENIED appr-p'), 'denied');
  });

  it('shows the whole pattern a standing answer covers: 200 characters, inner double spaces and all — never clipped or flattened', async () => {
    const pattern = `echo ${'x'.repeat(60)}  ${'y'.repeat(120)}`;
    const view = mount({ streamTurn: (async function* () {
      yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'c1', approvalId: 'appr-w', revision: 0, summary: 's', preview: 'p', expiresAt: Date.now() + 600_000,
        standing: { scopes: ['session' as const], pattern } };
      await settle(400);
      yield { kind: 'done' as const, finish: 'stop' as const };
    }) as never, ledger: port([]) as never });
    await settle(20); await view.type('go\r');
    await view.card('S-COVERS', 'covers line');
    expect(view.stdout.text).toContain(`S-COVERS ${pattern}`);
    await view.type('n');
  });
});
