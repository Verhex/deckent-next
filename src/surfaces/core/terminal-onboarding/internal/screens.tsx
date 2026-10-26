import { onboardingMessage } from './message.js';
import { t, ErrorRegistry } from '#platform/index.js';
import { formatDuration, formatDecimal, type CliCardIo } from '#surfaces/core/cli-human/index.js';
import type { FirstTaskIntent, OnboardingPort, OnboardingUi } from './contract.js';
import { createOnboardingSession, firstSignedInHost } from './session.js';
import { askOnboardingQuestion, type QuestionAnswer } from './question.js';
import { firstTaskScreen } from './first-task.js';
import { guideScreen } from './guides.js';
import { settleOnboardingReady } from './ready.js';
import { firstCommitScreen } from './first-commit.js';
/** The same session drives first open and /setup; no Workline/composer is mounted in this loop. */
export async function runOnboardingSession(port: OnboardingPort, ui: OnboardingUi, io: CliCardIo, revisit = false): Promise<FirstTaskIntent | null> {
  if (io.signal?.aborted) return null;
  await port.assertPerson();
  const initial = await port.observe({}), session = createOnboardingSession(port, initial, revisit);
  await session.refresh();
  while (!io.signal?.aborted) {
    const model = session.model(), step = model.steps[0], locale = io.locale;
    if (!step) return null;
    if (step.kind === 'first-task') {
      const result = await firstTaskScreen(model, io);
      if (result === 'later') await session.defer(step);
      return typeof result === 'object' ? result : null;
    }
    if (step.kind === 'budget' || step.kind === 'permissions') {
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
      body.push(t('onboarding.ready.body', {}, locale), t('onboarding.ready.image', { provider: ready.provider ?? '-', image: ready.imageId ?? '-' }, locale),
        t('onboarding.ready.fallback', { before: ready.fallbackBefore ?? '-', after: ready.fallbackAfter ?? '-' }, locale));
    }
    const question = { title, body, step: model.completed + 1, total: model.total,
      choices: pending ? [...(pending.status === 'released' ? [{ id: 'start', label: t('onboarding.parked.start', {}, locale) }] : []),
        ...(pending.status === 'starting' ? [{ id: 'reconcile', label: t('onboarding.parked.reconcile', {}, locale) }] : [{ id: 'cancel', label: t('onboarding.parked.cancel', {}, locale) }])]
        : [{ id: 'continue', label: t('onboarding.session.continue', {}, locale) }] };
    let choice: QuestionAnswer;
    if (step.kind === 'work') {
      const rows = model.snapshot.hosts.filter(row => !model.snapshot.admittedProviders?.includes(row.id));
      const provider = firstSignedInHost({ ...model.snapshot, hosts: rows });
      choice = await askOnboardingQuestion({ ...question, title: provider ? t('onboarding.work.selected', { cli: provider }, locale) : t('onboarding.work.none', {}, locale),
        choices: [...(provider ? [{ id: provider, label: t('onboarding.session.continue', {}, locale) }] : []), { id: 'change', label: t('onboarding.work.change', {}, locale) }] }, io);
      const changing = choice.id === 'change';
      if (changing) choice = await askOnboardingQuestion({ ...question, choices: rows.map(row => ({ id: row.id,
        label: `${row.id} · ${(row.cli === 'found' && row.login === 'found' ? t('onboarding.work.available', {}, locale) : t('onboarding.work.unavailable', {}, locale))}`,
        disabled: row.cli !== 'found' || row.login !== 'found' })) }, io);
      if (changing && rows.some(row => row.id === choice.id && row.cli === 'found' && row.login === 'found')) {
        const selected = choice.id;
        const confirmed = await askOnboardingQuestion({ ...question, title: t('onboarding.work.selected', { cli: selected }, locale),
          choices: [{ id: selected, label: t('onboarding.session.continue', {}, locale) }] }, io);
        choice = confirmed;
      }
      if (rows.some(row => row.id === choice.id && row.cli === 'found' && row.login === 'found')) {
        await session.answer('work:kind', choice.id); await session.finish(step); continue;
      }
    } else choice = await askOnboardingQuestion({ ...question,
      ...(stage?.state === 'blocked' && !(stage.id === 'execution:worker' && stage.reason.code === 'setup.execution.workerConsentRequired') ? { choices: [] } : {}) }, io);
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
      else if (stage?.id === 'core:model') await ui.provider();
      else if (stage?.id === 'instructions:bridges') await ui.instructions();
      else if (stage?.id === 'execution:worker') {
        const provider = model.snapshot.answers['work:kind'];
        if (typeof provider !== 'string') throw ErrorRegistry.createError('WORKER_IMAGE_CONSENT_MISSING');
        const preview = await port.previewConsent(provider);
        const consent = await askOnboardingQuestion({ ...question, title: t('onboarding.imageConsent.title', { provider }, locale),
          body: [t('onboarding.imageConsent.body', { size: formatDecimal(preview.sizeGigabytes, locale, 1), timeout: formatDuration(preview.buildTimeoutMs, locale) }, locale),
            ...preview.sources, preview.baseRef, t('onboarding.imageConsent.limits', {}, locale)],
          choices: [{ id: 'consent', label: t('onboarding.imageConsent.yes', {}, locale) }] }, io);
        if (consent.id === 'exit') return null;
        if (consent.id !== 'consent') { await session.defer(step); continue; }
        await port.consent(provider, preview.digest);
      } else if (step.kind === 'ready') {
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
