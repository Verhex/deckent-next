import { t, type Locale } from '#platform/index.js';
import { onboardingMessage } from './message.js';
import type { OnboardingFocus, OnboardingPort, OnboardingPresentation, OnboardingSnapshot, OnboardingStep } from './contract.js';
import presentation from './presentation.json' with { type: 'json' };
const readyIds = new Set(presentation.workerReady.members.filter(id => id !== 'work:kind'));
/** Projection over the same setup plan: grouping is presentation only; owners still settle every individual operation. */
export function onboardingSteps(snapshot: OnboardingSnapshot, revisit = false): readonly OnboardingStep[] {
  const steps: OnboardingStep[] = [], deferred = new Set(revisit ? [] : snapshot.deferred);
  const add = (step: OnboardingStep) => { if (!deferred.has(step.id)) steps.push(step); }; // owner 2026-10-30: Later on the model card holds; /setup reopens it
  if (!['applied', 'not-applicable'].includes(snapshot.permissions.state)) add({ id: 'permissions:start-mode', stages: [], kind: 'permissions' });
  if (snapshot.rights?.state === 'needed' && snapshot.rights.digest) add({ id: 'permissions:owner-rights', stages: [], kind: 'rights' });
  let workAt = -1;
  for (const stage of snapshot.plan.stages) {
    if (stage.id === 'work:kind') workAt = steps.length;
    if (stage.id === 'work:kind' && snapshot.folderFacts.kind !== 'coding' && !snapshot.answers['work:kind'] && stage.state !== 'done') continue;
    if (stage.phase !== 'onboarding' || readyIds.has(stage.id) || stage.state === 'skipped'
      || presentation.observationOnly.includes(stage.id) || (!revisit && stage.state === 'done' && stage.id !== 'work:kind' && stage.id !== presentation.workerReady.after)) continue;
    if (stage.id === 'work:kind' && ['work.registry', 'work.profile-add'].includes(stage.operation?.id ?? '')) continue;
    if (stage.id === 'work:kind' && stage.state === 'done' && !stage.question) {
      const chosen = snapshot.answers['work:kind'];
      if (!revisit || typeof chosen !== 'string' && snapshot.folderFacts.kind !== 'coding') continue;
    }
    if (stage.id !== presentation.workerReady.after || stage.state !== 'done') add({ id: stage.id, stages: [stage], kind: stage.id === 'work:kind' ? 'work' : 'stage' });
    if (stage.id === presentation.workerReady.after && stage.state === 'done') {
      const group = presentation.workerReady.members.flatMap(id => snapshot.plan.stages.filter(row => row.id === id));
      if (group.some(row => row.state !== 'done' && row.state !== 'skipped')) add({ id: presentation.workerReady.id, stages: group, kind: 'ready' });
    }
    if (stage.id === 'core:model') {
      if (snapshot.budget.needed) add({ id: 'onboarding:budget', stages: [], kind: 'budget' });
    }
  }
  const image = steps.findIndex(row => row.id === 'execution:worker');
  // R13: the image card follows the work choice, also once that choice is answered and its card left the list (where it stood).
  if (image >= 0) { const [step] = steps.splice(image, 1), work = steps.findIndex(row => row.kind === 'work'); const runtime = steps.findIndex(row => row.id === 'execution:runtime');
    steps.splice(work >= 0 ? work + 1 : workAt >= 0 ? workAt - Number(image < workAt) : runtime >= 0 ? runtime : steps.length, 0, step!); }
  // A connected model's done stage is absent above; its dependent guide still has the same position before work.
  if (!steps.some(row => row.kind === 'budget') && snapshot.budget.needed && !deferred.has('onboarding:budget')) steps.splice(steps[0]?.kind === 'permissions' ? 1 : 0, 0, { id: 'onboarding:budget', stages: [], kind: 'budget' });
  for (const pending of snapshot.pending.filter(row => row.status !== 'cancelled')) add({ id: `parked:${pending.runId}`, kind: 'parked', stages: [], pending });
  if (!deferred.has(FIRST_TASK_DONE)) add({ id: 'onboarding:first-task', stages: [], kind: 'first-task' }); // BeUser M-J6: a chosen first task is not offered at every open
  return steps;
}
/** A person's chosen first task (kept like a deferral; /setup still offers the card). */
export const FIRST_TASK_DONE = 'onboarding:first-task:done';
/** R18: a deferral whose step is no longer open (settled through /setup, /model or /mode) is not a deferral any more. */
export const openDeferrals = (snapshot: OnboardingSnapshot): readonly string[] => {
  const steps = onboardingSteps({ ...snapshot, deferred: [] }), open = new Set(steps.map(row => row.id));
  // A deferred image card whose work choice is open again (that answer lives in the session) is still owed, not settled.
  return snapshot.deferred.filter(id => open.has(id) || id === FIRST_TASK_DONE || id === 'execution:worker' && awaitedImage(snapshot, steps) === 1);
};
/** The image card enters the plan only once the work kind is answered; a pending work card counts it from the start (stable "Adım N"). */
const awaitedImage = (snapshot: OnboardingSnapshot, steps: readonly OnboardingStep[]) => Number(steps.some(row => row.kind === 'work')
  && !steps.some(row => row.id === 'execution:worker') && snapshot.plan.stages.some(row => row.id === 'execution:worker' && row.reason.code === 'setup.execution.noWorkKind'));
