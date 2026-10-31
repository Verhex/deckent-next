import { expect, it } from 'vitest';
import { onboardingSteps, settleOnboardingReady, loadOnboardingScreens, deferredOnboardingNotice, guideQuestion, FirstTaskRegistry, firstTaskIntent, firstTaskBody, firstSignedInHost, createOnboardingSession, type OnboardingPort, type OnboardingSnapshot } from '#surfaces/core/terminal-onboarding/index.js';
import { planSetup, SetupStageRegistry, type SetupStage } from '#engine/index.js';
const observation = { schemaVersion: 2 as const, environment: { platform: 'linux' as const, node: 'supported' as const },
  language: { configured: 'en' as const, requested: null, system: null }, folder: { installation: 'present' as const, homeRoot: false, configuredScope: 's', suggestedScope: null },
  profile: { available: [], selected: null }, policy: { state: 'current' as const }, sandbox: { realm: 'bubblewrap' as const, selfTest: 'ok' as const, usernsRestricted: false },
  model: { connections: 1 }, check: { state: 'ok' as const } };
const snapshot: OnboardingSnapshot = { configBasis: { projectDigest: 'a'.repeat(64), globalDigest: 'b'.repeat(64) }, observation, plan: planSetup(observation, undefined, new SetupStageRegistry(), { phase: 'onboarding' }), answers: {}, deferred: [], modelUsable: true,
  folder: 'orders', folderFacts: { kind: 'documents', entries: ['orders.pdf'] }, scopeId: 's',
  hosts: [{ id: 'first', cli: 'absent', login: 'found' }, { id: 'second', cli: 'found', login: 'found' }],
  budget: { needed: true, presetUsd: 10, presetsUsd: [5, 10, 25], currentUsd: 0 }, permissions: { state: 'applied', reason: '' }, pending: [] };
