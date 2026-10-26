import { expect, it } from 'vitest';
import { onboardingSteps, settleOnboardingReady, loadOnboardingScreens, deferredOnboardingNotice, guideQuestion, FirstTaskRegistry, firstTaskIntent, firstSignedInHost, createOnboardingSession, type OnboardingPort, type OnboardingSnapshot } from '#surfaces/core/terminal-onboarding/index.js';
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
  // İ-2: a deferred model screen returns only while no model is usable (a chat-only activation is usable without a worker catalog row).
  const unconnected = { ...observation, model: { connections: 0 } };
  const chatOnly = { ...snapshot, observation: unconnected, plan: planSetup(unconnected, undefined, new SetupStageRegistry(), { phase: 'onboarding' }), deferred: ['core:model'] };
  expect(onboardingSteps(chatOnly).some(row => row.id === 'core:model')).toBe(false);
  expect(onboardingSteps({ ...chatOnly, modelUsable: false })[0]?.id).toBe('core:model');
  let attestations = 0;
  const stopped = { assertPerson: async () => { attestations++; throw new Error('must not open'); } } as OnboardingPort;
  const { runOnboardingSession } = await loadOnboardingScreens();
  expect(await runOnboardingSession(stopped, {} as never, { locale: 'tr', signal: AbortSignal.abort() })).toBeNull();
  expect(attestations).toBe(0);
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
  expect(question.initial).toBe(id); expect(question.choices.map(row => row.id)).toEqual([id, missing, 'consent', 'later']);
  // No ready image: the recommended answer is the background build of the shown sources (still only on Enter).
  expect(workerImageQuestion({ providers: [], sources: [], proxy: null, baseRef: 'base', sizeGigabytes: 1, buildTimeoutMs: 20000 }, 'en').initial).toBe('consent');
  expect(question.choices[1]).toMatchObject({ disabled: true });
  expect(question.body.join('\n')).toContain('https://mirror.invalid/prefix'); expect(question.body.join('\n')).toContain(missing);
  expect(question.body.join('\n')).toContain('No task starts');
  expect(workerImageQuestion({ providers: [], sources: [], proxy: null, baseRef: 'base', sizeGigabytes: 1, buildTimeoutMs: 20000, previousMs: 3000 }, 'en').body.join('\n')).toContain('Previous measured preparation');
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
