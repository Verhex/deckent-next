import { t, uninstallRetired, reopenInstallation, type Locale } from '#platform/index.js';
import { askCliCard } from './card.js';
/** §5.4 (owner 2026-10-27): a folder whose installation was removed keeping its data reopens only on the person's own card (Continue); false: not now. */
export async function reopenRetiredFolder(config: unknown, locale: Locale, env: NodeJS.ProcessEnv): Promise<boolean> {
  const root = (config as { productLayout?: { root: string } }).productLayout?.root;
  if (!root || !await uninstallRetired(root)) return true;
  const answer = await askCliCard({ title: t('cli.uninstall.reopen.title', {}, locale), body: [t('cli.uninstall.reopen.body', {}, locale)], initial: 'continue',
    options: [{ id: 'continue', label: t('cli.uninstall.reopen.continue', {}, locale) }, { id: 'cancel', label: t('cli.uninstall.reopen.cancel', {}, locale) }] }, { locale, env });
  if (answer === 'continue') await reopenInstallation(root);
  return answer === 'continue';
}
