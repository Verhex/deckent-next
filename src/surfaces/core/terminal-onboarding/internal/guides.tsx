import { onboardingMessage } from './message.js';
import { t, ErrorRegistry, type Locale } from '#platform/index.js';
import { profileName } from '#surfaces/core/cli-identity/index.js';
import type { CliCardIo } from '#surfaces/core/cli-human/index.js';
import type { OnboardingPort, OnboardingPresentation } from './contract.js';
import { askOnboardingQuestion, type OnboardingQuestion } from './question.js';
export function guideQuestion(model: OnboardingPresentation, kind: 'budget' | 'permissions' | 'rights', locale: Locale): OnboardingQuestion {
  const { budget, permissions, rights } = model.snapshot;
  if (kind === 'rights') return { title: t('onboarding.rights.title', {}, locale), step: model.completed + 1, total: model.total, initial: 'apply',
    body: [t('onboarding.rights.body', { count: rights?.rules ?? 0, scope: model.snapshot.scopeId }, locale), t('onboarding.rights.grants', {}, locale), t('onboarding.rights.later', {}, locale)],
    choices: [{ id: 'apply', label: t('onboarding.rights.apply', {}, locale) }] };
  return { title: kind === 'budget' ? t('onboarding.budget.question', {}, locale) : t('onboarding.permissions.title', {}, locale), step: model.completed + 1, total: model.total,
    body: [kind === 'budget' ? budget.reason ? ErrorRegistry.createError(budget.reason, { locale }).message : t('onboarding.budget.zero', {}, locale) : onboardingMessage(permissions.reason, { profile: permissions.profile ? profileName(permissions.profile, locale) : '-', mode: onboardingMessage(`terminal.mode.stop.${permissions.mode ?? 'standart'}`, {}, locale), principal: permissions.principal ?? '-', scope: model.snapshot.scopeId }, locale)],
    choices: kind === 'budget' ? budget.currentUsd === null ? [] : budget.presetsUsd.map(usd => ({ id: String(usd), label: t('onboarding.budget.preset', { usd }, locale) }))
      : permissions.state === 'needs-confirmation' ? [{ id: 'apply', label: t('onboarding.session.continue', {}, locale) }] : [],
    ...(kind === 'budget' ? { initial: String(budget.presetUsd) } : {}) };
}
export async function guideScreen(model: OnboardingPresentation, kind: 'budget' | 'permissions' | 'rights', port: OnboardingPort, io: CliCardIo): Promise<'applied' | 'later' | 'exit'> {
  let current = model;
  if (kind === 'permissions' && model.snapshot.permissions.state === 'needs-profile') {
    const profiles = model.snapshot.permissions.profiles ?? [];
    const selected = await askOnboardingQuestion({ title: t('onboarding.permissions.title', {}, io.locale), step: model.completed + 1, total: model.total,
      body: [t('onboarding.permissions.chooseProfile', {}, io.locale)], choices: profiles.map((profile, index) => ({ id: String(index), label: profileName(profile.id, io.locale) })) }, io);
    if (selected.id === 'later' || selected.id === 'exit') return selected.id;
    const profile = profiles.find((_row, index) => String(index) === selected.id);
    if (!profile || !port.previewPermissions) return 'later';
    const preview = await port.previewPermissions(profile);
    current = { ...model, snapshot: { ...model.snapshot, permissions: { ...preview, state: preview.state === 'needs-profile' ? 'needs-confirmation' : preview.state } } };
  }
  const question = guideQuestion(current, kind, io.locale), picked = await askOnboardingQuestion(question, io);
  if (picked.id === 'later' || picked.id === 'exit') return picked.id;
  await port.assertPerson();
  if (kind === 'rights') { if (picked.id !== 'apply' || !port.rights || !current.snapshot.rights?.digest) return 'later';
    const result = await port.rights(current.snapshot.rights.digest), given = result.status === 'applied' || result.status === 'current'; // AYSE-R2-02 / D11-M1: only applied/current count
    if ((await askOnboardingQuestion({ ...question, body: [given ? t('onboarding.rights.applied', {}, io.locale) : t('onboarding.rights.notApplied', { status: result.status }, io.locale)], choices: [{ id: 'apply', label: t('onboarding.session.continue', {}, io.locale) }], initial: 'apply' }, io)).id === 'exit') return 'exit';
    if (!given) return 'later'; }
  else if (kind === 'permissions') { if (picked.id !== 'apply' || !port.permissions || !current.snapshot.permissions.digest) return 'later'; await port.permissions(current.snapshot.permissions.digest, current.snapshot.permissions.selectedProfile ?? undefined); }
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
