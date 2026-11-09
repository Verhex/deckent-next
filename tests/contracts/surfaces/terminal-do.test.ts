import { appendFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { planRun } from '../../../src/index.js';
import { DeckentError, formatHumanError } from '#platform/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import type { RunView } from '#engine/index.js';
import type { WorklineApproval, WorklineLedgerPorts } from '#surfaces/core/terminal-ledger/index.js';
import { brainProposalCardLines, brainProposalLines } from '#surfaces/core/run-planning/index.js';
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
      lines: result => brainProposalLines(result, 'en'), cardLines: result => brainProposalCardLines(result, 'en'), dirty: { check: async () => 'STARTS FROM LAST COMMIT', title: 'UNCOMMITTED' } } }); mounted.push(view);
  await settle(40); view.stdin.write('/do Prepare purchase api_key=sk-fixture\r');
  await until(() => view.stdout.frame.includes('Durable business evidence'), 'actual approval preview');
  // Lead 2026-11-09: uncommitted changes are one line on the Run card itself (planned at once, no card before it).
  expect(view.stdout.frame).toContain('UNCOMMITTED. STARTS FROM LAST COMMIT');
  expect(decisions).toEqual([]); expect(plans).toHaveLength(1); expect(plans[0]!.intent).toBe('Prepare purchase api_key=[REDACTED]');
  expect(history).toEqual(['/do Prepare purchase api_key=[REDACTED]']);
  // R9f: the card's preview adds only what its summary does not say (criteria here); budget, scope and the plan header stay out.
  expect(view.stdout.frame).not.toContain('no total Run spending limit is enforced'); expect(view.stdout.frame).not.toContain('Plan for Run r');
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
const HERE = { title: 'RUN HERE?', effect: 'NO DELIVERY CARD', run: 'RUN-HERE-ROW', setup: 'SETUP-ROW', cancel: 'CANCEL-ROW', noWorkers: 'NEEDS GIT', noModel: 'NO MODEL: use /model', prompt: 'choose', cancelled: 'NOT RUN',
  changed: 'CHANGED {files}', unchanged: 'UNCHANGED', unread: 'UNREAD' };
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
it('A62: nothing set up runs directly in the terminal every time, with no worker card or raw admission error', async () => {
  const asked: string[] = [];
  const view = mountWorkline({ ...windowLabels, errorText: error => `REFUSED ${(error as DeckentError).code}`, completeTurn: async messages => { asked.push(String(messages.at(-1)?.content).split('\n')[0]!); return 'LOCAL ANSWER'; },
    doPlan: { ...words, localFallback: 'RUNS HERE', offerHere, here: HERE, lines: () => [], plan: async () => { throw new DeckentError('RUN_ADMISSION_NOT_CONFIGURED', 'x'); } } }); mounted.push(view);
  await settle(40); view.stdin.write('/do First\r'); await until(() => view.stdout.text.includes('LOCAL ANSWER'), 'direct local turn');
  expect(asked).toEqual(['First']); expect(view.stdout.text).not.toContain('RUN HERE?'); expect(view.stdout.text).not.toContain('RUN_ADMISSION_NOT_CONFIGURED');
  expect(view.stdout.text).toContain('NO DELIVERY CARD'); expect(view.stdout.text).toContain('RUNS HERE');
  await until(() => view.stdout.text.includes('UNREAD'), 'honest folder observation');
  view.stdin.write('/do Second\r'); await until(() => asked.length === 2, 'second direct turn'); expect(asked).toEqual(['First', 'Second']);
});
it('A62: direct terminal work preserves the effect explanation and reports the observed changed paths', async () => {
  const asked: string[] = [], trees = [{ state: 'present', files: new Map([['a.txt', '1:1']]) }, { state: 'present', files: new Map([['a.txt', '2:2'], ['b.txt', '3:3']]) }];
  const effect = 'Changes are written to this folder directly: no background Run, no delivery card and no rollback. Your mode, the sandbox and approvals still apply.';
  const view = mountWorkline({ ...windowLabels, completeTurn: async messages => { asked.push(String(messages.at(-1)?.content).split('\n')[0]!); return 'LOCAL ANSWER'; },
    doPlan: { ...words, localFallback: 'RUNS HERE', offerHere, here: { ...HERE, effect }, tree: async () => trees.shift()!, lines: () => [],
      plan: async () => { throw new DeckentError('RUN_ADMISSION_NOT_CONFIGURED', 'x'); } } }, 80, { rows: 24 }); mounted.push(view);
  await settle(40); view.stdin.write('/do First\r');
  await until(() => view.stdout.text.includes('CHANGED a.txt, b.txt'), 'two tree reads'); expect(asked).toEqual(['First']);
  expect(view.stdout.text.replace(/\s+/gu, ' ')).toContain(effect); expect(view.stdout.text).not.toContain('RUN HERE?');
});
it('A62: no chat model gives one next step without a card, admission code or effect', async () => {
  const asked: string[] = [];
  const view = mountWorkline({ ...windowLabels, errorText: error => `REFUSED ${(error as DeckentError).code}`, completeTurn: async messages => { asked.push(String(messages.at(-1)?.content)); return 'LOCAL ANSWER'; },
    doPlan: { ...words, localFallback: 'RUNS HERE', offerHere, chatReady: async () => false, here: HERE, lines: () => [], plan: async () => { throw new DeckentError('RUN_ADMISSION_NOT_CONFIGURED', 'x'); } } }); mounted.push(view);
  await settle(40); view.stdin.write('/do First\r'); await until(() => view.stdout.text.includes('NO MODEL: use /model'), 'next step');
  expect(asked).toEqual([]); expect(view.stdout.text).not.toContain('RUN HERE?'); expect(view.stdout.text).not.toContain('RUN_ADMISSION_NOT_CONFIGURED');
});
it('A62: the separate welcome hands a prompt to normal chat, keeps history and never plans a worker Run', async () => {
  const asked: string[] = [], plans: string[] = [];
  const view = mountWorkline({ ...windowLabels, completeTurn: async messages => { asked.push(String(messages.at(-1)?.content).split('\n')[0]!); return 'LOCAL ANSWER'; },
    onboarding: { initial: { intent: '/do list monthly spending', destination: 'chat', scopeId: 's', folder: '', commandId: 'first-job' }, open: async () => null } as never,
    doPlan: { ...words, lines: () => [], plan: async () => { plans.push('unexpected'); throw new Error('must not plan'); } } }); mounted.push(view);
  await until(() => view.stdout.text.includes('LOCAL ANSWER'), 'normal turn'); expect(asked).toEqual(['/do list monthly spending']); expect(plans).toEqual([]);
  await settle(60); view.stdin.write('\u001b[A'); await until(() => /> ?\/do list monthly spending/u.test(view.stdout.frame), 'Up recalls first job');
});
it('A62: host permission is rechecked before local execution; a model-less normal message stays a draft without opening setup', async () => {
  let offers = 0; const asked: string[] = [], opened: unknown[] = [];
  const view = mountWorkline({ ...windowLabels, onboarding: { modelDraft: 'KEPT AS DRAFT: use /provider', open: async (_signal: AbortSignal, focus?: string) => { opened.push(focus); return null; } } as never,
    completeTurn: async messages => { asked.push(String(messages.at(-1)?.content)); throw new DeckentError('TERMINAL_CHAT_NOT_CONFIGURED', 'x'); },
    doPlan: { ...words, localFallback: 'RUNS HERE', offerHere: () => ++offers === 1, here: HERE, lines: () => [], plan: async () => { throw new DeckentError('RUN_ADMISSION_NOT_CONFIGURED', 'x'); } } }); mounted.push(view);
  await settle(40); view.stdin.write('/do First\r'); await until(() => view.stdout.text.includes('NOT RUN'), 'revoked host permission'); expect(asked).toEqual([]);
  view.stdin.write('Hello model\r'); await until(() => view.stdout.text.includes('KEPT AS DRAFT: use /provider'), 'draft guidance');
  expect(opened).toEqual([]); expect(view.stdout.text).not.toContain('TERMINAL_CHAT_NOT_CONFIGURED'); expect(asked).toHaveLength(1);
  await until(() => /> ?Hello model/u.test(view.stdout.frame), 'draft retained');
});
// alpha.60 B, owner 2026-10-31 rule (b): setup is prepared after the frame; its waiting card opens by itself only while the person has typed nothing.
// Typed-ahead keys never answer it: one line names the waiting steps and the keys stay the draft.
// Astra 2858 B-R2: the condition holds across the input hand-over — a key that arrives after the opening resolved (the hand-over gap), input
// already buffered on the card's stream, or a draft carried over from the launch shell (C) all keep the card closed; nothing typed is lost.
it('alpha.60 B (rule b): the waiting setup card opens by itself only before any key; after one, a single line says how many steps wait', async () => {
  for (const variant of ['none', 'before', 'gap', 'buffered', 'carried'] as const) {
    let prepared!: (opening: unknown) => void; const shown: string[] = [], typed = variant !== 'none';
    const opening = new Promise(resolve => { prepared = resolve; });
    const view = mountWorkline({ completeTurn: async () => 'x', ...(variant === 'carried' ? { initialDraft: { text: 'carried', pastes: [] } } : {}),
      onboarding: { opening, modelDraft: 'D', waiting: (count: number) => `SETUP WAITING ${count}`, open: async () => null, ...(variant === 'buffered' ? { pending: () => true } : {}) } as never }); mounted.push(view);
    await settle(40); if (variant === 'before') { view.stdin.write('ab'); await settle(40); }
    prepared({ total: 3, notice: null, show: async () => { shown.push('card'); return { intent: null, notice: { level: 'info', text: 'AFTER THE CARD' } }; } });
    // The gap: the opening's own reaction has run (the old check point) before this key is written; the key still keeps the card closed.
    if (variant === 'gap') { await Promise.resolve(); await Promise.resolve(); view.stdin.write('ab'); }
    await until(() => view.stdout.text.includes(typed ? 'SETUP WAITING 3' : 'AFTER THE CARD'), `the opening outcome (${variant})`); await settle(40);
    expect(shown, variant).toEqual(typed ? [] : ['card']); expect(view.stdout.text.includes('SETUP WAITING'), variant).toBe(typed);
    if (variant === 'before' || variant === 'gap') expect(view.stdout.frame, variant).toMatch(/> ?ab/u);
    if (variant === 'carried') expect(view.stdout.frame).toMatch(/> ?carried/u);
  }
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

it('BeUser M-32 + alpha.64 B (v31): a chat turn\'s propose_work shows /do\'s quota wait, its one Run card carries /do\'s uncommitted-changes line, and its admitted Run goes to /tasks', async () => {
  // Lead 2026-11-09: the uncommitted-changes text is one line on the one Run card (no card of its own), for /do (the y/n test above) and the chat AI alike.
  const dirty = { check: async () => 'STARTS FROM LAST COMMIT', title: 'UNCOMMITTED' }, plans: string[] = [], decided: string[] = [];
  let waited!: () => void, answered!: () => void; const wait = new Promise<void>(resolve => { waited = resolve; }), answer = new Promise<void>(resolve => { answered = resolve; });
  const streamTurn = async function* () {
    yield { kind: 'tool' as const, phase: 'started' as const, callId: 'w1', name: 'propose_work', target: null, status: null, ms: null };
    yield { kind: 'work' as const, callId: 'w1', phase: 'planning' as const, attempt: 1 };
    yield { kind: 'work' as const, callId: 'w1', phase: 'quota-wait' as const, untilMs: Date.now() + 60_000, attempt: 2, maxAttempts: 3 };
    await wait;
    yield { kind: 'work' as const, callId: 'w1', phase: 'planning' as const, attempt: 2 };
    yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'w1', approvalId: 'run-card', revision: 0, summary: 'Plan · tasks: 1', preview: 'Proposed by the AI in this conversation; you decide.',
      expiresAt: Date.now() + 600_000, tool: 'propose_work', target: null };
    await answer;
    yield { kind: 'approval' as const, phase: 'settled' as const, callId: 'w1', approvalId: 'run-card', outcome: 'allow' as const };
    yield { kind: 'work' as const, callId: 'w1', phase: 'admitted' as const, runId: 'r' };
    yield { kind: 'tool' as const, phase: 'finished' as const, callId: 'w1', name: 'propose_work', target: null, status: 'ok' as const, ms: 5 };
    yield { kind: 'done' as const, finish: 'stop' as const };
  };
  const ledger = { scopeId: 's', workerHeartbeatMs: 60_000, listRunIds: async () => ['r'], inspectRun: async () => run, listWorkers: async () => ({ schemaVersion: 1, scopeId: 's', observedAt: Date.now(), sources: [] }),
    listApprovalPage: async () => ({ items: [], nextAfter: null }),
    decideApproval: async (target: { approvalId: string }, decision: string) => { decided.push(`${target.approvalId}:${decision}`); answered(); return { ...target, runId: '-', taskId: '-', summary: '', requester: '-', revision: 1, status: 'decided', decision, expiresAt: 0 }; } };
  const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, windows: SLASH_WINDOW_TEST_LABELS, work: workSurfaceLabels('en') }, ledger: ledger as never, pollMs: 60_000, streamTurn: streamTurn as never,
    doPlan: { ...words, dirty, quotaWait: progress => ({ body: `WAITING ${progress.attempt}/${progress.maxAttempts}`, hint: 'Esc cancel', untilText: 'soon' }), lines: () => ['PLANNED'],
      plan: async intent => { plans.push(intent); throw new DeckentError('MODEL_NOT_ACTIVATED', 'x'); } } }); mounted.push(view);
  await settle(40); view.stdin.write('add a third line\r');
  await until(() => view.stdout.frame.includes('WAITING 2/3'), 'the /do quota wait window'); waited();
  await until(() => view.stdout.frame.includes('UNCOMMITTED. STARTS FROM LAST COMMIT'), 'the line on the one Run card');
  expect(view.stdout.frame).toContain('Proposed by the AI'); expect(view.stdout.frame).not.toContain('WAITING 2/3');
  await settle(40); view.stdin.write('y'); await until(() => decided.length === 1, 'decided'); expect(decided).toEqual(['run-card:allow']);
  await until(() => view.stdout.frame.includes('Watching'), 'the admitted Run handed to /tasks'); expect(plans).toEqual([]); // the chat path never runs /do's own plan
});

it('RC-C1: a company/pool stop during the model preflight cancels before the local turn', async () => {
  let open = true, checking = false, release!: () => void; const asked: string[] = [];
  const view = mountWorkline({ ...windowLabels, errorText: () => 'Nothing set up', completeTurn: async messages => { asked.push(String(messages.at(-1)?.content)); return 'LOCAL ANSWER'; },
    doPlan: { ...words, localFallback: 'RUNS HERE', offerHere: () => open, chatReady: () => new Promise<boolean>(resolve => { checking = true; release = () => resolve(true); }), here: HERE, lines: () => [], plan: async () => { throw new DeckentError('RUN_ADMISSION_NOT_CONFIGURED', 'x'); } } }); mounted.push(view);
  await settle(40); view.stdin.write('/do First\r'); await until(() => checking, 'model preflight');
  open = false; release(); await until(() => view.stdout.text.includes('NOT RUN'), 'policy recheck cancels');
  expect(asked).toEqual([]); expect(view.stdout.text).not.toContain('RUNS HERE');
});
