import { workerImageQuestion, workerImageProgress } from './worker-image.js';
import type { WorkerImageState } from '#engine/index.js';
import { onboardingMessage } from './message.js';
import { t, ErrorRegistry } from '#platform/index.js';
import { type CliCardIo } from '#surfaces/core/cli-human/index.js';
import type { FirstTaskIntent, OnboardingFocus, OnboardingPort, OnboardingUi } from './contract.js';
import { createOnboardingSession, firstSignedInHost, FIRST_TASK_DONE } from './session.js';
import { askOnboardingQuestion, type QuestionAnswer } from './question.js';
import { welcomeScreen } from './first-task.js';
import { guideScreen } from './guides.js';
import { settleOnboardingReady } from './ready.js';
import { firstCommitScreen } from './first-commit.js';
import presentation from './presentation.json' with { type: 'json' };
/** The same session drives first open and /setup; no Workline/composer is mounted in this loop. */
export async function runOnboardingSession(port: OnboardingPort, ui: OnboardingUi, io: CliCardIo, revisit = false, focus?: OnboardingFocus, conversationNotice?: string): Promise<FirstTaskIntent | null> {
  if (io.signal?.aborted) return null;
  return (await prepareOnboardingSession(port, revisit, focus)).show(ui, io, conversationNotice);
}
/** alpha.60 B: the half of an open that draws nothing — the person check, the one observation and its settle — so the opening runs it after the
 * first frame and knows how many steps wait (`total`, 0: none) before a card takes the terminal; `show` runs the cards of that same session. */
