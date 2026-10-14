import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EffectConfirmationView, RunView } from '#engine/index.js';
import type { WorklineLedgerPorts } from '#surfaces/core/terminal-ledger/index.js';
import { awaitingDeliveryTargets, consentMatches, deliveryLines, shellWord, type DeliveryAnswer, type DeliveryPreview, type TerminalDeliveryPort } from '#surfaces/core/terminal-delivery/index.js';
import { deliveryWindowLabels, workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { pendingBrainFixture } from '../support/brain-proposal.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { SLASH_WINDOW_TEST_LABELS } from '../support/slash-window-labels.js';

// TESLIM-PENCERESI (owner 2026-10-14): "bu teslimleri neden CLI'dan yapıyorum; … bana sorulması gerekiyorsa terminalden bana sorsun".
// The real Workline on an in-memory TTY with a recording port that calls the window's answer exactly where the production confirmation port
// does (after preparation, before the reference is written). The real port, Git and a real controlling PTY are in terminal-delivery-pty-process.
const EN = workSurfaceLabels('en'), WORDS = deliveryWindowLabels('en');
const focus = { composer: 'INPUT-FOCUS', window: 'WINDOW-FOCUS', decide: 'DECIDE-HINT' }, CTRL_O = '\u000f', CTRL_T = '\u0014', ESC = '\u001b', CTRL_U = '\u0015', DOWN = '\u001b[B';
const BASE = 'b'.repeat(40), COMMIT = 'c'.repeat(40), REF = `refs/deckent/deliveries/${'d'.repeat(64)}`;
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });

const brief = (outlook: string) => ({ schemaVersion: 1, attemptId: 'a', claimLabel: 'CLAIM', report: null, evaluation: { verdict: 'accepted' }, runDelivery: null, openIssues: null,
  deliveryOutlook: outlook });
function run(state: RunView['state'], phase: string, outlook?: string, id = 'r', title = 'ORDER-TASK'): RunView {
  return { schemaVersion: 3, scopeId: 's', runId: id, revision: outlook ? 3 : 1, cancellationRequested: false, state,
    tasks: [{ id: 'task', phase, ...(outlook ? { resultBrief: brief(outlook) } : {}),
      taskBrief: { schemaVersion: 1, task: title, scopePaths: [], acceptance: null, criteria: [], profile: null, model: null, effort: null, contextRefs: [] } }] } as unknown as RunView;
}
const RUNNING = { kind: 'running' } as const, COMPLETED = { kind: 'terminal', outcome: 'completed', reason: 'completed' } as const;
const awaiting = (id = 'r', title = 'ORDER-TASK') => run(COMPLETED, 'accepted', 'awaiting-delivery', id, title);

type PortOptions = { targets?: readonly string[]; failFirst?: { code: string; message: string }; failAdopt?: { code: string; message: string }; viewFiles?: readonly string[] };
/** Records every step; `answer` is asked where the production port asks it, with the card the engine would build. */
function recordingPort(options: PortOptions = {}) {
  const calls: string[] = [], views: EffectConfirmationView[] = [];
  const card = (preview: DeliveryPreview, commandId: string, extra: Partial<EffectConfirmationView>): EffectConfirmationView => ({ operation: 'deliver-integration',
    scopeId: preview.identity.scopeId, commandId, actor: { id: 'owner', issuer: 'host', subject: '1000' }, resource: REF, from: BASE, to: COMMIT,
    runId: preview.identity.runId, taskId: preview.identity.taskId, title: 'Ship order', files: options.viewFiles ?? ['note.txt'], added: 1, removed: 1, ...extra });
  const ask = async (answer: DeliveryAnswer, view: EffectConfirmationView) => {
    views.push(view);
    if (!await answer(view)) throw Object.assign(new Error('declined'), { code: 'DELIVERY_CONFIRMATION_DECLINED' });
  };
  const port: TerminalDeliveryPort = {
    async preview(target) {
      calls.push(`preview:${target.runId}`);
      return { target, identity: { scopeId: target.scopeId, runId: target.runId, taskId: target.taskId, attemptId: 'a', layoutRevision: 'l', generation: 1 },
        files: [{ path: 'note.txt', added: 1, removed: 1 }], added: 1, removed: 1, source: 'SOURCE-FINGERPRINT', base: BASE, proposal: 'P'.repeat(20), outOfScope: [],
        adoptionTargets: options.targets ?? [] };
    },
    async deliver(preview, ids, answer) {
      calls.push('available');
      if (options.failFirst) { const failure = options.failFirst; delete options.failFirst; throw Object.assign(new Error(failure.message), { code: failure.code }); }
      calls.push('prepare'); await ask(answer, card(preview, ids.delivery, {})); calls.push('publish');
      return { ref: REF, commit: COMMIT, commandId: ids.delivery };
    },
    async adopt(preview, delivery, targetRef, commandId, answer) {
      calls.push('available');
      // As the engine: a required verification is checked before the branch card is asked (no answer, no move).
      if (options.failAdopt) throw Object.assign(new Error(options.failAdopt.message), { code: options.failAdopt.code });
      await ask(answer, card(preview, commandId, { operation: 'adopt-integration', resource: targetRef, from: BASE, to: delivery.commit, files: [] }));
      calls.push(`adopt:${targetRef}`);
      return { targetRef, fromCommit: BASE, toCommit: delivery.commit };
    },
  };
  return { port, calls, views };
}

