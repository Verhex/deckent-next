import { appendFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { planRun } from '../../../src/index.js';
import { DeckentError, formatHumanError } from '#platform/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import type { RunView } from '#engine/index.js';
import type { WorklineApproval, WorklineLedgerPorts } from '#surfaces/core/terminal-ledger/index.js';
import { brainProposalLines } from '#surfaces/core/run-planning/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { pendingBrainFixture } from '../support/brain-proposal.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { SLASH_WINDOW_TEST_LABELS } from '../support/slash-window-labels.js';
const mounted: ReturnType<typeof mountWorkline>[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const view of mounted.splice(0)) view.instance.unmount();
  for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks(); });
const words = { planning: 'PLANNING', cancelHint: 'Esc / Ctrl+C cancel', requestHint: 'Write /do <intent>' };
const run = { schemaVersion: 3, runId: 'r', scopeId: 's', revision: 1, cancellationRequested: false, state: { kind: 'running' },
  tasks: [{ id: 'task', phase: 'pending', taskBrief: { task: 'Purchase readback', model: null }, resultBrief: null }] } as unknown as RunView;
it.skipIf(process.platform === 'win32').each(['en', 'tr'] as const)('/do displays the real inactive-model refusal in %s before provider or proposal', async locale => {
  const f = await brainProviderFixture({ model: 'inactive' }); cleanups.push(f.close);
  let failure: unknown;
  const view = mountWorkline({ errorText: error => { failure = error; return formatHumanError(error, { locale, noColor: true }); },
    doPlan: { ...words, lines: result => brainProposalLines(result, locale),
      plan: (intent, commandId, signal) => planRun(f.project, { schemaVersion: 1, scopeId: 's', commandId, intent }, f.options, signal) } });
  mounted.push(view); await settle(40); view.stdin.write('/do Prepare purchase\r');
  await until(() => view.stdout.text.includes('MODEL_NOT_ACTIVATED'), 'typed inactive-model result');
  expect(failure).toMatchObject({ code: 'MODEL_NOT_ACTIVATED', params: { scope: 's', model: f.reference.modelId } });
  expect(view.stdout.text).toContain(locale === 'tr' ? 'kapsamında etkin değil' : 'not active in scope');
  expect(view.stdout.text).toContain('deckent models activate'); expect(f.posts).toBe(0);
  if (process.env.DECKENT_L1_FRAME_PROOF) appendFileSync(process.env.DECKENT_L1_FRAME_PROOF, `\n## DO inactive ${locale}\n${view.stdout.frame}\n`);
});
it.each(['y', 'n'])('/do preserves the rich-terminal intent; the actual approval card %s precedes replay and Run navigation', async key => {
  const pending = pendingBrainFixture(), plans: { intent: string; id: string }[] = [], decisions: string[] = [];
  const history: string[] = [];
  let decision: 'allow' | 'deny' | null = null;
  const approval: WorklineApproval = { approvalId: 'brain-approval', runId: 'r', taskId: '-', requester: 'owner', revision: 0,
    status: 'pending', decision: null, summary: 'Create the proposed Run', expiresAt: pending.proposal.approval!.expiresAt };
  const ledger: WorklineLedgerPorts = { scopeId: 's', workerHeartbeatMs: 60_000, listRunIds: async () => decision === 'allow' ? ['r'] : [],
    inspectRun: async () => decision === 'allow' ? run : null, listWorkers: async () => ({ schemaVersion: 1, scopeId: 's', observedAt: Date.now(), sources: [] }),
    listApprovalPage: async () => ({ items: decision ? [] : [approval], nextAfter: null }),
    decideApproval: async (target, answer) => { expect(target.approvalId).toBe(approval.approvalId); decision = answer; decisions.push(answer);
      return { ...target, status: 'decided', revision: 1, decision: answer }; } };
  const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, windows: SLASH_WINDOW_TEST_LABELS, work: workSurfaceLabels('en') }, ledger, pollMs: 60_000,
    inputHistory: { load: async () => [], append: entry => { history.push(entry.text); } }, doPlan: { ...words,
      async plan(intent, id) { plans.push({ intent, id }); return decision ? { ...pending, run: decision === 'allow' ? run : null,
        proposal: { ...pending.proposal, status: decision === 'allow' ? 'accepted' : 'rejected', approval: null } } : pending; },
      lines: result => brainProposalLines(result, 'en') } }); mounted.push(view);
  await settle(40); view.stdin.write('/do Prepare purchase api_key=sk-fixture\r');
  await until(() => view.stdout.frame.includes('Durable business evidence'), 'actual approval preview');
  expect(decisions).toEqual([]); expect(plans).toHaveLength(1); expect(plans[0]!.intent).toBe('Prepare purchase api_key=[REDACTED]');
  expect(history).toEqual(['/do Prepare purchase api_key=[REDACTED]']);
  expect(view.stdout.frame).toContain('no total Run spending limit is enforced');
  if (process.env.DECKENT_L1_FRAME_PROOF) appendFileSync(process.env.DECKENT_L1_FRAME_PROOF, `\n## DO approval ${key}\n${view.stdout.frame}\n`);
  await settle(40); view.stdin.write(key); // slice 2: the card holds the keyboard by itself; approve/deny it, then assert the effect.
  await until(() => plans.length === 2 && view.stdout.frame.includes(key === 'y' ? 'Admitted; task outcomes are not yet accepted' : 'Rejected'), 'recorded result window');
  expect(decisions).toEqual([key === 'y' ? 'allow' : 'deny']); expect(plans[1]).toEqual(plans[0]);
  if (process.env.DECKENT_L1_FRAME_PROOF) appendFileSync(process.env.DECKENT_L1_FRAME_PROOF, `\n## DO result ${key}\n${view.stdout.frame}\n`);
  await settle(40); view.stdin.write('\u000f'); await settle(40); view.stdin.write('\r'); // the automatic result window still needs Ctrl+O (not a decision)
  if (key === 'y') await until(() => view.stdout.frame.includes('Watching'), 'tasks observation after result');
  else { await until(() => !view.stdout.frame.includes('Rejected'), 'closed'); view.stdin.write('/do Revised request\r');
    await until(() => plans.length === 3, 'new request'); expect(plans[2]!.id).not.toBe(plans[0]!.id); }
});
it('/do planning keeps composer input; Ctrl+C aborts that request before any approval or Run path', async () => {
  let signal: AbortSignal | undefined, aborts = 0, approvals = 0;
  const view = mountWorkline({ doPlan: { ...words, lines: () => [], plan: async (_intent, _id, received) => {
    signal = received; return new Promise((_resolve, reject) => received.addEventListener('abort', () => { aborts++; reject(new Error('cancelled')); }, { once: true }));
  } }, ledger: { scopeId: 's', workerHeartbeatMs: 60_000, listApprovalPage: async () => { approvals++; return { items: [], nextAfter: null }; } } as never,
  pollMs: 60_000, approvalPollMs: 60_000 }); mounted.push(view);
  await settle(40); view.stdin.write('/do Prepare purchase\r'); await until(() => view.stdout.frame.includes('PLANNING'), 'planning window');
  const before = approvals; await settle(40); view.stdin.write('\u0003');
  await until(() => signal?.aborted === true && !view.stdout.frame.includes('PLANNING'), 'cancelled planning');
  expect(aborts).toBe(1); expect(approvals).toBe(before);
});
it('a cancellation crossing an already-started admission does not hide its returned durable Run identity', async () => {
  const pending = pendingBrainFixture();
  let release: ((result: typeof pending) => void) | undefined, signal: AbortSignal | undefined;
  const view = mountWorkline({ doPlan: { ...words, lines: result => brainProposalLines(result, 'en'), plan: async (_intent, _id, received) => {
    signal = received; return new Promise(resolve => { release = resolve; });
  } } }); mounted.push(view);
  await settle(40); view.stdin.write('/do Prepare purchase\r'); await until(() => view.stdout.frame.includes('PLANNING'), 'handoff');
  await settle(40); view.stdin.write('\u0003'); await until(() => signal?.aborted === true, 'local cancellation');
  release!({ ...pending, run, proposal: { ...pending.proposal, status: 'accepted', reason: null, approval: null } });
  await until(() => view.stdout.text.includes('Run r admitted. Follow /tasks or /monitor.'), 'returned admission remains visible');
});
const HERE = { title: 'RUN HERE?', effect: 'NO DELIVERY CARD', run: 'RUN-HERE-ROW', setup: 'SETUP-ROW', cancel: 'CANCEL-ROW', noWorkers: 'NEEDS GIT', prompt: 'choose', cancelled: 'NOT RUN' };
const windowLabels = { labels: { ...WORKLINE_TEST_LABELS, windows: SLASH_WINDOW_TEST_LABELS } };
const offerHere = (code: unknown) => code === 'RUN_ADMISSION_NOT_CONFIGURED';
it.each(['BRAIN_TIER_REFUSED', 'WORKER_CHANNEL_NOT_ACTIVE', 'WORKER_ASSIGNMENT_NONE', 'RUN_POOL_HELD', 'POLICY_DENIED', 'MODEL_NOT_ACTIVATED'])(
  'owner option A (K1/K2): /do refused with %s shows its own refusal and never runs here', async code => {
  const asked: string[] = [];
  const view = mountWorkline({ ...windowLabels, errorText: error => `REFUSED ${(error as DeckentError).code}`, completeTurn: async messages => { asked.push(String(messages.at(-1)?.content)); return 'LOCAL ANSWER'; },
    doPlan: { ...words, localFallback: 'RUNS HERE', offerHere, here: HERE, lines: () => [], plan: async () => { throw new DeckentError(code, code); } } }); mounted.push(view);
  await settle(40); view.stdin.write('/do Read package.json\r');
  await until(() => view.stdout.text.includes(`REFUSED ${code}`), 'refusal shown'); await settle(80);
  expect(asked).toEqual([]); expect(view.stdout.text).not.toContain('RUN HERE?'); expect(view.stdout.text).not.toContain('RUNS HERE');
});
it('owner option A (K4/K5): "nothing set up" asks before any effect every time; Esc cancels with nothing run; y runs here and says so', async () => {
  const asked: string[] = [];
  const view = mountWorkline({ ...windowLabels, errorText: error => `REFUSED ${(error as DeckentError).code}`, completeTurn: async messages => { asked.push(String(messages.at(-1)?.content).split('\n')[0]!); return 'LOCAL ANSWER'; },
    doPlan: { ...words, localFallback: 'RUNS HERE', offerHere, here: HERE, lines: () => [], plan: async () => { throw new DeckentError('RUN_ADMISSION_NOT_CONFIGURED', 'x'); } } }); mounted.push(view);
  await settle(40); view.stdin.write('/do First\r');
  await until(() => view.stdout.frame.includes('RUN HERE?'), 'card'); expect(view.stdout.frame).toContain('NO DELIVERY CARD'); expect(asked).toEqual([]);
  expect(view.stdout.frame).toContain('RUN-HERE-ROW'); expect(view.stdout.frame).toContain('CANCEL-ROW');
  await settle(40); view.stdin.write('\u001b[B'); await until(() => view.stdout.frame.includes('NEEDS GIT'), 'disabled setup reason'); // no Git project: shown disabled with its reason
  view.stdin.write('\r'); await settle(80); expect(asked).toEqual([]); expect(view.stdout.frame).toContain('RUN HERE?'); // a disabled choice does nothing
  view.stdin.write('\u001b'); await until(() => view.stdout.text.includes('NOT RUN'), 'cancelled'); await settle(60); expect(asked).toEqual([]);
  view.stdin.write('/do Second\r'); await until(() => view.stdout.frame.includes('RUN HERE?'), 'card again');
  await settle(40); view.stdin.write('\r'); await until(() => view.stdout.text.includes('LOCAL ANSWER'), 'local turn');
  expect(asked).toEqual(['Second']); expect(view.stdout.text).toContain('RUNS HERE');
  view.stdin.write('/do Third\r'); await until(() => asked.length === 1 && view.stdout.frame.includes('RUN HERE?'), 'card every time');
});
it('owner option A: "Set up workers" opens /setup at its worker steps and runs nothing here', async () => {
  const asked: string[] = [], opened: unknown[] = [];
  const view = mountWorkline({ ...windowLabels, onboarding: { initial: null, open: async (_signal: AbortSignal, focus?: string) => { opened.push(focus); return null; } } as never,
    completeTurn: async messages => { asked.push(String(messages.at(-1)?.content)); return 'LOCAL ANSWER'; },
    doPlan: { ...words, localFallback: 'RUNS HERE', offerHere, here: { ...HERE, canSetup: async () => true }, lines: () => [], plan: async () => { throw new DeckentError('RUN_ADMISSION_NOT_CONFIGURED', 'x'); } } }); mounted.push(view);
  await settle(40); view.stdin.write('/do First\r'); await until(() => view.stdout.frame.includes('SETUP-ROW'), 'card');
  expect(view.stdout.frame).not.toContain('NEEDS GIT');
  await settle(40); view.stdin.write('\u001b[B'); await settle(40); view.stdin.write('\r'); await until(() => opened.length === 1, 'setup opened');
  expect(opened).toEqual(['workers']); await settle(60); expect(asked).toEqual([]);
});
it('BeUser M-07: a plan rejected because no worker can run it shows its refusal first and never runs here', async () => {
  const pending = pendingBrainFixture(), asked: string[] = [];
  const rejected = { ...pending, run: null, reasonParams: { taskId: 'T1', workClass: 'feature', skipped: 'x: WORKER_CHANNEL_NOT_ACTIVE' },
    proposal: { ...pending.proposal, status: 'rejected', reason: 'WORKER_ASSIGNMENT_NONE', approval: null } };
  const view = mountWorkline({ errorText: error => formatHumanError(error, { locale: 'en', noColor: true }),
    completeTurn: async messages => { asked.push(String(messages.at(-1)?.content)); return 'LOCAL ANSWER'; },
    doPlan: { ...words, localFallback: 'RUNS HERE', offerHere, here: HERE, lines: result => brainProposalLines(result, 'en'), plan: async () => rejected as never } }); mounted.push(view);
  await settle(40); view.stdin.write('/do Add sub\r');
  await until(() => view.stdout.text.includes('Connect one of the listed models with /provider'), 'refusal'); await settle(80);
  expect(asked).toEqual([]); expect(view.stdout.text).not.toContain('RUN HERE?');
});

