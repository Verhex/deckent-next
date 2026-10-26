import { expect, it } from 'vitest';
import { onboardingSteps, settleOnboardingReady, loadOnboardingScreens, deferredOnboardingNotice, guideQuestion, FirstTaskRegistry, firstTaskIntent, firstSignedInHost, createOnboardingSession, type OnboardingPort, type OnboardingSnapshot } from '#surfaces/core/terminal-onboarding/index.js';
import { planSetup, SetupStageRegistry, type SetupStage } from '#engine/index.js';
const observation = { schemaVersion: 2 as const, environment: { platform: 'linux' as const, node: 'supported' as const },
  language: { configured: 'en' as const, requested: null, system: null }, folder: { installation: 'present' as const, homeRoot: false, configuredScope: 's', suggestedScope: null },
  profile: { available: [], selected: null }, policy: { state: 'current' as const }, sandbox: { realm: 'bubblewrap' as const, selfTest: 'ok' as const, usernsRestricted: false },
  model: { connections: 1 }, check: { state: 'ok' as const } };
const snapshot: OnboardingSnapshot = { configBasis: { projectDigest: 'a'.repeat(64), globalDigest: 'b'.repeat(64) }, observation, plan: planSetup(observation, undefined, new SetupStageRegistry(), { phase: 'onboarding' }), answers: {}, deferred: [],
  folder: 'orders', folderFacts: { kind: 'documents', readme: false, tests: false }, scopeId: 's',
  hosts: [{ id: 'first', cli: 'absent', login: 'found' }, { id: 'second', cli: 'found', login: 'found' }],
  budget: { needed: true, presetUsd: 10, presetsUsd: [5, 10, 25], currentUsd: 0 }, permissions: { state: 'applied', reason: '' }, pending: [] };
it('U4-4: bounded registry selection supplies three applicable choices, sealed extension and explicit submission only', () => {
  const registry = new FirstTaskRegistry(); registry.register([{ id: 'business', order: 1, kinds: ['documents'], requires: [], labelKey: 'onboarding.firstTask.topics.label', intentKey: 'onboarding.firstTask.topics.intent', effectKey: 'onboarding.firstTask.readOnly' }]);
  expect(registry.select(snapshot.folderFacts).map(row => row.id)).toEqual(['business', 'folder-summary', 'topics']);
  expect(() => registry.register([])).toThrow();
  for (const kind of ['empty', 'unknown', 'documents'] as const) expect(new FirstTaskRegistry().select({ kind, readme: false, tests: false }).map(row => row.id)).toEqual(['folder-summary', 'topics', 'questions']);
  expect(new FirstTaskRegistry().select({ kind: 'coding', readme: true, tests: true }).map(row => row.id)).toEqual(['project-summary', 'readme', 'tests']);
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
