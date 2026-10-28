import { onboardingMessage } from './message.js';
import { t, type Locale } from '#platform/index.js';
import type { CliCardIo } from '#surfaces/core/cli-human/index.js';
import { FirstTaskRegistry, firstTaskIntent } from './first-tasks.js';
import { askOnboardingQuestion } from './question.js';
import type { FirstTaskIntent, OnboardingPresentation } from './contract.js';
/** The first-task screen's explanation (owner İ-1): without a worker pool it says whether the task may run here behind the card, or that the host's answer (K3) closed it. */
export const firstTaskBody = (snapshot: OnboardingPresentation['snapshot'], locale: Locale): readonly string[] => [t('onboarding.firstTask.body', {}, locale), ...(snapshot.plan.stages.some(stage => stage.id === 'work:pool' && stage.state !== 'done') ? [snapshot.localRun === false ? t('onboarding.firstTask.localClosed', {}, locale) : snapshot.folderFacts.kind === 'coding' ? t('onboarding.firstTask.local', {}, locale) : t('onboarding.firstTask.localNoGit', {}, locale)] : [])];
export async function firstTaskScreen(model: OnboardingPresentation, io: CliCardIo, registry = new FirstTaskRegistry(), conversationNotice?: string): Promise<FirstTaskIntent | 'later' | 'exit'> {
  const snapshot = model.snapshot, rows = registry.select(snapshot.folderFacts), locale = io.locale;
  const question = { title: t('onboarding.firstTask.title', {}, locale), step: model.completed + 1, total: model.total,
    body: [...firstTaskBody(snapshot, locale), ...(conversationNotice ? [conversationNotice] : [])], choices: [...rows.map(row => ({ id: row.id,
      label: `${onboardingMessage(row.labelKey, {}, locale)} · ${onboardingMessage(row.effectKey, {}, locale)}` })), { id: 'free', label: t('onboarding.firstTask.freeText', {}, locale) }] };
  const picked = await askOnboardingQuestion(question, io);
  if (picked.id === 'later' || picked.id === 'exit') return picked.id;
  const free = picked.id === 'free' ? await askOnboardingQuestion({ ...question, choices: [], text: true }, io) : null;
  if (free?.id === 'later' || free?.id === 'exit') return free.id;
  const row = rows.find(item => item.id === picked.id), text = free?.text ?? (row ? onboardingMessage(row.intentKey, {}, locale) : '');
  const intentText = t('onboarding.firstTask.folderIntent', { folder: snapshot.folder || t('onboarding.firstTask.projectFolder', {}, locale), request: text }, locale);
  return firstTaskIntent({ action: 'submit', text: intentText, scopeId: snapshot.scopeId, folder: snapshot.folder, commandId: globalThis.crypto.randomUUID() }) ?? 'later';
}
