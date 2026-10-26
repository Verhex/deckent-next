import { onboardingMessage } from './message.js';
import { t, terminalSafeText, ErrorRegistry } from '#platform/index.js';
import type { CliCardIo } from '#surfaces/core/cli-human/index.js';
import type { OnboardingPort, OnboardingPresentation } from './contract.js';
import { askOnboardingQuestion } from './question.js';
/** The Git owner supplies every fact; flags are opt-in path selections, never an approval or an automatic retry. */
export async function firstCommitScreen(port: OnboardingPort, model: OnboardingPresentation, io: CliCardIo, recovery = false) {
  if (!port.previewFirstCommit || !port.firstCommit || !port.firstCommitRecovery) throw ErrorRegistry.createError('SETUP_APPLY_UNAVAILABLE');
  const question = { title: t('setup.coding.firstCommit.title', {}, io.locale), step: model.completed + 1, total: model.total };
  // A card without its action never leaves Enter dead: Skip defers it like Esc (back with /setup).
  const skip = { id: 'later', label: t('setup.coding.firstCommit.skip', {}, io.locale) };
  if (recovery) {
    const state = await port.firstCommitRecovery();
    if (state.state !== 'pending') return 'applied' as const;
    const result = await askOnboardingQuestion({ ...question, body: [onboardingMessage(state.overlap.length ? 'setup.coding.firstCommit.overlap' : state.locked ? 'setup.coding.firstCommit.locked' : 'setup.coding.firstCommit.recovery', {}, io.locale),
      ...state.paths.map(path => terminalSafeText(path)), terminalSafeText(state.pathsFile), ...(state.command ? [terminalSafeText(state.command)] : [])], choices: [skip] }, io);
    return result.id === 'exit' ? 'exit' as const : 'later' as const;
  }
  const message = t('setup.coding.firstCommit.message', {}, io.locale), include: string[] = [];
  while (!io.signal?.aborted) {
    const preview = await port.previewFirstCommit(message, include);
    if (preview.state === 'has-commits') return 'applied' as const;
    if (preview.state === 'staged') {
      const result = await askOnboardingQuestion({ ...question, body: [t('setup.coding.firstCommit.staged', {}, io.locale)], choices: [skip] }, io);
      return result.id === 'exit' ? 'exit' as const : 'later' as const;
    }
    // An empty repository has nothing to commit yet: say so instead of "0 of 0 files", and offer only Skip.
    if (preview.total === 0) {
      const result = await askOnboardingQuestion({ ...question, body: [t('setup.coding.firstCommit.empty', {}, io.locale)], choices: [skip] }, io);
      return result.id === 'exit' ? 'exit' as const : 'later' as const;
    }
    const result = await askOnboardingQuestion({ ...question, body: [t('setup.coding.firstCommit.summary', { count: preview.selected, total: preview.total, more: preview.more }, io.locale),
      onboardingMessage(preview.sign ? 'setup.coding.firstCommit.sign' : 'setup.coding.firstCommit.noSign', {}, io.locale), t('setup.coding.firstCommit.noHooks', {}, io.locale),
      ...(!preview.identity ? [t('setup.coding.firstCommit.identity', {}, io.locale)] : []),
      ...preview.rows.map(row => `${include.includes(row.path) || !row.flag ? '[x]' : '[ ]'} ${terminalSafeText(row.path)}${row.flag ? ` · ${onboardingMessage(`setup.coding.firstCommit.flag.${row.flag}`, {}, io.locale)}` : ''}`)],
      choices: [...(preview.identity && preview.selected ? [{ id: 'apply', label: t('setup.coding.firstCommit.apply', {}, io.locale) }] : []),
        ...preview.rows.filter(row => row.flag && row.flag !== 'nested-repository').map((row, index) => ({ id: `flag:${index}`, label: t('setup.coding.firstCommit.toggle', { path: terminalSafeText(row.path) }, io.locale) })),
        ...(preview.identity && preview.selected ? [] : [skip])] }, io);
    if (result.id === 'exit' || result.id === 'later') return result.id;
    if (result.id.startsWith('flag:')) {
      const row = preview.rows.filter(row => row.flag && row.flag !== 'nested-repository')[Number(result.id.slice(5))];
      if (row) { const index = include.indexOf(row.path); if (index < 0) include.push(row.path); else include.splice(index, 1); }
      continue;
    }
    if (result.id === 'apply') {
      await port.assertPerson();
      const outcome = await port.firstCommit({ message, digest: preview.digest, include }, io.signal);
      return outcome.status === 'settled' ? 'applied' as const : 'later' as const;
    }
  }
  return 'exit' as const;
}