it('U4-4: bounded registry selection supplies three applicable choices, sealed extension and explicit submission only', () => {
  const registry = new FirstTaskRegistry(); registry.register([{ id: 'business', order: 1, kinds: ['documents'], requires: [], labelKey: 'onboarding.firstTask.topics.label', intentKey: 'onboarding.firstTask.topics.intent', effectKey: 'onboarding.firstTask.readOnly' }]);
  expect(registry.select(snapshot.folderFacts).map(row => row.id)).toEqual(['business', 'folder-summary', 'topics']);
  expect(() => registry.register([])).toThrow();
  for (const kind of ['unknown', 'documents'] as const) expect(new FirstTaskRegistry().select({ kind, entries: [] }).map(row => row.id)).toEqual(['folder-summary', 'topics', 'questions']);
  // OB3: the three follow the folder's own facts (registry patterns over its visible names), never one generic list.
  const pick = (kind: 'coding' | 'empty', entries: readonly string[]) => new FirstTaskRegistry().select({ kind, entries }).map(row => row.id);
  expect(pick('coding', ['README.md', 'tests', 'src'])).toEqual(['project-summary', 'readme', 'tests']);
  expect(pick('coding', ['package.json', 'src'])).toEqual(['project-summary', 'build-run', 'readme-write']);
  expect(pick('coding', [])).toEqual(['new-project', 'readme-write', 'plan']);
  expect(pick('empty', [])).toEqual(['new-project', 'plan', 'draft']);
  const input = { text: 'Inspect orders', scopeId: 's', folder: 'orders', commandId: 'one' };
  expect(firstTaskIntent({ ...input, action: 'highlight' })).toBeNull(); expect(firstTaskIntent({ ...input, action: 'later' })).toBeNull();
  expect(firstTaskIntent({ ...input, action: 'submit' })).toEqual({ intent: 'Inspect orders', scopeId: 's', folder: 'orders', commandId: 'one' });
});
it('U4-1/U4-2/U4-3: observed first signed-in default, dynamic progress, defer/reopen and metered preset without implicit apply', async () => {
  const deferred: string[] = [], port = { observe: async () => snapshot, assertPerson: async () => {}, defer: async (id: string) => { deferred.push(id); } } as OnboardingPort;
  expect(firstSignedInHost(snapshot)).toBe('second');
  const session = createOnboardingSession(port, snapshot), first = session.model().steps[0]!;
  expect(first.kind).toBe('budget');
  const unknown = { ...session.model(), snapshot: { ...snapshot, budget: { ...snapshot.budget, currentUsd: null, reason: 'POLICY_DENIED' } } };
  expect(guideQuestion(unknown, 'budget', 'tr').choices).toEqual([]);
  expect(guideQuestion(session.model(), 'budget', 'tr').initial).toBe('10');
  await session.defer(first); expect(deferred).toEqual(['onboarding:budget']);
  const notice = deferredOnboardingNotice({ ...snapshot, deferred }, 'tr');
  expect(notice).toContain('/setup'); expect(notice).not.toContain('onboarding:budget'); expect(session.model().completed).toBe(1);
  expect(session.model().steps[0]?.kind).toBe('first-task');
  const reopened = createOnboardingSession(port, { ...snapshot, deferred }, true);
  expect(reopened.model().steps.map(row => row.kind)).toEqual(['stage', 'budget', 'first-task']);
  expect(reopened.model().steps[0]?.id).toBe('core:model');
  // Owner 2026-10-30: Esc · Later on the model card holds also while no model is usable (was İ-2); the deferral stays named; /setup and the model focus reopen it.
  const unconnected = { ...observation, model: { connections: 0 } };
  const chatOnly = { ...snapshot, observation: unconnected, plan: planSetup(unconnected, undefined, new SetupStageRegistry(), { phase: 'onboarding' }), deferred: ['core:model'], modelUsable: false };
  expect(onboardingSteps(chatOnly).some(row => row.id === 'core:model')).toBe(false);
  expect(deferredOnboardingNotice(chatOnly, 'en')).toMatch(/model.*\/setup/isu);
  expect(onboardingSteps(chatOnly, true).some(row => row.id === 'core:model')).toBe(true);
  expect(createOnboardingSession(port, chatOnly, true, 'model').model().steps.map(row => row.id)).toEqual(['core:model']);
  let attestations = 0;
  const stopped = { assertPerson: async () => { attestations++; throw new Error('must not open'); } } as OnboardingPort;
  const { runOnboardingSession } = await loadOnboardingScreens();
  expect(await runOnboardingSession(stopped, {} as never, { locale: 'tr', signal: AbortSignal.abort() })).toBeNull();
  expect(attestations).toBe(0);
  // P2: one observation per open; settling writes first and that settled snapshot is shared only when no step was shown.
  let observes = 0; const settledIds: string[] = [], shared: OnboardingSnapshot[] = [];
  let current: OnboardingSnapshot = { ...snapshot, deferred: ['onboarding:budget', 'onboarding:first-task:done', 'permissions:start-mode'] };
  const counting = { ...port, observe: async () => { observes++; return current; }, reconcile: async (intent: never) => intent,
    settle: async (ids: readonly string[]) => { settledIds.push(...ids); } } as OnboardingPort;
  expect(await runOnboardingSession(counting, { observed: (row: OnboardingSnapshot) => shared.push(row) } as never, { locale: 'en' } as never)).toBeNull();
  expect(observes).toBe(1); expect(settledIds).toEqual(['permissions:start-mode']); expect(shared.map(row => row.deferred)).toEqual([['onboarding:budget', 'onboarding:first-task:done']]);
  // After a person's answer (Esc · Later on the budget card) nothing is shared: the opener observes again.
  const { PassThrough, Writable } = await import('node:stream'), { until } = await import('../support/workline-harness.js');
  let frame = ''; current = { ...snapshot, deferred: ['onboarding:first-task:done'] }; deferred.length = 0;
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { frame += String(chunk); done(); } }), { isTTY: true, columns: 120, rows: 40 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const answered = runOnboardingSession(counting, { observed: (row: OnboardingSnapshot) => shared.push(row) } as never, { locale: 'en', env: { TERM: 'xterm-256color' }, stdin: stdin as never, stdout: stdout as never });
  try { await until(() => frame.includes('Later'), 'budget card'); stdin.write('\u001b'); expect(await answered).toBeNull(); } finally { stdin.destroy(); stdout.destroy(); }
  expect(deferred).toEqual(['onboarding:budget']); expect(observes).toBe(2); expect(shared).toHaveLength(1);
});

