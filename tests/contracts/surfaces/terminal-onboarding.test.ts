import { expect, it } from 'vitest';
import { loadOnboardingScreens, deferredOnboardingNotice, guideQuestion, FirstTaskRegistry, firstTaskIntent, firstSignedInHost, createOnboardingSession, onboardingSteps, type OnboardingPort, type OnboardingSnapshot } from '#surfaces/core/terminal-onboarding/index.js';
import { planSetup, SetupStageRegistry } from '#engine/index.js';
const observation = { schemaVersion: 2 as const, environment: { platform: 'linux' as const, node: 'supported' as const },
  language: { configured: 'en' as const, requested: null, system: null }, folder: { installation: 'present' as const, homeRoot: false, configuredScope: 's', suggestedScope: null },
  profile: { available: [], selected: null }, policy: { state: 'current' as const }, sandbox: { realm: 'bubblewrap' as const, selfTest: 'ok' as const, usernsRestricted: false },
  model: { connections: 1 }, check: { state: 'ok' as const } };
const snapshot: OnboardingSnapshot = { configBasis: { projectDigest: 'a'.repeat(64), globalDigest: 'b'.repeat(64) }, observation, plan: planSetup(observation, undefined, new SetupStageRegistry(), { phase: 'onboarding' }), answers: {}, deferred: [], modelUsable: true,
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