export const firstSignedInHost = (snapshot: OnboardingSnapshot): string | null => snapshot.hosts.find(row => row.cli === 'found' && row.login === 'found')?.id ?? null;
/** One answer/apply at a time. Reobserve changes applicability, while the answered prefix remains counted. */
export function createOnboardingSession(port: OnboardingPort, initial: OnboardingSnapshot, revisit = false, focus?: OnboardingFocus, signal?: AbortSignal) {
  let snapshot = initial, answers = { ...initial.answers }, completed: string[] = [];
  const deferred = new Set<string>();
  const model = (): OnboardingPresentation => {
    const steps = onboardingSteps({ ...snapshot, deferred: [...snapshot.deferred, ...deferred] }, revisit)
      .filter(row => !completed.includes(row.id) && !deferred.has(row.id) && (focus === 'model' ? row.id === 'core:model'
        : focus !== 'workers' || row.kind === 'work' || row.kind === 'ready' || /^(work|execution):/u.test(row.id)));
    return { schemaVersion: 1, steps, completed: completed.length, total: completed.length + steps.length + awaitedImage(snapshot, steps), snapshot };
  };
  // Settling forgets settled deferrals and reconciles parked intents on the current snapshot (no second observation at open).
  const settle = async () => {
    const open = openDeferrals(snapshot), settled = snapshot.deferred.filter(id => !open.includes(id));
    // Astra 2862 R1: a launch that ended (`signal`, e.g. its shell closed) starts no settle write.
    if (settled.length && port.settle) { signal?.throwIfAborted(); await port.settle(settled); snapshot = { ...snapshot, deferred: snapshot.deferred.filter(id => !settled.includes(id)) }; }
    const pending = [];
    for (const intent of snapshot.pending) { if (['parked', 'released'].includes(intent.status)) signal?.throwIfAborted(); pending.push(['parked', 'released'].includes(intent.status) ? await port.reconcile(intent) : intent); }
    snapshot = { ...snapshot, pending }; answers = { ...snapshot.answers, ...answers }; return model();
  };
  const refresh = async () => { snapshot = await port.observe(answers); return settle(); };
  return { model, refresh, settle,
    answer: async (stage: string, value: unknown) => { answers[stage] = value; return refresh(); },
    finish: async (step: OnboardingStep) => { completed = [...completed, step.id]; return refresh(); },
    defer: async (step: OnboardingStep) => {
      await port.assertPerson(); await port.defer(step.id, snapshot.plan.planDigest); deferred.add(step.id); completed = [...completed, step.id]; return model();
    },
  };
}

export function deferredOnboardingNotice(input: OnboardingSnapshot, locale: Locale): string | null {
  const done = input.deferred.includes(FIRST_TASK_DONE), snapshot = { ...input, deferred: openDeferrals(input).filter(id => id !== FIRST_TASK_DONE && !(done && id === 'onboarding:first-task')) }; // AYSE-R2-04
  if (!snapshot.deferred.length) return null;
  const presentationTitles: Readonly<Record<string, string>> = { 'onboarding:budget': 'onboarding.budget.question', 'permissions:start-mode': 'onboarding.permissions.title',
    'onboarding:first-task': 'onboarding.firstTask.title', 'onboarding:worker-ready': 'onboarding.ready.title', 'permissions:owner-rights': 'onboarding.rights.title' };
  const stages = snapshot.deferred.map(id => onboardingMessage(snapshot.plan.stages.find(stage => stage.id === id)?.title ?? presentationTitles[id] ?? (id.startsWith('parked:') ? 'onboarding.parked.title' : id), {}, locale)).join(', ');
  return t('onboarding.deferredLine', { stages }, locale);
}