it('U4C: a relaunched ready card skips settled owners, refuses a refused write and reobserves before the next owner', async () => {
  const stage = (id: string, done: boolean): SetupStage => ({ id, namespace: id.split(':')[0]!, title: 'setup.work.kindTitle', phase: 'onboarding', state: done ? 'done' : 'ready',
    reason: { code: 'setup.work.kindDone', params: {} }, operation: done ? null : { id: id === 'work:kind' ? 'work.profile-add' : 'work.pool', version: 1, input: {} }, question: null, default: null, cli: null, autoEligible: false });
  let registryDone = false, poolDone = false, allowed = false;
  const calls: string[] = [];
  const refresh = async () => { const fresh = { ...snapshot, plan: { ...snapshot.plan, stages: [stage('execution:worker-settings', true), stage('work:kind', registryDone), stage('work:pool', poolDone)] } };
    return { schemaVersion: 1 as const, steps: [], completed: 0, total: 0, snapshot: fresh }; };
  const port = { previewProfile: async () => ({ digest: 'd'.repeat(64), expect: null, image: 'sha256:pin', provider: 'new', profile: 'new@1', kind: 'new-coding' }),
    apply: async (current: SetupStage) => { calls.push(current.id); expect(current.operation?.input['digest']).toBe('d'.repeat(64)); if (allowed) registryDone = true; return { status: allowed ? 'applied' : 'refused' }; } } as OnboardingPort;
  const ui = { foreground: async (current: SetupStage) => { calls.push(current.id); poolDone = true; return { status: 'applied' }; } } as never;
  expect(await settleOnboardingReady(port, ui, refresh, async () => true)).toBe(false);
  expect(calls).toEqual(['work:kind']);
  allowed = true; expect(await settleOnboardingReady(port, ui, refresh, async () => true)).toBe(true);
  expect(calls).toEqual(['work:kind', 'work:kind', 'work:pool']);
  calls.length = 0; expect(await settleOnboardingReady(port, ui, refresh, async () => true)).toBe(true); expect(calls).toEqual([]);
  const blocked = { ...snapshot, plan: { ...snapshot.plan, stages: [stage('execution:worker', true),
    { ...stage('execution:worker-settings', true), state: 'blocked' as const }, stage('work:kind', true), stage('work:pool', true)] } };
  expect(onboardingSteps(blocked).find(row => row.kind === 'ready')?.stages[0]?.state).toBe('blocked');
});

it('R13/R18: the image card follows an answered work choice, the step total is known up front, and a settled deferral is forgotten', async () => {
  const stage = (id: string, state: SetupStage['state'], code = 'setup.work.kindDone'): SetupStage => ({ id, namespace: id.split(':')[0]!, title: 'setup.work.kindTitle', phase: 'onboarding', state,
    reason: { code, params: {} }, operation: null, question: null, default: null, cli: null, autoEligible: false });
  const before = { ...snapshot, budget: { ...snapshot.budget, needed: false }, folderFacts: { kind: 'coding' as const, entries: [] },
    plan: { ...snapshot.plan, stages: [stage('work:kind', 'needs-answer'), stage('coding:first-commit', 'ready'), stage('execution:worker', 'skipped', 'setup.execution.noWorkKind')] } };
  const after = { ...before, plan: { ...before.plan, stages: [stage('work:kind', 'done'), stage('coding:first-commit', 'ready'), stage('execution:worker', 'blocked', 'setup.execution.workerConsentRequired')] } };
  expect(onboardingSteps(after).map(row => row.id)).toEqual(['execution:worker', 'coding:first-commit', 'onboarding:first-task']);
  // FIX9: a deferred image card stays in the "Deferred" note while its work choice is open again (that answer lived in the closed session).
  expect(deferredOnboardingNotice({ ...before, deferred: ['execution:worker'] }, 'en')).not.toBeNull();
  let current: OnboardingSnapshot = before; const settled: string[][] = [];
  const port = { observe: async () => current, assertPerson: async () => {}, settle: async (ids: readonly string[]) => { settled.push([...ids]); } } as OnboardingPort;
  const session = createOnboardingSession(port, before);
  expect(session.model().total).toBe(4);
  current = after; const answered = await session.finish(session.model().steps[0]!);
  expect(answered.total).toBe(4); expect(answered.steps[0]?.id).toBe('execution:worker');
  // Permissions applied and a usable model elsewhere: both deferrals leave the notice and the store; the open first commit stays deferred.
  current = { ...after, deferred: ['permissions:start-mode', 'core:model', 'coding:first-commit'] };
  expect(deferredOnboardingNotice(current, 'en')).not.toMatch(/model|permission/iu);
  await session.refresh(); expect(settled).toEqual([['permissions:start-mode', 'core:model']]);
});