export async function prepareOnboardingSession(port: OnboardingPort, revisit = false, focus?: OnboardingFocus, signal?: AbortSignal) {
  await port.assertPerson();
  // One observation per open: settling writes (forgotten deferrals, reconciled intents) and the settled snapshot is the one shown and shared.
  // A closed terminal (`signal`) ends the observation and starts no settle write.
  const observed = await port.observe({}, signal); signal?.throwIfAborted();
  const session = createOnboardingSession(port, observed, revisit, focus, signal), model = await session.settle();
  const welcome = !focus && !model.snapshot.deferred.includes(FIRST_TASK_DONE);
  return { total: model.steps.length ? model.total : 0, welcome, snapshot: model.snapshot,
    show: (ui: OnboardingUi, io: CliCardIo, conversationNotice?: string) => showOnboardingSession(session, port, ui, io, conversationNotice, welcome) };
}
async function showOnboardingSession(session: ReturnType<typeof createOnboardingSession>, port: OnboardingPort, ui: OnboardingUi, io: CliCardIo, conversationNotice?: string, welcome = false): Promise<FirstTaskIntent | null> {
  let shown = false;
  while (!io.signal?.aborted) {
    const model = session.model(), step = model.steps[0], locale = io.locale;
    if (!step) {
      if (!shown) ui.observed?.(model.snapshot);
      if (!welcome || io.signal?.aborted) return null;
      const result = await welcomeScreen(model, io, conversationNotice);
      // R3d: the marker records a welcome that was shown (a usable model); a welcome marker never discards the person's explicit choice.
      if (!io.signal?.aborted && model.snapshot.modelUsable) await port.defer(FIRST_TASK_DONE, model.snapshot.plan.planDigest).catch(() => undefined);
      return result;
    }
    shown = true;
    if (step.kind === 'budget' || step.kind === 'permissions' || step.kind === 'rights') {
      try {
        const result = await guideScreen(model, step.kind, port, io);
        if (result === 'exit') return null;
        if (result === 'later') await session.defer(step); else await session.finish(step);
      } catch (error) {
        const feedback = await askOnboardingQuestion({ title: t('onboarding.session.blocked', {}, locale), step: model.completed + 1, total: model.total,
          body: [error instanceof Error ? error.message : t('onboarding.session.waiting', {}, locale)], choices: [] }, io);
        if (feedback.id === 'exit') return null;
        await session.defer(step);
      }
      continue;
    }
    const stage = step.stages[0], pending = step.pending;
    const title = pending ? t('onboarding.parked.title', {}, locale) : stage ? onboardingMessage(stage.title, {}, locale) : '';
    const body = stage ? [onboardingMessage(stage.reason.code, stage.reason.params, locale)] : pending ? [pending.status === 'starting' ? t('onboarding.parked.unknown', {}, locale) : pending.status === 'released' ? t('onboarding.parked.released', {}, locale) : ErrorRegistry.createError(pending.fact.reason, { locale, params: pending.fact.params }).message] : [];
    if (step.kind === 'ready' && model.snapshot.ready) {
      const ready = model.snapshot.ready;
      body.push(...ready.connection ? [t('onboarding.ready.connectionBody', {}, locale), t('onboarding.ready.connection', { provider: ready.provider ?? '-' }, locale)]
        : [t('onboarding.ready.body', {}, locale), t('onboarding.ready.image', { provider: ready.provider ?? '-', image: ready.imageId ?? '-' }, locale),
          t('onboarding.ready.fallback', { before: ready.fallbackBefore ?? '-', after: ready.fallbackAfter ?? '-' }, locale)]);
    }
    const question = { title, body, step: model.completed + 1, total: model.total,
      choices: pending ? [...(pending.status === 'released' ? [{ id: 'start', label: t('onboarding.parked.start', {}, locale) }] : []),
        ...(pending.status === 'starting' ? [{ id: 'reconcile', label: t('onboarding.parked.reconcile', {}, locale) }] : [{ id: 'cancel', label: t('onboarding.parked.cancel', {}, locale) }])]
        : [{ id: 'continue', label: t('onboarding.session.continue', {}, locale) }] };
    let choice: QuestionAnswer;
    if (step.kind === 'work') {
      const rows = model.snapshot.hosts.filter(row => !model.snapshot.admittedProviders?.includes(row.id)), admitted = model.snapshot.admittedProviders ?? [];
      // F2-13: one row per subscription CLI (its first connected profile): the system assigns the worker model per WorkClass, so per-model rows only repeated the CLI.
      const provider = firstSignedInHost({ ...model.snapshot, hosts: rows }), connections = (model.snapshot.connections ?? []).filter((row, index, all) => all.findIndex(other => other.provider === row.provider) === index);
      const uncertain = model.snapshot.hosts.some(row => row.cli === 'unknown' || row.cli === 'found' && row.login === 'unknown');
      const picker = { title: firstSignedInHost(model.snapshot) ? t('onboarding.work.none', {}, locale) : uncertain ? t('onboarding.work.notReady', {}, locale) : model.snapshot.hosts.some(row => row.cli === 'found') ? t('onboarding.work.unsigned', {}, locale) : t('onboarding.work.missing', {}, locale),
        body: [...body, t('onboarding.work.explain', {}, locale)], choices: rows.map(row => {
          const ready = row.cli === 'found' && row.login === 'found', guidance = presentation.cliGuidance.find(entry => entry.id === row.id);
          const status = ready ? t('onboarding.work.available', {}, locale) : row.cli === 'absent' ? t('onboarding.work.cliMissing', {}, locale)
            : row.cli === 'found' && row.login === 'absent' ? t('onboarding.work.loginMissing', {}, locale) : t('onboarding.work.unknown', {}, locale);
          return { id: row.id, label: `${row.id} · ${status}`,
            disabled: !ready, detail: !ready && guidance ? [t('onboarding.work.install', { cli: row.id, page: guidance.installPage }, locale),
              t('onboarding.work.signIn', { command: guidance.signIn }, locale), t('onboarding.work.return', {}, locale)] : [] };
        }) };
      // R3a: a connected subscription is offered first (a worker without Docker or a token); a host CLI on Docker stays under Change.
      const offer = connections.length ? { title: t('onboarding.work.connection', {}, locale), body: [...body, t('onboarding.ready.connectionBody', {}, locale)], choices: connections.map(row => ({ id: `connection:${row.id}`, label: t('onboarding.work.useSubscription', { cli: row.provider }, locale) })) }
        : provider ? { title: t('onboarding.work.selected', { cli: provider }, locale), body, choices: [{ id: provider, label: t('onboarding.session.continue', {}, locale) }] } : picker;
      // BeUser M-28: a kind already set up (revisit) is kept by default; adding another CLI is the explicit second choice.
      choice = admitted.length && step.stages[0]?.state === 'done' ? await askOnboardingQuestion({ ...question, title: t('onboarding.work.configured', { cli: admitted.join(', ') }, locale),
        choices: [{ id: 'keep', label: t('onboarding.session.continue', {}, locale) }, { id: 'change', label: t('onboarding.work.add', {}, locale) }] }, io) : await askOnboardingQuestion({ ...question, title: offer.title, body: offer.body,
        choices: [...offer.choices, ...(provider || connections.length ? [{ id: 'change', label: t('onboarding.work.change', {}, locale) }] : [])] }, io);
      if (choice.id === 'keep') { await session.finish(step); continue; }
      const connection = connections.find(row => choice.id === `connection:${row.id}`);
      if (connection) {
        await session.answer('work:kind', { connection: connection.id }); await session.finish(step);
        // R8f: choosing the subscription also confirms the worker-ready writes (one card, not two in a row); a refusal leaves the ready card to show.
        const ready = session.model().steps[0];
        if (ready?.kind === 'ready' && await settleOnboardingReady(port, ui, session.refresh, async () => false, true).catch(() => false)) await session.finish(ready);
        continue;
      }
      const changing = choice.id === 'change';
      if (changing) choice = await askOnboardingQuestion({ ...question, ...picker }, io);
      if (changing && rows.some(row => row.id === choice.id && row.cli === 'found' && row.login === 'found')) {
        const selected = choice.id;
        const confirmed = await askOnboardingQuestion({ ...question, title: t('onboarding.work.selected', { cli: selected }, locale),
          choices: [{ id: selected, label: t('onboarding.session.continue', {}, locale) }] }, io);
        choice = confirmed;
      }
      if (rows.some(row => row.id === choice.id && row.cli === 'found' && row.login === 'found')) {
        await session.answer('work:kind', choice.id); await session.finish(step); continue;
      }
    } else if (stage?.id === 'execution:worker') {
      const worker = (model.snapshot.observation.families?.['execution'] as { worker?: { acquisition?: WorkerImageState | null; image?: string; configured?: string | null } } | undefined)?.worker;
      if (worker?.acquisition && ['requested', 'waiting-docker', 'acquiring'].includes(worker.acquisition.phase)) {
        const progress = await askOnboardingQuestion({ ...question, title: t('setup.workerImage.card.progress', {}, locale),
          body: workerImageProgress(worker.acquisition, locale), choices: [{ id: 'continue', label: t('onboarding.session.continue', {}, locale) }] }, io);
        if (progress.id === 'exit') return null;
        await session.finish(step); continue;
      }
      if (worker?.configured && worker.image !== 'missing' && worker.image !== 'present') {
        choice = await askOnboardingQuestion({ ...question, choices: [] }, io);
      } else {
        const provider = model.snapshot.answers['work:kind'];
        if (typeof provider !== 'string') { await session.defer(step); continue; }
        try {
          const preview = await port.previewConsent(provider);
          const asked = workerImageQuestion(preview, locale, worker?.image === 'missing' ? worker.configured ?? undefined : undefined), interrupted = worker?.acquisition?.code === 'WORKER_IMAGE_BUILD_INTERRUPTED'; // BeUser D-01
          choice = await askOnboardingQuestion({ ...question, ...asked, body: [...(interrupted ? [t('setup.workerImage.card.interrupted', {}, locale)] : []), ...asked.body] }, io);
          if (choice.id === 'exit') return null;
          if (choice.id === 'later') { await session.defer(step); continue; }
          const selected = preview.images?.find(image => image.imageId === choice.id && image.ready);
          if (choice.id !== 'consent' && !selected) continue;
          await port.consent(provider, preview.digest, selected?.imageId);
          if (!selected && (await askOnboardingQuestion({ ...question, title: t('setup.workerImage.card.progress', {}, locale), body: [t('setup.workerImage.card.started', {}, locale)],
            choices: [{ id: 'continue', label: t('onboarding.session.continue', {}, locale) }] }, io)).id === 'exit') return null; // BeUser D-01: say it started and where to watch
          await session.finish(step); continue;
        } catch (error) {
          const feedback = await askOnboardingQuestion({ ...question, title: t('onboarding.session.blocked', {}, locale),
            body: [error instanceof Error ? error.message : t('onboarding.session.waiting', {}, locale)], choices: [] }, io);
          if (feedback.id === 'exit') return null;
          await session.defer(step); continue;
        }
      }
    } else choice = await askOnboardingQuestion({ ...question, ...(stage?.state === 'blocked' ? { choices: [] } : {}) }, io);
    if (choice.id === 'exit') return null;
    if (choice.id === 'later') { await session.defer(step); continue; }
    try {
      if (pending && choice.id === 'cancel') { await port.cancel(pending); await session.finish(step); continue; }
      if (pending) return { commandId: pending.command.commandId, scopeId: pending.command.scopeId, folder: model.snapshot.folder, intent: pending.command.intent, pending };
      else if (stage?.id === 'coding:first-commit') {
        const result = await firstCommitScreen(port, model, io, stage.operation?.id === 'coding.first-commit-recovery');
        if (result === 'exit') return null;
        if (result === 'later') { await session.defer(step); continue; }
      }
      else if (stage?.id === 'core:model') {
        await ui.provider();
        // Leaving the provider choice without a usable model is the same persistent Later as on the model card.
        if (!(await session.refresh()).snapshot.modelUsable) { await session.defer(step); continue; }
      }
      else if (stage?.id === 'instructions:bridges') await ui.instructions();
      else if (step.kind === 'ready') {
        const settled = await settleOnboardingReady(port, ui, session.refresh, async preview =>
          (await askOnboardingQuestion({ ...question, title: t('onboarding.profile.title', {}, locale),
            body: [t('onboarding.profile.body', { profile: preview.profile, image: preview.image, provider: preview.provider, kind: preview.kind }, locale)], choices: [{ id: 'apply', label: t('onboarding.session.continue', {}, locale) }] }, io)).id === 'apply');
        if (!settled) { await session.defer(step); continue; }
      } else if (stage?.operation) {
        const result = await ui.foreground(stage);
        if (result.status !== 'applied') { await session.defer(step); continue; }
      }
      if (io.signal?.aborted) return null;
      await session.finish(step);
    } catch (error) {
      const feedback = await askOnboardingQuestion({ ...question, title: t('onboarding.session.blocked', {}, locale),
        body: [error instanceof Error ? error.message : t('onboarding.session.waiting', {}, locale)], choices: [] }, io);
      if (feedback.id === 'exit') return null;
      await session.defer(step);
    }
  }
  return null;
}
