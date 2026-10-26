import { onboardingMessage } from './message.js';
import { t, ErrorRegistry, type Locale } from '#platform/index.js';
import type { CliCardIo } from '#surfaces/core/cli-human/index.js';
import type { OnboardingPort, OnboardingPresentation } from './contract.js';
import { askOnboardingQuestion, type OnboardingQuestion } from './question.js';
export function guideQuestion(model: OnboardingPresentation, kind: 'budget' | 'permissions', locale: Locale): OnboardingQuestion {
  const { budget, permissions } = model.snapshot;
  return { title: kind === 'budget' ? t('onboarding.budget.question', {}, locale) : t('onboarding.permissions.title', {}, locale), step: model.completed + 1, total: model.total,
    body: [kind === 'budget' ? budget.reason ? ErrorRegistry.createError(budget.reason, { locale }).message : t('onboarding.budget.zero', {}, locale) : onboardingMessage(permissions.reason, {}, locale)],
    choices: kind === 'budget' ? budget.currentUsd === null ? [] : budget.presetsUsd.map(usd => ({ id: String(usd), label: t('onboarding.budget.preset', { usd }, locale) }))
      : permissions.state === 'needed' ? [{ id: 'apply', label: t('onboarding.session.continue', {}, locale) }] : [],
    ...(kind === 'budget' ? { initial: String(budget.presetUsd) } : {}) };
}
export async function guideScreen(model: OnboardingPresentation, kind: 'budget' | 'permissions', port: OnboardingPort, io: CliCardIo): Promise<'applied' | 'later' | 'exit'> {
  const question = guideQuestion(model, kind, io.locale), picked = await askOnboardingQuestion(question, io);
  if (picked.id === 'later' || picked.id === 'exit') return picked.id;
  await port.assertPerson();
  if (kind === 'permissions') { if (!port.permissions) return 'later'; await port.permissions(); }
  else {
    const usd = model.snapshot.budget.presetsUsd.find(value => String(value) === picked.id);
    if (usd === undefined) return 'later';
    const confirmed = await askOnboardingQuestion({ ...question, body: [t('onboarding.budget.confirm', { usd }, io.locale)],
      choices: [{ id: 'apply', label: t('onboarding.budget.apply', {}, io.locale) }], initial: 'apply' }, io);
    if (confirmed.id !== 'apply') return confirmed.id === 'exit' ? 'exit' : 'later';
    await port.budget(usd);
  }
  return 'applied';
}