it('U4E G2: install permission recovery precedes an absent model; not-applicable profiles never get a permission success card', () => {
  const missing = { ...snapshot, observation: { ...observation, model: { connections: 0 } }, budget: { ...snapshot.budget, needed: false },
    permissions: { state: 'needs-profile' as const, reason: 'onboarding.permissions.profileMissing' } };
  expect(onboardingSteps(missing)[0]?.kind).toBe('permissions');
  expect(onboardingSteps({ ...missing, permissions: { state: 'not-applicable', reason: '' } }).some(step => step.kind === 'permissions')).toBe(false);
});

it('U6-S4: image consent immediately follows work choice, offers verified adoption first (highlighted, owner 2026-10-26) and preserves missing-only repair', async () => {
  const { workerImageQuestion, workerImageProgress } = await import('#surfaces/core/terminal-onboarding/index.js');
  const { workerSetupStages } = await import('#engine/index.js');
  const id = `sha256:${'a'.repeat(64)}`, missing = `sha256:${'b'.repeat(64)}`;
  const stage = (id: string): SetupStage => ({ id, namespace: id.split(':')[0]!, title: 'setup.work.kindTitle', phase: 'onboarding', state: 'blocked',
    reason: { code: 'setup.execution.workerConsentRequired', params: {} }, operation: null, question: null, default: null, cli: null, autoEligible: false });
  const current = { ...snapshot, budget: { ...snapshot.budget, needed: false }, folderFacts: { ...snapshot.folderFacts, kind: 'coding' as const },
    plan: { ...snapshot.plan, stages: [stage('work:kind'), stage('execution:runtime'), stage('execution:worker')] } };
  expect(onboardingSteps(current).map(row => row.id)).toEqual(['work:kind', 'execution:worker', 'execution:runtime', 'onboarding:first-task']);
  const question = workerImageQuestion({ providers: ['selected-cli'], sources: ['https://mirror.invalid/prefix'], proxy: 'http://proxy.invalid:8080', baseRef: 'base@sha256:pin',
    sizeGigabytes: 1, buildTimeoutMs: 20000, images: [{ imageId: missing, tag: 'worker:unknown', ready: false }, { imageId: id, tag: 'worker:r32-selected', ready: true }] }, 'en', missing);
  expect(question.initial).toBe(id); expect(question.choices.map(row => row.id)).toEqual([id, 'consent', 'later']); // BeUser M-05: no row Enter cannot act on
  // No ready image: the recommended answer is the background build of the shown sources (still only on Enter).
  expect(workerImageQuestion({ providers: [], sources: [], proxy: null, baseRef: 'base', sizeGigabytes: 1, buildTimeoutMs: 20000 }, 'en').initial).toBe('consent');
  expect(question.body.join('\n')).toContain('1 older Deckent worker image(s) on this machine cannot be used here'); expect(question.body.join('\n')).toContain('worker:unknown');
  expect(question.body.join('\n')).toContain('https://mirror.invalid/prefix'); expect(question.body.join('\n')).toContain(missing);
  expect(question.body.join('\n')).toContain('No task starts');
  expect(workerImageQuestion({ providers: [], sources: [], proxy: null, baseRef: 'base', sizeGigabytes: 1, buildTimeoutMs: 20000, previousMs: 3000, referenceMs: 70000 }, 'en').body.join('\n')).toContain('Previous measured preparation');
  // IMGOPT: without a build on this machine the card names the recipe's measured reference build; the timeout is only an upper limit.
  const reference = workerImageQuestion({ providers: [], sources: [], proxy: null, baseRef: 'base', sizeGigabytes: 1.5, buildTimeoutMs: 1_800_000, referenceMs: 70000 }, 'tr').body.join('\n');
  expect(reference).toContain('referans makinede'); expect(reference).toContain('1,5 GB'); expect(reference).toContain('üst sınır');
  const acquisition = { schemaVersion: 1 as const, revision: 1, instanceId: 'instance', consentId: 'consent', phase: 'ready' as const, step: null, startedAt: '2026-10-26T00:00:00.000Z',
    lastProgressAt: '2026-10-26T00:00:02.000Z', expiresAt: '2026-10-26T00:01:00.000Z', daemonId: 'daemon', code: null, context: null,
    images: [{ provider: 'selected-cli', consentId: 'consent', recipeDigest: 'a'.repeat(64), daemonId: 'daemon', imageId: id, imageVersion: 'r32-20261026', tagVersion: 'r32-selected-cli', receiptPath: '/tmp/receipt' }] };
  const context = { scopeId: 's', answer: undefined, states: new Map([['work:kind', 'done'], ['execution:runtime', 'done'], ['execution:worker', 'done'], ['core:policy', 'done']] as const),
    facts: { runtimes: [], worker: { configured: missing, image: 'missing', receipt: null, git: null, provider: 'selected-cli', acquisition } } };
  const stages = workerSetupStages({ person: true, sizeGigabytes: 1 });
  expect(stages[1]!.evaluate(context)).toMatchObject({ state: 'ready', operation: { input: { keyPath: 'execution.docker.imageId', value: id } } });
  expect(stages[1]!.evaluate({ ...context, facts: { ...context.facts, worker: { ...context.facts.worker, image: 'unknown' } } })).toMatchObject({ state: 'blocked', reason: { code: 'setup.execution.workerUnknown' } });
  expect(stages[0]!.evaluate({ ...context, facts: { ...context.facts, worker: { ...context.facts.worker, configured: id } } })).toMatchObject({ state: 'blocked', reason: { code: 'setup.execution.workerMissing' } });
  const progress = workerImageProgress({ ...acquisition, phase: 'acquiring', step: 'layer:selected-cli' }, 'tr', Date.parse('2026-10-26T00:00:03.000Z'));
  expect(progress.join('\n')).toContain('selected-cli'); expect(progress.join('\n')).toContain(acquisition.lastProgressAt);
  expect(workerImageProgress({ ...acquisition, phase: 'waiting-docker' }, 'tr').join('\n')).toContain('Docker bekleniyor');
});
it('FIX9: an empty repository explains that there is nothing to commit and Enter skips the first-commit card (no dead end)', async () => {
  const { PassThrough, Writable } = await import('node:stream');
  const { firstCommitScreen } = await import('../../../src/surfaces/core/terminal-onboarding/internal/first-commit.js');
  let frame = '';
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { frame += String(chunk); done(); } }), { isTTY: true, columns: 100, rows: 30 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const port = { previewFirstCommit: async () => ({ state: 'ready', total: 0, selected: 0, more: 0, rows: [], identity: true, sign: false, digest: 'd' }),
    firstCommit: async () => { throw new Error('must not commit'); }, firstCommitRecovery: async () => ({ state: 'none' }) } as unknown as OnboardingPort;
  setTimeout(() => stdin.write('\r'), 300);
  const result = await firstCommitScreen(port, { completed: 0, total: 3 } as never, { locale: 'en', env: { TERM: 'xterm-256color' }, stdin: stdin as never, stdout: stdout as never });
  expect(result).toBe('later');
  expect(frame).toContain('no files to commit yet'); expect(frame).toContain('Skip for now'); expect(frame).not.toMatch(/0 of 0|of 0 files/u);
});
it('BeUser ZEY-02/D-04 + walk19R: the rights step follows permission mode and applies only the previewed digest; permission cards show their work and replace each other', async () => {
  const needed = { ...snapshot, permissions: { state: 'needs-confirmation' as const, reason: '' }, rights: { state: 'needed' as const, digest: 'd'.repeat(64), rules: 9 } };
  expect(onboardingSteps(needed).slice(0, 3).map(row => row.id)).toEqual(['permissions:start-mode', 'onboarding:budget', 'permissions:owner-rights']);
  expect(onboardingSteps({ ...needed, rights: { state: 'current', rules: 0 } }).some(row => row.kind === 'rights')).toBe(false);
  expect(onboardingSteps({ ...needed, deferred: ['permissions:owner-rights'] }).some(row => row.kind === 'rights')).toBe(false);
  expect(onboardingSteps({ ...needed, deferred: ['permissions:owner-rights'] }, true).some(row => row.kind === 'rights')).toBe(true);
  const question = guideQuestion({ schemaVersion: 1, steps: [], completed: 0, total: 3, snapshot: needed }, 'rights', 'en');
  expect(question.body.join('\n')).toContain('pause and resume them in an emergency'); expect(question.body.join('\n')).not.toMatch(/rules|deckent init|owner-baseline/u); expect(question.choices.map(row => row.id)).toEqual(['apply']);
  // walk19R: the profile card stays up while its preview runs and says so; Enter pressed then is visibly not used and never answers the next
  // card (whose Enter would apply); the next card replaces it in one live region, and an answered card leaves no frame behind.
  const { PassThrough, Writable } = await import('node:stream'), { until, settle } = await import('../support/workline-harness.js'), { terminalBuffers } = await import('../../fixtures/terminal-screen.js');
  const { guideScreen } = await import('../../../src/surfaces/core/terminal-onboarding/internal/guides.js');
  let frame = '', release = () => {}; const applied: string[] = [], profiles = [{ id: 'core:solo', version: 1 }];
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { frame += String(chunk); done(); } }), { isTTY: true, columns: 100, rows: 30 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const port = { assertPerson: async () => {}, permissions: async (digest: string) => { applied.push(digest); },
    previewPermissions: () => new Promise(resolve => { release = () => resolve({ state: 'needs-confirmation', reason: 'onboarding.permissions.guided', digest: 'p'.repeat(64), selectedProfile: profiles[0] }); }) } as unknown as OnboardingPort;
  const picking = { ...snapshot, permissions: { state: 'needs-profile' as const, reason: '', profiles } };
  const result = guideScreen({ schemaVersion: 1, steps: [], completed: 0, total: 2, snapshot: picking }, 'permissions', port, { locale: 'en', env: { TERM: 'xterm-256color' }, stdin: stdin as never, stdout: stdout as never });
  const main = () => terminalBuffers(frame.replace(/\n/gu, '\r\n'), 100, 30).main; // the TTY's ONLCR, as a real terminal receives it
  try {
    await until(() => frame.includes('Esc · Later'), 'profile card'); stdin.write('\r');
    await until(() => frame.includes('Preparing…'), 'preparing'); stdin.write('\r'); await until(() => frame.includes('keys ignored'), 'ignored key note');
    release(); await until(() => frame.includes('> Enter · Continue'), 'permission card'); await settle(200);
    expect(applied).toEqual([]); expect(main().split('Step 1/2').length - 1).toBe(1); expect(main()).not.toContain('Choose a profile');
    for (const modified of ['\u001b[13;5u', '\u001b\r']) { stdin.write(modified); await settle(60); expect(applied).toEqual([]); }
    stdin.write('\r'); expect(await result).toBe('applied'); expect(applied).toEqual(['p'.repeat(64)]); expect(main()).not.toContain('Step 1/2');
  } finally { stdin.destroy(); stdout.destroy(); }
});
it('BeUser M-J6: a chosen first task is not offered at every open, is not named as deferred, and /setup still offers it', () => {
  const done = { ...snapshot, budget: { ...snapshot.budget, needed: false }, deferred: ['onboarding:first-task:done'] };
  expect(onboardingSteps(done).some(row => row.kind === 'first-task')).toBe(false);
  expect(onboardingSteps(done, true).some(row => row.kind === 'first-task')).toBe(true);
  expect(deferredOnboardingNotice(done, 'en')).toBeNull();
  expect(deferredOnboardingNotice({ ...done, deferred: [...done.deferred, 'onboarding:first-task'] }, 'en')).toBeNull(); // AYSE-R2-04: Esc on Ready! after a first task
  expect(onboardingSteps({ ...done, deferred: [] }).some(row => row.kind === 'first-task')).toBe(true);
});
it('Astra 2761 R1 (K3): the first-task screen reads the host run-here answer; when it is closed it promises no local run', () => {
  const pool: SetupStage = { id: 'work:pool', namespace: 'work', title: 'setup.work.kindTitle', phase: 'onboarding', state: 'ready' } as SetupStage;
  const open = { ...snapshot, plan: { ...snapshot.plan, stages: [pool] } };
  expect(firstTaskBody({ ...open, localRun: true }, 'en').join(' ')).toContain('runs here in the terminal');
  const closed = firstTaskBody({ ...open, localRun: false }, 'en').join(' ');
  expect(closed).toContain('closed for this setup'); expect(closed).not.toContain('runs here in the terminal');
});
it('A57 merge: a saved conversation notice keeps the closed local-run explanation and Esc submits no first task', async () => {
  const { PassThrough, Writable } = await import('node:stream');
  const { firstTaskScreen } = await import('../../../src/surfaces/core/terminal-onboarding/internal/first-task.js');
  const { until, settle } = await import('../support/workline-harness.js');
  const { snapshotKnownSecrets } = await import('#platform/index.js');
  // Astra 2834 R1: a body line carrying a credential-shaped value and a known secret (as a Git file name or an error message can).
  const KNOWN = 'known-canary-7f3e9d2a', TOKEN = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', TYPED = 'typed-canary-41c0';
  // eslint-disable-next-line no-control-regex -- the OSC 52 clipboard request is a control sequence.
  const copies = () => [...frame.matchAll(/\u001b\]52;c;([A-Za-z0-9+/=]*)\u0007/gu)].map(match => Buffer.from(match[1]!, 'base64').toString('utf8'));
  let frame = '';
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { frame += String(chunk); done(); } }), { isTTY: true, columns: 160, rows: 60 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const signal = new AbortController(), pool = { id: 'work:pool', state: 'ready' } as SetupStage;
  const model = { schemaVersion: 1 as const, steps: [], completed: 0, total: 1,
    snapshot: { ...snapshot, localRun: false, plan: { ...snapshot.plan, stages: [pool] } } };
  const answer = firstTaskScreen(model, { locale: 'en', env: { TERM: 'xterm-256color' }, stdin: stdin as never, stdout: stdout as never, signal: signal.signal,
    known: snapshotKnownSecrets([{ name: 'ONBOARDING_FIXTURE', value: KNOWN }]) }, undefined, `Saved conversation: use /resume · ${TOKEN} · ${KNOWN}`);
  let decided = false; void answer.then(() => { decided = true; });
  try {
    await until(() => frame.includes('Saved conversation: use /resume'), 'first-task conversation notice');
    expect(frame).toContain('closed for this setup'); expect(frame).not.toContain('runs here in the terminal');
    // Ctrl+Y copies the card through the record projection (no credential shape, no known value) and decides nothing.
    stdin.write('\u0019'); await until(() => copies().length === 1, 'onboarding card copy');
    expect(copies()[0]).toContain('Saved conversation: use /resume'); expect(copies()[0]).toContain('[REDACTED]');
    expect(copies()[0]).not.toContain(TOKEN); expect(copies()[0]).not.toContain(KNOWN); expect(copies()[0]).not.toMatch(/sk-ant-|known-canary/u);
    await settle(50); expect(decided).toBe(false);
    // The free-text card: what the person types in its input never reaches the copy.
    for (let index = 0; index < 12; index++) { stdin.write('\u001b[B'); await settle(15); }
    stdin.write('\r'); await settle(400); stdin.write(TYPED); await settle(60); stdin.write('\u0019');
    await until(() => copies().length === 2, 'free-text card copy');
    expect(copies()[1]).not.toContain(TYPED); expect(copies()[1]).not.toContain(KNOWN); expect(copies()[1]).not.toContain(TOKEN);
    await settle(50); expect(decided).toBe(false);
    stdin.write('\u001b'); expect(await answer).toBe('later');
  } finally { signal.abort(); await answer; stdin.destroy(); stdout.destroy(); }
});