/** A real Workline whose /do admits one Run (no approval); the Run then reaches acceptance with a patch awaiting delivery. */
function harness(options: PortOptions & { port?: boolean; scopeRuns?: readonly RunView[] } = {}) {
  let current: RunView = run(RUNNING, 'active');
  const recorded = recordingPort(options), pending = pendingBrainFixture();
  const ledger = { scopeId: 's', workerHeartbeatMs: 60_000, listRunIds: async () => (options.scopeRuns ?? [current]).map(item => item.runId),
    inspectRun: async (id: string) => options.scopeRuns?.find(item => item.runId === id) ?? current,
    listWorkers: async () => ({ schemaVersion: 1, scopeId: 's', sources: [] }), listApprovalPage: async () => ({ items: [], nextAfter: null }) } as unknown as WorklineLedgerPorts;
  const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, windows: SLASH_WINDOW_TEST_LABELS, focus, work: EN, delivery: WORDS }, ledger, pollMs: 25, maxTrackedRuns: 4,
    ...(options.port === false ? {} : { delivery: { port: recorded.port, confirmTimeoutMs: 60_000 } }),
    doPlan: { planning: 'PLANNING', cancelHint: 'CANCEL', requestHint: 'REQUEST', lines: () => ['PLAN-RESULT'],
      plan: async () => ({ ...pending, run: current, proposal: { ...pending.proposal, status: 'accepted', approval: null } }) } }, 160, { rows: 48 });
  mounted.push(view.instance);
  return { view, ...recorded, set: (next: RunView) => { current = next; } };
}
type Harness = ReturnType<typeof harness>;
const frame = (h: Harness) => h.view.stdout.frame;
const transcript = (h: Harness) => h.view.stdout.text;
const press = async (h: Harness, keys: string, ms = 60) => { h.view.stdin.write(keys); await settle(ms); };
/** /do admits the Run; its automatic result and /tasks windows are closed explicitly, as a person would. */
async function admit(h: Harness) {
  await settle(80); await press(h, '/do process order\r');
  await until(() => frame(h).includes('PLAN-RESULT'), 'result window'); await press(h, CTRL_O); await press(h, ESC);
  await until(() => frame(h).includes(EN.live!.tasksTitle), 'automatic /tasks'); await press(h, CTRL_O); await press(h, ESC);
  await until(() => frame(h).includes(`ORDER-TASK · ${EN.jobs!.runStates['running']}`), 'running row');
}
const windowTitle = 'Delivery · ORDER-TASK';

