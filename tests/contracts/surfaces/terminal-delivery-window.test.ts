import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { targetQueueViewSchema, type QueueConsent, type EffectConfirmationView, type RunView } from '#engine/index.js';
import type { WorklineLedgerPorts } from '#surfaces/core/terminal-ledger/index.js';
import { awaitingDeliveryTargets, consentMatches, deliveryLines, shellWord, type DeliveryAnswer, type DeliveryFileDiff, type DeliveryPreview, type TerminalDeliveryPort,
  type VerificationCandidate } from '#surfaces/core/terminal-delivery/index.js';
import { deliveryWindowLabels, workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { patchDiffs, terminalDeliveryPort } from '#surfaces/core/cli-terminal/index.js';
import { pendingBrainFixture } from '../support/brain-proposal.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { SLASH_WINDOW_TEST_LABELS } from '../support/slash-window-labels.js';
import { homeEnv } from '../support/host-platform.js';
import { ErrorRegistry, type DeckentError } from '#platform/index.js';

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

type PortOptions = { diffs?: readonly DeliveryFileDiff[]; targets?: readonly string[]; failFirst?: { code: string; message: string }; failAdopt?: { code: string; message: string }; viewFiles?: readonly string[];
  /** Y1: the installation's verification bar, the candidates each read returns (in order; the last repeats), and refusals by verification Run. */
  verification?: { kind: string; required: boolean }; candidates?: (readonly VerificationCandidate[])[]; refuseRun?: Readonly<Record<string, string>> };
/** Records every step; `answer` is asked where the production port asks it, with the card the engine would build. */
function recordingPort(options: PortOptions = {}) {
  const calls: string[] = [], views: EffectConfirmationView[] = [], adoptions: { commandId: string; verificationRunId: string | undefined }[] = [];
  let reads = 0;
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
        files: options.diffs ? options.diffs.map(diff => ({ path: diff.path, added: 1, removed: 1 })) : [{ path: 'note.txt', added: 1, removed: 1 }], ...(options.diffs ? { diffs: options.diffs } : {}), added: 1, removed: 1, source: 'SOURCE-FINGERPRINT', base: BASE, proposal: 'P'.repeat(20), outOfScope: [],
        adoptionTargets: options.targets ?? [], verification: options.verification ?? null };
    },
    async deliver(preview, ids, answer) {
      calls.push('available');
      if (options.failFirst) { const failure = options.failFirst; delete options.failFirst; throw Object.assign(new Error(failure.message), { code: failure.code }); }
      calls.push('prepare'); await ask(answer, card(preview, ids.delivery, {})); calls.push('publish');
      return { ref: REF, commit: COMMIT, commandId: ids.delivery };
    },
    async adopt(preview, delivery, targetRef, commandId, answer, verificationRunId) {
      calls.push('available'); adoptions.push({ commandId, verificationRunId });
      // As the engine: a named verification Run is checked (kind, commit, bar, phase) before the branch card is asked.
      const refused = verificationRunId === undefined ? undefined : options.refuseRun?.[verificationRunId];
      if (refused) throw Object.assign(new Error(`verification ${verificationRunId} refused`), { code: refused });
      if (options.verification?.required && verificationRunId === undefined) throw Object.assign(new Error('verification required'), { code: 'ADOPTION_NOT_VERIFIED' });
      // As the engine: a required verification is checked before the branch card is asked (no answer, no move).
      if (options.failAdopt) throw Object.assign(new Error(options.failAdopt.message), { code: options.failAdopt.code });
      await ask(answer, card(preview, commandId, { operation: 'adopt-integration', resource: targetRef, from: BASE, to: delivery.commit, files: [] }));
      calls.push(`adopt:${targetRef}`);
      return { targetRef, fromCommit: BASE, toCommit: delivery.commit, commandId, verifiedBy: verificationRunId ?? null };
    },
    async verificationRuns() {
      calls.push('verification-runs'); const all = options.candidates ?? [[]];
      return all[Math.min(reads++, all.length - 1)]!;
    },
  };
  return { port, calls, views, adoptions };
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
/** Window rows hard-wrap long exact lines at the frame width: compare without whitespace and frame borders. */
const squeeze = (text: string) => text.replace(/[│┃\s]+/gu, '');
const press = async (h: Harness, keys: string, ms = 60) => { h.view.stdin.write(keys); await settle(ms); };
/** /do admits the Run; its automatic result and /tasks windows are closed explicitly, as a person would. */
async function admit(h: Harness) {
  await settle(80); await press(h, '/do process order\r');
  await until(() => frame(h).includes('PLAN-RESULT'), 'result window'); await press(h, CTRL_O); await press(h, ESC);
  await until(() => frame(h).includes(EN.live!.tasksTitle), 'automatic /tasks'); await press(h, CTRL_O); await press(h, ESC);
  await until(() => frame(h).includes(`ORDER-TASK · r · ${EN.jobs!.runStates['running']}`), 'running row');
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

describe('verification candidates (cli-terminal port, read-only)', () => {
  const identity = { scopeId: 's', runId: 'r', taskId: 'task', attemptId: 'a', layoutRevision: 'l', generation: 1 };
  const preview = { identity } as unknown as DeliveryPreview;
  const task = (kind: string, phase: string, id = 'check') => ({ id, kind, phase });
  function project(verification: unknown) {
    const root = mkdtempSync(join(tmpdir(), 'deckent-verify-candidates-')); mkdirSync(join(root, '.deckent'));
    writeFileSync(join(root, '.deckent', 'config.json'), JSON.stringify({ execution: { docker: { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}`, memoryBytes: 2147483648, pids: 128, cpus: 2, logMaxSizeKiB: 1024, logMaxFiles: 2,
      tmpBytes: 1048576, deadlineMs: 60000, controlTimeoutMs: 5000, outputBytes: 65536 }, git: { gitExecutable: 'git', timeoutMs: 5000 }, adoption: { targets: ['refs/heads/main'], ...(verification ? { verification } : {}) } } }));
    return root;
  }
  const bar = { kind: 'verify', required: true, criteria: [{ evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  function port(root: string, pages: readonly (readonly string[])[], views: Readonly<Record<string, readonly ReturnType<typeof task>[]>>, reader = true) {
    const inventoryCalls: (string | null)[] = [], inspected: string[] = [];
    const handlers = { inspectInventory: async (_root: string, query: { after: string | null }) => {
      inventoryCalls.push(query.after); const index = query.after === null ? 0 : Number(query.after);
      return { schemaVersion: 1, layout: {}, page: { entries: (pages[index] ?? []).map(runId => ({ identity: { ...identity, runId } })), nextAfter: index + 1 < pages.length ? String(index + 1) : null } };
    }, previewWorkspacePatch: async () => ({}), checkWorkspaceIntegration: async () => ({}), prepareWorkspaceIntegration: async () => ({}), renderUnifiedDiff: () => '',
      interactiveDelivery: () => ({}), ...(reader ? { inspectRun: async (_root: string, query: { runId: string }) => {
        inspected.push(query.runId); return { schemaVersion: 1, layout: {}, run: views[query.runId] ? { runId: query.runId, tasks: views[query.runId] } : null };
      } } : {}) };
    return { port: terminalDeliveryPort(root, handlers as never, { env: homeEnv(join(root, 'home')) })!, inventoryCalls, inspected };
  }

  it('lists only accepted one-task Runs of the configured kind; never the delivering Run, another kind, two tasks or an unfinished/failed task', async () => {
    const { port: subject, inspected } = port(project(bar), [['r', 'v-ok', 'v-two', 'v-kind'], ['v-failed', 'v-evaluating', 'v-ok', 'v-missing']], {
      r: [task('verify', 'accepted')], 'v-ok': [task('verify', 'accepted')], 'v-two': [task('verify', 'accepted'), task('verify', 'accepted', 'second')],
      'v-kind': [task('coding', 'accepted')], 'v-failed': [task('verify', 'failed')], 'v-evaluating': [task('verify', 'evaluating')] });
    expect(await subject.verificationRuns(preview)).toEqual([{ runId: 'v-ok', taskId: 'check' }]);
    expect(inspected).not.toContain('r'); expect(inspected.filter(id => id === 'v-ok')).toHaveLength(1); // the delivering Run is never read; each Run once
  });

  it('stops reading the inventory at the scan bound', async () => {
    const ids = Array.from({ length: 450 }, (_, index) => `v-${index}`), pages = [ids.slice(0, 150), ids.slice(150, 300), ids.slice(300)];
    const { port: subject, inventoryCalls, inspected } = port(project(bar), pages, Object.fromEntries(ids.map(id => [id, [task('verify', 'accepted')]])));
    expect(await subject.verificationRuns(preview)).toHaveLength(200);
    expect(inventoryCalls).toEqual([null, '1']); expect(inspected).toHaveLength(200);
  });

  it('says why instead of "none exists": no configured kind, or no Run reader in this terminal', async () => {
    await expect(port(project(null), [['v-ok']], { 'v-ok': [task('verify', 'accepted')] }).port.verificationRuns(preview)).rejects.toMatchObject({ code: 'ADOPTION_VERIFICATION_NOT_CONFIGURED' });
    await expect(port(project(bar), [['v-ok']], {}, false).port.verificationRuns(preview)).rejects.toMatchObject({ code: 'INVENTORY_UNAVAILABLE' });
  });
});

describe('queue preparation without a work target (cli-terminal port)', () => {
  it('refuses with its own work-target message, in English and Turkish, before anything is queued', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deckent-queue-no-target-')); mkdirSync(join(root, '.deckent'));
    writeFileSync(join(root, '.deckent', 'config.json'), JSON.stringify({ execution: { docker: { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}`, memoryBytes: 2147483648, pids: 128, cpus: 2,
      logMaxSizeKiB: 1024, logMaxFiles: 2, tmpBytes: 1048576, deadlineMs: 60000, controlTimeoutMs: 5000, outputBytes: 65536 }, git: { gitExecutable: 'git', timeoutMs: 5000 }, adoption: { targets: ['refs/heads/main'] } } }));
    const identity = { scopeId: 's', runId: 'r', taskId: 'task', attemptId: 'a', layoutRevision: 'l', generation: 1 }, enqueued: unknown[] = [];
    const handlers = { inspectInventory: async () => ({ schemaVersion: 1, layout: {}, page: { entries: [{ identity }], nextAfter: null } }),
      previewWorkspacePatch: async () => ({}), checkWorkspaceIntegration: async () => ({}), prepareWorkspaceIntegration: async () => ({}), renderUnifiedDiff: () => '', interactiveDelivery: () => ({}),
      deliveryQueue: { async enqueueTargetQueue(input: unknown) { enqueued.push(input); throw new Error('must-not-enqueue'); } }, confirmDeliveryQueue: async () => { throw new Error('must-not-confirm'); } };
    const subject = terminalDeliveryPort(root, handlers as never, { env: homeEnv(join(root, 'home')) })!;
    const refusal = await subject.queue!.prepareCurrent({ scopeId: 's', runId: 'r', taskId: 'task' } as never, 'terminal-queue-1').catch((error: unknown) => error as DeckentError);
    expect(refusal).toMatchObject({ code: 'QUEUE_WORK_TARGET_REQUIRED' }); expect(enqueued).toEqual([]);
    // Not the verified-terminal text: it names the missing setting, the command and the /config panel.
    const [en, tr] = (['en', 'tr'] as const).map(locale => ErrorRegistry.get('QUEUE_WORK_TARGET_REQUIRED', locale)!.message);
    for (const message of [en!, tr!]) {
      expect(message).toContain('deckent config set execution.workTargets'); expect(message).toContain('/config');
      expect(message).not.toBe(ErrorRegistry.get('QUEUE_AUTHORITY_REQUIRED', 'en')!.message);
    }
    expect(en).toContain('No work target is configured'); expect(tr).toContain('çalışma hedefi');
    expect(tr).not.toContain('doğrulanmış gerçek terminal'); expect(en).not.toContain('verified controlling terminal');
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
    // BETA-BELGE: the adoption and delivery command ids are on the result line, so the person can roll back with the CLI.
    const [adoption] = h.adoptions;
    expect(adoption!.commandId).toMatch(/^terminal-adopt-/u); expect(adoption!.verificationRunId).toBeUndefined();
    expect(squeeze(frame(h))).toContain(squeeze(`not verified · adoption command ${adoption!.commandId}`));
    expect(squeeze(transcript(h))).toContain(squeeze(`Adopted into refs/heads/release: ${BASE.slice(0, 12)} → ${COMMIT.slice(0, 12)} (not verified). Adoption command ${adoption!.commandId}`));
    expect(squeeze(transcript(h))).toMatch(/deliverycommandterminal-delivery-[0-9a-f-]{36}\./u);
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

  it('Ctrl+Y, Alt+y and a coalesced Ctrl+O y never deliver, confirm or adopt; only a single typed y does (TERMINAL-UX)', async () => {
    const CTRL_Y = '\u0019', ALT_Y = `${ESC}y`, COALESCED = `${CTRL_O}y`;
    const h = harness({ targets: ['refs/heads/main'], viewFiles: ['note.txt', 'unexpected.txt'] }); await admit(h); h.set(awaiting());
    await until(() => frame(h).includes(windowTitle) && frame(h).includes(WORDS.hints), 'window ready');
    await press(h, CTRL_O); expect(frame(h)).toContain('WINDOW-FOCUS');
    // ready → deliver
    for (const keys of [CTRL_Y, ALT_Y, COALESCED]) { await press(h, keys, 120); expect(h.calls).toEqual(['preview:r']); }
    expect(frame(h)).toContain(windowTitle);
    await press(h, '\r', 120); expect(h.calls).toEqual(['preview:r']); expect(frame(h)).toContain(windowTitle); // Enter decides nothing either
    await press(h, 'y', 120);
    // confirm (a port card that differs from what was shown)
    await until(() => frame(h).includes(WORDS.confirmBody), 'exact port card');
    for (const keys of [CTRL_Y, ALT_Y]) { await press(h, keys, 120); expect(h.calls).toEqual(['preview:r', 'available', 'prepare']); }
    expect(frame(h)).toContain(WORDS.confirmBody);
    await press(h, 'y', 120);
    // delivered → adopt
    await until(() => frame(h).includes(WORDS.adoptHints), 'adoption choice');
    expect(h.calls).toEqual(['preview:r', 'available', 'prepare', 'publish']);
    for (const keys of [CTRL_Y, ALT_Y, '\r']) { await press(h, keys, 120); expect(h.calls.some(call => call.startsWith('adopt:'))).toBe(false); }
    expect(frame(h)).toContain(WORDS.adoptHints);
    await press(h, 'y', 120);
    await until(() => h.calls.at(-1) === 'adopt:refs/heads/main', 'adopted by the typed y');
    expect(h.calls.filter(call => call.startsWith('adopt:'))).toHaveLength(1);
  });

  // Y1 (owner 2026-10-14): adoption with a verification Run from this window, as `task integration-adopt --verification-run` does.
  const REQUIRED = { kind: 'verify', required: true } as const, V1 = { runId: 'verify-run-1', taskId: 'check' }, V2 = { runId: 'verify-run-2', taskId: 'check' };
  async function toVerification(h: Harness) {
    await admit(h); h.set(awaiting());
    await until(() => frame(h).includes(windowTitle) && frame(h).includes(WORDS.hints), 'window ready');
    await press(h, CTRL_O); await press(h, 'y', 120);
    await until(() => frame(h).includes(WORDS.adoptHints), 'adoption choice');
    await press(h, 'y', 120);
    await until(() => frame(h).includes('Verification for refs/heads/main: choose an accepted Run of kind verify'), 'verification step');
  }

  it('a configured verification: the branch y opens the choice; Ctrl+Y, Alt+y, a coalesced key and Enter never adopt; y adopts with the chosen Run', async () => {
    const CTRL_Y = '\u0019', ALT_Y = `${ESC}y`, COALESCED = `${CTRL_O}y`, UP = '\u001b[A';
    const h = harness({ targets: ['refs/heads/main'], verification: REQUIRED, candidates: [[V1, V2]] }); await toVerification(h);
    await until(() => frame(h).includes('Run verify-run-2 · task check · accepted'), 'candidates');
    expect(frame(h)).toContain(WORDS.verifyHints); expect(frame(h)).not.toContain('Adopt without verification'); // required: no unverified row
    expect(frame(h)).toMatch(/› Run verify-run-1/u);
    for (const keys of [CTRL_Y, ALT_Y, COALESCED, '\r']) { await press(h, keys, 120); expect(h.adoptions).toEqual([]); }
    expect(frame(h)).toContain(WORDS.verifyHints);
    await press(h, DOWN); expect(frame(h)).toMatch(/› Run verify-run-2/u); await press(h, UP); await press(h, DOWN);
    await press(h, 'y', 150);
    await until(() => h.calls.at(-1) === 'adopt:refs/heads/main', 'adopted');
    expect(h.adoptions).toHaveLength(1); expect(h.adoptions[0]!.verificationRunId).toBe('verify-run-2');
    await until(() => squeeze(frame(h)).includes(squeeze(`verified by Run verify-run-2 · adoption command ${h.adoptions[0]!.commandId}`)), 'result line with the command');
    expect(squeeze(transcript(h))).toContain(squeeze(`(verified by Run verify-run-2). Adoption command ${h.adoptions[0]!.commandId}`));
  });

  it('no accepted verification Run: says so and how to make one for this delivery; y does nothing; r reads again and then y adopts', async () => {
    const h = harness({ targets: ['refs/heads/main'], verification: REQUIRED, candidates: [[], [V1]] }); await toVerification(h);
    await until(() => frame(h).includes(WORDS.verifyNoneHints), 'none hints');
    expect(frame(h)).toContain('No accepted Run of kind verify exists in this scope yet.');
    const flat = squeeze(frame(h));
    expect(flat).toMatch(/--delivery-command-idterminal-delivery-[0-9a-f-]{36};/u); expect(flat).toContain('deckentruncreate--scopes');
    await press(h, 'y', 120); expect(h.adoptions).toEqual([]);
    await press(h, 'r', 120);
    await until(() => frame(h).includes('Run verify-run-1 · task check · accepted'), 'read again');
    expect(h.calls.filter(call => call === 'verification-runs')).toHaveLength(2);
    await press(h, 'y', 150);
    await until(() => h.calls.at(-1) === 'adopt:refs/heads/main', 'adopted');
    expect(h.adoptions.map(item => item.verificationRunId)).toEqual(['verify-run-1']);
  });

  it('an optional verification also offers adopting without one, recorded as not verified', async () => {
    const h = harness({ targets: ['refs/heads/main'], verification: { kind: 'verify', required: false }, candidates: [[V1]] }); await toVerification(h);
    await until(() => frame(h).includes('Adopt without verification'), 'unverified row');
    await press(h, DOWN); expect(frame(h)).toMatch(/› Adopt without verification/u);
    await press(h, 'y', 150);
    await until(() => h.calls.at(-1) === 'adopt:refs/heads/main', 'adopted');
    expect(h.adoptions.map(item => item.verificationRunId)).toEqual([undefined]);
    await until(() => squeeze(frame(h)).includes('notverified·adoptioncommand'), 'not verified result');
  });

  it('a refused verification Run returns to the choice with the typed reason; nothing moved; a retry is a new adoption command', async () => {
    const h = harness({ targets: ['refs/heads/main'], verification: REQUIRED, candidates: [[V1, V2]], refuseRun: { 'verify-run-1': 'ADOPTION_VERIFICATION_MISMATCH' } });
    await toVerification(h);
    await until(() => frame(h).includes('Run verify-run-1 · task check · accepted'), 'candidates');
    await press(h, 'y', 150);
    await until(() => frame(h).includes('ERR:verification verify-run-1 refused'), 'typed refusal in the step');
    expect(frame(h)).toContain(WORDS.verifyHints); expect(h.calls.some(call => call.startsWith('adopt:'))).toBe(false);
    expect(h.views.map(view => view.operation)).toEqual(['deliver-integration']);
    await press(h, DOWN); await press(h, 'y', 150);
    await until(() => h.calls.at(-1) === 'adopt:refs/heads/main', 'adopted with the second Run');
    expect(h.adoptions.map(item => item.verificationRunId)).toEqual(['verify-run-1', 'verify-run-2']);
    expect(h.adoptions[1]!.commandId).not.toBe(h.adoptions[0]!.commandId);
  });

  it('n, Esc and Ctrl+C in the verification step go back to the branch choice; the branch is never moved', async () => {
    for (const key of ['n', ESC, '\u0003']) {
      const h = harness({ targets: ['refs/heads/main'], verification: REQUIRED, candidates: [[V1]] }); await toVerification(h);
      await until(() => frame(h).includes('Run verify-run-1'), 'candidates');
      await press(h, key, 150);
      await until(() => frame(h).includes(WORDS.adoptHints), 'back at the branch choice');
      expect(h.adoptions).toEqual([]); expect(frame(h)).toContain(windowTitle);
      for (const view of mounted.splice(0)) view.unmount();
    }
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


it('routes a registered target into the queue and asks each exact batch card with a fresh single y', async () => {
  const h = harness(), originalPreview = h.port.preview;
  const display = { schemaVersion: 1, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' } as const;
  let commandId = '', state = 'queued', phase = 0;
  const view = () => targetQueueViewSchema.parse({ schemaVersion: 1, commandId, identity: { scopeId: 's', runId: 'r', taskId: 'task', attemptId: 'a', generation: 1, layoutRevision: 'l' },
    operation: 'delivery', target: { kind: 'git-ref', id: 'refs/heads/integration' }, display, state, outcome: state === 'settled' ? 'adopted' : null,
    revision: phase, observedAt: Date.now(), freshness: 'last-known', position: state === 'settled' ? null : 1,
    nextAction: state === 'awaiting-confirmation' ? 'confirm-batch' : state === 'settled' ? 'inspect-receipt' : 'wait-service', responsibility: 'service', basis: null, verification: null, evidenceRefs: [] });
  h.port.preview = async target => ({ ...await originalPreview(target), queueTarget: 'refs/heads/integration' });
  h.port.queue = {
    async prepareCurrent(_target, id) { commandId = id; h.calls.push('enqueue'); return view(); },
    async inspect() { return view(); },
    async confirm(_scope, _command, ask) {
      for (const operation of ['publish', 'adopt'] as const) {
        const card: Omit<QueueConsent, 'capability'> = { schemaVersion: 1, digest: 'd'.repeat(64), operation, expiresAt: Date.now() + 60000,
          target: { kind: 'git-ref', id: 'refs/heads/integration' }, display, items: [{ commandId, from: BASE, to: COMMIT, candidateDigest: 'c'.repeat(64), verificationReceipt: 'e'.repeat(64), changes: ['note.txt'] }] };
        if (!await ask(card)) throw new Error('declined'); phase++;
      }
      state = 'settled'; h.calls.push('queue-settled'); return { settledPrefix: 1, items: [{ commandId, published: true, state: 'settled' }] };
    },
  };
  await admit(h); h.set(awaiting()); await until(() => frame(h).includes(windowTitle) && frame(h).includes(WORDS.hints), 'delivery ready');
  await press(h, CTRL_O); await press(h, 'y'); await until(() => frame(h).includes('Queued'), 'durable queue state');
  expect(h.calls).toContain('enqueue'); expect(h.calls).not.toContain('prepare'); expect(h.calls).not.toContain('publish');
  state = 'awaiting-confirmation'; await press(h, 'r'); await press(h, 'y');
  await until(() => frame(h).includes('Publish delivery references'), 'exact publication card');
  await press(h, 'yy'); await press(h, '\u0019'); expect(phase).toBe(0);
  await press(h, 'y'); await until(() => frame(h).includes('Adopt the verified prefix'), 'separate adoption card'); expect(phase).toBe(1);
  await press(h, 'y'); await until(() => frame(h).includes('Adopted'), 'retained queue result'); expect(phase).toBe(2);
  expect(h.calls).toContain('queue-settled');
});

it('offers current-base queue preparation after a typed stale-base refusal', async () => {
  const h = harness(), queued: string[] = [];
  h.port.preview = async () => { throw Object.assign(new Error('base advanced'), { code: 'PATCH_BASE_ADVANCED' }); };
  h.port.queue = { async prepareCurrent(_target, command) { queued.push(command); throw new Error('adapter unavailable'); }, async inspect() { return null; }, async confirm() { throw new Error('must-not-confirm'); } };
  await admit(h); h.set(awaiting()); await until(() => frame(h).includes('base advanced'), 'typed base refusal');
  // The re-prepare key is offered next to closing, never instead of it.
  expect(frame(h)).toContain(WORDS.queue!.reprepare); expect(frame(h)).toContain(WORDS.failedHints);
  await press(h, CTRL_O); await press(h, 'r'); await until(() => frame(h).includes('adapter unavailable'), 'queue preparation refusal');
  expect(queued).toHaveLength(1); expect(h.calls).not.toContain('publish');
  // A refusal `r` cannot act on offers only closing.
  expect(frame(h)).not.toContain(WORDS.queue!.reprepare); expect(frame(h)).toContain(WORDS.failedHints);
  await press(h, 'r'); expect(queued).toHaveLength(1);
});

it('without a queue port a stale-base refusal offers only closing; r does nothing', async () => {
  const h = harness();
  h.port.preview = async () => { throw Object.assign(new Error('base advanced'), { code: 'PATCH_BASE_ADVANCED' }); };
  await admit(h); h.set(awaiting()); await until(() => frame(h).includes('base advanced'), 'typed base refusal');
  expect(frame(h)).toContain(WORDS.failedHints); expect(frame(h)).not.toContain(WORDS.queue!.reprepare);
  await press(h, CTRL_O); await press(h, 'r'); expect(frame(h)).toContain('base advanced'); expect(h.calls).not.toContain('prepare');
});

// Read-only diff inside the delivery window (alpha.46): the port carries bounded per-file hunks, the window shows them; seeing never delivers.
describe('bounded per-file diffs (cli-terminal port)', () => {
  const file = (text: string | null) => text === null ? null : { text, mode: '100644', digest: 'd' };
  const render = (path: string, before: string | null, after: string | null) => ['--- a/' + path, '+++ b/' + path, '@@ -1 +1 @@', `-${before ?? ''}`, `+${after ?? ''}`].join('\n');
  const change = (path: string, before: string | null, after: string | null) => ({ path, before: file(before), after: file(after) }) as never;
  it('renders a normal change; a NUL, a byte-oversized side and files beyond the file bound carry a typed reason and never reach the renderer', () => {
    let rendered = 0;
    const count = (path: string, before: string | null, after: string | null) => { rendered++; return render(path, before, after); };
    const [normal, binary, big] = patchDiffs([change('a.txt', 'x\n', 'y\n'), change('b.bin', 'a\0b', 'c'), change('c.txt', 'x', 'y'.repeat(70_000))], count);
    expect(normal).toMatchObject({ path: 'a.txt', lines: ['@@ -1 +1 @@', '-x', '+y'], hidden: 0, unavailable: null });
    expect(binary).toMatchObject({ path: 'b.bin', lines: [], unavailable: 'binary' }); expect(big).toMatchObject({ path: 'c.txt', lines: [], unavailable: 'too-large' });
    expect(rendered).toBe(1);
    const many = patchDiffs(Array.from({ length: 52 }, (_, index) => change(`f${String(index).padStart(2, '0')}.txt`, 'x', 'y')), render);
    expect(many.slice(0, 50).every(diff => diff.unavailable === null)).toBe(true); expect(many.slice(50).map(diff => diff.unavailable)).toEqual(['too-large', 'too-large']);
  });
  it('cuts a long body at the line bound and counts what it hid; a mode-only change shows its mode line', () => {
    const [long] = patchDiffs([change('l.txt', 'x', 'y')], () => ['--- a', '+++ b', ...Array.from({ length: 600 }, (_, index) => `+line ${index}`)].join('\n'));
    expect(long!.lines).toHaveLength(400); expect(long!.hidden).toBe(200);
    const [mode] = patchDiffs([{ path: 'm.sh', before: { text: 'same', mode: '100644', digest: 'd' }, after: { text: 'same', mode: '100755', digest: 'e' } } as never], render);
    expect(mode!.lines).toEqual(['mode 100644 -> 100755 m.sh']);
  });
  it('the real port keeps the Attempt, base and proposal of the preview and adds the diffs of the same patch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deckent-port-diffs-')); mkdirSync(join(root, '.deckent'));
    writeFileSync(join(root, '.deckent', 'config.json'), JSON.stringify({ execution: { docker: { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}`, memoryBytes: 2147483648, pids: 128, cpus: 2,
      logMaxSizeKiB: 1024, logMaxFiles: 2, tmpBytes: 1048576, deadlineMs: 60000, controlTimeoutMs: 5000, outputBytes: 65536 }, git: { gitExecutable: 'git', timeoutMs: 5000 }, adoption: { targets: [] } } }));
    const identity = { scopeId: 's', runId: 'r', taskId: 'task', attemptId: 'a', layoutRevision: 'l', generation: 3 };
    const handlers = { inspectInventory: async () => ({ schemaVersion: 1, layout: {}, page: { entries: [{ identity }], nextAfter: null } }),
      previewWorkspacePatch: async () => ({ patch: { changes: [change('a.txt', 'x\n', 'y\n')] } }),
      checkWorkspaceIntegration: async () => ({ observation: { source: 'SRC', head: BASE }, proposal: 'PROP', scope: { status: 'in-scope' } }),
      prepareWorkspaceIntegration: async () => ({}), renderUnifiedDiff: render, interactiveDelivery: () => ({}) };
    const preview = await terminalDeliveryPort(root, handlers as never, { env: homeEnv(join(root, 'home')) })!.preview({ scopeId: 's', runId: 'r', taskId: 'task', key: 'k', title: 't' });
    expect(preview).toMatchObject({ identity, base: BASE, proposal: 'PROP', files: [{ path: 'a.txt', added: 1, removed: 1 }], diffs: [{ path: 'a.txt', lines: ['@@ -1 +1 @@', '-x', '+y'] }] });
  });
});

describe('read-only diff view in the delivery window', () => {
  const diffs: DeliveryFileDiff[] = [
    { path: 'one.txt', lines: ['@@ -1 +1 @@', '-old-one', '+new-one'], hidden: 0, unavailable: null },
    { path: 'big.bin', lines: [], hidden: 0, unavailable: 'binary' },
    { path: 'long.txt', lines: Array.from({ length: 40 }, (_, index) => `+row-${index}`), hidden: 7, unavailable: null },
  ];
  async function ready(options: PortOptions = {}) {
    const h = harness({ diffs, viewFiles: (options.diffs ?? diffs).map(diff => diff.path), ...options }); await admit(h); h.set(awaiting());
    await until(() => frame(h).includes(windowTitle) && frame(h).includes(WORDS.hints), 'window ready'); await press(h, CTRL_O);
    return h;
  }
  it('Enter opens the selected file; j/k and arrows choose and scroll; Esc goes back to the list and then closes only on the next Esc; nothing is delivered', async () => {
    const h = await ready();
    expect(frame(h)).toContain(WORDS.diffListHints); expect(frame(h)).toContain('› one.txt | +1 -1');
    await press(h, 'j'); expect(frame(h)).toContain('› big.bin'); await press(h, 'k'); expect(frame(h)).toContain('› one.txt');
    await press(h, '\r'); expect(frame(h)).toContain('one.txt (1/3)'); expect(frame(h)).toContain('-old-one'); expect(frame(h)).toContain('+new-one'); expect(frame(h)).toContain(WORDS.diffHints);
    expect(frame(h)).toContain('attempt a#1'); expect(frame(h)).toContain(`base ${BASE.slice(0, 12)}`); expect(frame(h)).toContain('proposal PPPPPPPPPPPP');
    await press(h, ESC); expect(frame(h)).toContain(WORDS.diffListHints); expect(frame(h)).toContain(windowTitle);
    await press(h, DOWN); await press(h, DOWN); await press(h, '\r'); expect(frame(h)).toContain('+row-0'); expect(frame(h)).not.toContain('+row-30');
    await press(h, 'j'); await press(h, 'j'); expect(frame(h)).not.toContain('+row-0\n'); expect(frame(h)).toContain('diff lines 3-20 of 40');
    expect(frame(h)).toContain('+7 more diff lines'); await press(h, ESC);
    expect(h.calls).toEqual(['preview:r']);
  });
  it('a binary or too-large file says it cannot be shown instead of an empty or partial diff', async () => {
    const h = await ready(); await press(h, 'j'); await press(h, '\r');
    expect(frame(h)).toContain('big.bin (2/3)'); expect(frame(h)).toContain(WORDS.diffUnavailable); expect(h.calls).toEqual(['preview:r']);
  });
  it('seeing a diff never delivers: y, n and Enter inside the diff do nothing, and only the list step y delivers once', async () => {
    const h = await ready(); await press(h, '\r'); await press(h, 'y', 120); await press(h, 'n'); await press(h, '\r');
    expect(frame(h)).toContain('one.txt (1/3)'); expect(h.calls).toEqual(['preview:r']); expect(h.views).toEqual([]);
    await press(h, ESC); await press(h, 'y', 120);
    await until(() => frame(h).includes(`Delivered: commit ${COMMIT}`), 'delivered after the explicit list-step y');
    expect(h.calls).toEqual(['preview:r', 'available', 'prepare', 'publish']); expect(h.views).toHaveLength(1);
  });
  it('hostile terminal text and a known secret in a diff cannot corrupt the screen or leak', async () => {
    const hostile: DeliveryFileDiff[] = [{ path: 'evil\u001b[2Jname.txt', lines: ['@@ -1 +1 @@', '+\u001b[2J\u001b]0;pwned\u0007\u001b[31mred\u0000\r\u202e', '+token sk-ant-api03-' + 'A'.repeat(40)], hidden: 0, unavailable: null }];
    const h = await ready({ diffs: hostile }); await press(h, '\r');
    const out = h.view.stdout.text;
    expect(out).not.toContain('\u001b[2J'); expect(out).not.toContain('pwned\u0007'); expect(out).not.toContain('\u202e'); expect(out).not.toContain('A'.repeat(40));
    expect(frame(h)).toContain('evil');
  });
  it('a stale base after viewing the diff is the same typed refusal row; a denied preview shows its typed row and no diff', async () => {
    const stale = await ready({ failFirst: { code: 'PATCH_BASE_ADVANCED', message: 'The delivery base changed.' } });
    await press(stale, '\r'); await press(stale, ESC); await press(stale, 'y', 120);
    await until(() => frame(stale).includes('ERR:The delivery base changed.'), 'typed stale refusal'); expect(frame(stale)).toContain(WORDS.next['PATCH_BASE_ADVANCED']!.slice(0, 40));
    expect(stale.calls).not.toContain('publish');
    const denied = harness({ diffs }); denied.port.preview = async () => { throw Object.assign(new Error('access denied'), { code: 'POLICY_DENIED' }); };
    await admit(denied); denied.set(awaiting()); await until(() => frame(denied).includes('access denied'), 'typed denial');
    expect(frame(denied)).toContain(WORDS.next['POLICY_DENIED']!.slice(0, 40)); expect(frame(denied)).not.toContain('old-one');
    await press(denied, CTRL_O); await press(denied, '\r'); expect(frame(denied)).not.toContain('old-one');
  });
});
