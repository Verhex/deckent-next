import { t } from '#platform/index.js';
import type { CliCardIo } from '#surfaces/core/cli-human/index.js';
import { firstTaskIntent } from './first-tasks.js';
import { askOnboardingQuestion } from './question.js';
import type { FirstTaskIntent, OnboardingPresentation } from './contract.js';
import presentation from './presentation.json' with { type: 'json' };
import { welcomeInput } from './welcome-input.js';
/** Separate from setup: these prompts enter the normal governed chat turn, never a new effect path. */
export async function welcomeScreen(model: OnboardingPresentation, io: CliCardIo, conversationNotice?: string): Promise<FirstTaskIntent | null> {
  if (!model.snapshot.modelUsable) return null;
  const locale = io.locale, question = { title: t('onboarding.welcome.title', {}, locale), step: 0, total: 0,
    body: [t('onboarding.welcome.body', {}, locale), ...(conversationNotice ? [conversationNotice] : [])], choices: [
      { id: 'describe', label: t('onboarding.welcome.describe', {}, locale) },
      ...(model.snapshot.folderFacts.entries.length ? [{ id: 'scan', label: t('onboarding.welcome.scan', {}, locale) }] : []),
      { id: 'first', label: t('onboarding.welcome.first', {}, locale) }] };
  const input = welcomeInput((io.stdin ?? process.stdin) as NodeJS.ReadStream);
  const picked = await (async () => {
    try { return await askOnboardingQuestion(question, { ...io, stdin: input.stdin }, undefined, 'applying', { guardMs: presentation.welcomeInputGuardMs, typed: input.typed }); }
    finally { input.close(); }
  })();
  if (!['describe', 'scan', 'first'].includes(picked.id) || io.signal?.aborted) return null;
  const free = picked.id === 'first' ? await askOnboardingQuestion({ ...question, title: t('onboarding.welcome.first', {}, locale), choices: [], text: true }, io) : null;
  if (free && free.id !== 'submit' || io.signal?.aborted) return null;
  const text = free?.text ?? (picked.id === 'scan' ? t('onboarding.welcome.scanPrompt', {}, locale) : t('onboarding.welcome.describePrompt', {}, locale));
  const intent = firstTaskIntent({ action: 'submit', text, scopeId: model.snapshot.scopeId, folder: model.snapshot.folder, commandId: globalThis.crypto.randomUUID() });
  return intent ? { ...intent, destination: 'chat' } : null;
}