describe('delivery window — pure rules', () => {
  it('lists only accepted, work-input tasks of finished Runs whose patch awaits delivery', () => {
    expect(awaitingDeliveryTargets([awaiting('a'), run(RUNNING, 'accepted', 'awaiting-delivery', 'b'), run(COMPLETED, 'accepted', 'none', 'c'), run(COMPLETED, 'failed', 'awaiting-delivery', 'd'),
      { ...awaiting('e'), tasks: [{ ...awaiting('e').tasks[0]!, taskBrief: { ...awaiting('e').tasks[0]!.taskBrief!, task: null } }] } as RunView], 'FALLBACK').map(target => target.runId)).toEqual(['a']);
    expect(awaitingDeliveryTargets([awaiting('a', 'First line\nsecond')], 'FALLBACK')[0]).toMatchObject({ key: 's:a:task', title: 'First line' });
  });
  it('matches a consent only to the same operation, ids, command, file set and base (delivery) or branch and commit (adoption)', () => {
    const view = { operation: 'deliver-integration', scopeId: 's', commandId: 'd', actor: { id: 'o', issuer: 'i', subject: 's' }, resource: REF, from: BASE, to: COMMIT,
      runId: 'r', taskId: 't', title: 'x', files: ['b', 'a'], added: 1, removed: 1 } as const;
    const consent = { operation: 'deliver-integration', scopeId: 's', runId: 'r', taskId: 't', commandId: 'd', files: ['a', 'b'], from: BASE } as const;
    expect(consentMatches(consent, view)).toBe(true);
    for (const changed of [{ files: ['a'] }, { files: ['a', 'b', 'c'] }, { from: 'e'.repeat(40) }, { commandId: 'other' }, { runId: 'x' }, { operation: 'adopt-integration' as const }])
      expect(consentMatches(consent, { ...view, ...changed })).toBe(false);
    const adopt = { operation: 'adopt-integration', scopeId: 's', runId: 'r', taskId: 't', commandId: 'a', resource: 'refs/heads/main', to: COMMIT } as const;
    expect(consentMatches(adopt, { ...view, operation: 'adopt-integration', commandId: 'a', resource: 'refs/heads/main', files: [] })).toBe(true);
    expect(consentMatches(adopt, { ...view, operation: 'adopt-integration', commandId: 'a', resource: 'refs/heads/other', files: [] })).toBe(false);
    expect(consentMatches(adopt, { ...view, operation: 'adopt-integration', commandId: 'a', resource: 'refs/heads/main', to: 'f'.repeat(40), files: [] })).toBe(false);
  });
});

describe('delivery window on the real Workline', () => {
  it('appears on acceptance without taking the composer; composer y never confirms; Ctrl+O then y checks, prepares and delivers once', async () => {
    const h = harness(); await admit(h);
    h.set(awaiting());
    await until(() => frame(h).includes(windowTitle) && frame(h).includes('note.txt | +1 -1'), 'self-appearing window');
    expect(frame(h)).toContain('INPUT-FOCUS'); expect(frame(h)).toContain(`ORDER-TASK · ${EN.activeWork!.deliveryWaiting}`);
    expect(frame(h)).toContain(`affected files match base ${BASE.slice(0, 12)}`); expect(frame(h)).toContain('refs/deckent/deliveries/');
    expect(frame(h)).toContain(WORDS.hints); expect(h.calls).toEqual(['preview:r']);
    expect(frame(h)).toContain('DECIDE-HINT'); // the waiting decision window says how to reach it
    // A composer keystroke is typing, never a confirmation.
    await press(h, 'y'); await press(h, 'es-draft'); expect(frame(h)).toContain('yes-draft'); expect(h.calls).toEqual(['preview:r']); await press(h, CTRL_U);
    await press(h, CTRL_O); expect(frame(h)).toContain('WINDOW-FOCUS'); expect(frame(h)).not.toContain('DECIDE-HINT');
    await press(h, 'y', 120);
    await until(() => frame(h).includes(`Delivered: commit ${COMMIT}`), 'delivered result line');
    expect(h.calls).toEqual(['preview:r', 'available', 'prepare', 'publish']);
    // One answer, consumed by the port's card that matched what was shown: no second card was needed.
    expect(h.views).toHaveLength(1); expect(frame(h)).not.toContain(WORDS.confirmBody);
    expect(transcript(h)).toContain(`Delivered ORDER-TASK: commit ${COMMIT.slice(0, 12)} at ${REF}`);
    expect(frame(h)).not.toContain(WORDS.adoptHints); // no adoption targets configured: no branch choice at all
    await press(h, '\r', 100);
    expect(frame(h)).not.toContain(windowTitle); expect(frame(h)).not.toContain(`ORDER-TASK · ${EN.activeWork!.deliveryWaiting}`);
    await press(h, 'after'); expect(frame(h)).toContain('after'); await press(h, CTRL_U); // the composer holds input again
    await press(h, '/deliver\r', 150);
    await until(() => frame(h).includes(WORDS.none), 'nothing more to deliver'); // a task delivered in this session is never offered again
  });

  it('n and Esc write nothing, leave the task waiting in the strip, and the strip reopens it in the foreground', async () => {
    const h = harness(); await admit(h); h.set(awaiting());
    await until(() => frame(h).includes(windowTitle) && frame(h).includes(WORDS.hints), 'window ready');
    await press(h, CTRL_O); await press(h, 'n', 100);
    expect(frame(h)).not.toContain(windowTitle); expect(h.calls).toEqual(['preview:r']);
    expect(transcript(h)).toContain('Delivery left waiting: ORDER-TASK. /deliver opens it again.');
    expect(frame(h)).toContain(`ORDER-TASK · ${EN.activeWork!.deliveryWaiting}`);
    await press(h, CTRL_T); await press(h, '\r', 120); // the waiting delivery is the first row after /do
    await until(() => frame(h).includes(windowTitle) && frame(h).includes(WORDS.hints), 'reopened');
    expect(frame(h)).toContain('WINDOW-FOCUS'); // a person-opened window takes focus
    await press(h, ESC, 100);
    expect(frame(h)).not.toContain(windowTitle); expect(h.calls.filter(call => call !== 'preview:r')).toEqual([]);
  });

  it('a stale base is refused in human words with the next step; nothing is prepared or written', async () => {
    const h = harness({ failFirst: { code: 'PATCH_BASE_ADVANCED', message: 'The delivery base changed.' } }); await admit(h); h.set(awaiting());
    await until(() => frame(h).includes(windowTitle) && frame(h).includes(WORDS.hints), 'window ready');
    await press(h, CTRL_O); await press(h, 'y', 120);
    await until(() => frame(h).includes('ERR:The delivery base changed.'), 'typed refusal');
    expect(frame(h)).toContain(WORDS.next['PATCH_BASE_ADVANCED']!.slice(0, 40)); expect(h.calls).toEqual(['preview:r', 'available']);
    await press(h, ESC, 100);
    expect(transcript(h)).toContain('Delivery not done: ORDER-TASK — ERR:The delivery base changed.');
    expect(frame(h)).toContain(`ORDER-TASK · ${EN.activeWork!.deliveryWaiting}`); // still waiting: /deliver or the strip open it again
  });

  it('refuses a session that is not a verified terminal before any preparation, with the next step', async () => {
    const h = harness({ failFirst: { code: 'DELIVERY_INTERACTIVE_REQUIRED', message: 'Delivery/adoption requires a verified human terminal.' } }); await admit(h); h.set(awaiting());
    await until(() => frame(h).includes(windowTitle) && frame(h).includes(WORDS.hints), 'window ready');
    await press(h, CTRL_O); await press(h, 'y', 120);
    await until(() => frame(h).includes('requires a verified human terminal'), 'refusal');
    expect(frame(h)).toContain(WORDS.next['DELIVERY_INTERACTIVE_REQUIRED']!.slice(0, 40)); expect(h.calls).toEqual(['preview:r', 'available']);
  });

  it('adoption is offered only with configured targets and moves the chosen branch only after a second, separate y', async () => {
    const h = harness({ targets: ['refs/heads/main', 'refs/heads/release'] }); await admit(h); h.set(awaiting());
    await until(() => frame(h).includes(windowTitle) && frame(h).includes(WORDS.hints), 'window ready');
    expect(frame(h)).toContain('adopting into a branch is a separate choice: refs/heads/main, refs/heads/release');
    await press(h, CTRL_O); await press(h, 'y', 120);
    await until(() => frame(h).includes(WORDS.adoptHints), 'adoption choice');
    expect(h.calls).toEqual(['preview:r', 'available', 'prepare', 'publish']); // delivered; no branch moved yet
    await press(h, DOWN); expect(frame(h)).toMatch(/› refs\/heads\/release/u);
    await press(h, 'y', 120);
    await until(() => frame(h).includes(`Adopted: refs/heads/release ${BASE} → ${COMMIT}`), 'adopted');
    expect(h.calls.at(-1)).toBe('adopt:refs/heads/release'); expect(h.views.map(view => view.operation)).toEqual(['deliver-integration', 'adopt-integration']);
    expect(transcript(h)).toContain(`Adopted into refs/heads/release: ${BASE.slice(0, 12)} → ${COMMIT.slice(0, 12)}.`);
  });

  it('a required verification refuses adoption here with the exact command-line next step; the branch is never moved', async () => {
    const h = harness({ targets: ['refs/heads/main'], failAdopt: { code: 'ADOPTION_NOT_VERIFIED', message: 'This installation requires a verification Run for adoption.' } });
    await admit(h); h.set(awaiting());
    await until(() => frame(h).includes(windowTitle) && frame(h).includes(WORDS.hints), 'window ready');
    await press(h, CTRL_O); await press(h, 'y', 120);
    await until(() => frame(h).includes(WORDS.adoptHints), 'adoption choice');
    await press(h, 'y', 120);
    await until(() => frame(h).includes('ERR:This installation requires a verification Run'), 'refusal');
    expect(frame(h)).toContain(WORDS.next['ADOPTION_NOT_VERIFIED']!.slice(0, 40));
    expect(h.calls.some(call => call.startsWith('adopt:'))).toBe(false); expect(h.views.map(view => view.operation)).toEqual(['deliver-integration']);
    // The next step names this attempt, its delivery command and the chosen branch, ready to add --verification-run.
    const rows = deliveryLines({ target: { key: 's:r:task', scopeId: 's', runId: 'r', taskId: 'task', title: 'ORDER-TASK' } as never,
      stage: { kind: 'failed', error: 'ERR', code: 'ADOPTION_NOT_VERIFIED' }, selected: 0, adopted: null,
      delivered: { ref: REF, commit: COMMIT, commandId: 'terminal-delivery-1' },
      preview: { identity: { scopeId: 's', runId: 'r', taskId: 'task', attemptId: 'a', layoutRevision: 'l', generation: 1 }, adoptionTargets: ['refs/heads/main'],
        files: [], added: 0, removed: 0, source: 'S', base: BASE, proposal: 'P'.repeat(20), outOfScope: [] } as never }, WORDS);
    expect(rows.at(-1)!.spans.map(part => part.text).join('')).toContain('`deckent task integration-adopt --scope s --run r --task task --attempt a --generation 1'
      + ' --layout-revision l --command-id <new-id> --delivery-command-id terminal-delivery-1 --target refs/heads/main --verification-run <run>`');
  });

  it('the suggested command keeps every hostile identity one shell word and runs no side command (Astra 2543 P1)', () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'deckent-shell-word-')), 'MARKER');
    const hostile = { scope: "s 1", run: `r;touch ${marker}`, task: `task$(touch ${marker})`, attempt: "a'b", layout: 'l`touch ' + marker + '`', target: 'refs/heads/feat x' };
    const rows = deliveryLines({ target: { key: 'k', scopeId: hostile.scope, runId: hostile.run, taskId: hostile.task, title: 'ORDER-TASK' } as never,
      stage: { kind: 'failed', error: 'ERR', code: 'ADOPTION_NOT_VERIFIED' }, selected: 0, adopted: null,
      delivered: { ref: REF, commit: COMMIT, commandId: "d'1 $(x)" },
      preview: { identity: { scopeId: hostile.scope, runId: hostile.run, taskId: hostile.task, attemptId: hostile.attempt, layoutRevision: hostile.layout, generation: 1 },
        adoptionTargets: [hostile.target], files: [], added: 0, removed: 0, source: 'S', base: BASE, proposal: 'P'.repeat(20), outOfScope: [] } as never }, WORDS);
    const text = rows.at(-1)!.spans.map(part => part.text).join(''), start = text.indexOf('deckent task integration-adopt'), command = text.slice(start, text.lastIndexOf('`'));
    // The person fills the two placeholders and pastes the line into a POSIX shell; here printf stands in for deckent and prints argv.
    const filled = command.replace('<new-id>', 'adopt-1').replace('<run>', 'v-1').replace(/^deckent /u, "printf '%s\\n' ");
    const argv = execFileSync('sh', ['-c', filled], { encoding: 'utf8' }).trimEnd().split('\n');
    expect(argv).toEqual(['task', 'integration-adopt', '--scope', hostile.scope, '--run', hostile.run, '--task', hostile.task, '--attempt', hostile.attempt,
      '--generation', '1', '--layout-revision', hostile.layout, '--command-id', 'adopt-1', '--delivery-command-id', "d'1 $(x)", '--target', hostile.target,
      '--verification-run', 'v-1']);
    expect(existsSync(marker)).toBe(false);
    expect(shellWord('refs/heads/main')).toBe('refs/heads/main'); expect(shellWord("a'b")).toBe(`'a'\\''b'`);
  });

  it('n after delivery finishes without adopting; the branch is never moved', async () => {
    const h = harness({ targets: ['refs/heads/main'] }); await admit(h); h.set(awaiting());
    await until(() => frame(h).includes(windowTitle) && frame(h).includes(WORDS.hints), 'window ready');
    await press(h, CTRL_O); await press(h, 'y', 120);
    await until(() => frame(h).includes(WORDS.adoptHints), 'adoption choice');
    await press(h, 'n', 100);
    expect(frame(h)).not.toContain(windowTitle); expect(h.calls.some(call => call.startsWith('adopt:'))).toBe(false);
    expect(transcript(h)).toContain(`Not adopted into a branch; the delivery stays at ${REF}.`);
    expect(frame(h)).not.toContain(`ORDER-TASK · ${EN.activeWork!.deliveryWaiting}`);
  });

  it('a port card that differs from what was shown is displayed exactly and needs a fresh y; n declines without writing', async () => {
    const h = harness({ viewFiles: ['note.txt', 'unexpected.txt'] }); await admit(h); h.set(awaiting());
    await until(() => frame(h).includes(windowTitle) && frame(h).includes(WORDS.hints), 'window ready');
    await press(h, CTRL_O); await press(h, 'y', 120);
    await until(() => frame(h).includes(WORDS.confirmBody) && frame(h).includes('unexpected.txt'), 'exact port card');
    expect(frame(h)).toContain(`Reference ${REF} · ${BASE} → `); // the exact line hard-wraps at the window width expect(h.calls).toEqual(['preview:r', 'available', 'prepare']);
    await press(h, 'n', 120);
    await until(() => frame(h).includes(WORDS.next['DELIVERY_CONFIRMATION_DECLINED']!), 'declined');
    expect(h.calls).not.toContain('publish');
  });

  it('a differing card confirmed with its own y delivers', async () => {
    const h = harness({ viewFiles: ['note.txt', 'unexpected.txt'] }); await admit(h); h.set(awaiting());
    await until(() => frame(h).includes(windowTitle) && frame(h).includes(WORDS.hints), 'window ready');
    await press(h, CTRL_O); await press(h, 'y', 120);
    await until(() => frame(h).includes(WORDS.confirmBody), 'exact port card');
    await press(h, 'y', 120);
    await until(() => frame(h).includes(`Delivered: commit ${COMMIT}`), 'delivered');
    expect(h.calls).toEqual(['preview:r', 'available', 'prepare', 'publish']);
  });

  it('/deliver lists the scope\'s waiting tasks; the chosen window opens in the foreground', async () => {
    const h = harness({ scopeRuns: [awaiting('r1', 'FIRST-TASK'), awaiting('r2', 'SECOND-TASK'), run(COMPLETED, 'accepted', 'none', 'r3', 'NOTHING-TASK')] });
    await settle(80); await press(h, '/deliver\r', 150);
    await until(() => frame(h).includes(WORDS.pickerTitle) && frame(h).includes('SECOND-TASK'), 'picker');
    expect(frame(h)).not.toContain('NOTHING-TASK');
    await press(h, DOWN); await press(h, '\r', 150);
    await until(() => frame(h).includes('Delivery · SECOND-TASK') && frame(h).includes(WORDS.hints), 'chosen window');
    expect(frame(h)).toContain('WINDOW-FOCUS'); expect(h.calls).toEqual(['preview:r2']);
  });

  it('/deliver says the part is unavailable without the trusted delivery port', async () => {
    const h = harness({ port: false }); await settle(80);
    await press(h, '/deliver\r', 150);
    await until(() => transcript(h).includes('NO-PORT deliver'), 'unavailable');
  });
});
