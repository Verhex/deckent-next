import { t, uninstallRetired, reopenInstallation, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { askCliCard } from './card.js';
/** §5.4 (owner 2026-10-27): a folder whose installation was removed keeping its data reopens only on the person's own card (Continue); false: not now.
 * m3: the host's uninstall preview (a fresh, authorized observation, never the marker's word) counts the unknown results of earlier work. */
export async function reopenRetiredFolder(config: unknown, locale: Locale, env: NodeJS.ProcessEnv, host?: unknown, options?: ConfigLoadOptions): Promise<boolean> {
  const { productLayout, projectRoot } = config as { productLayout?: { root: string }; projectRoot?: string }, root = productLayout?.root;
  if (!root || !await uninstallRetired(root)) return true;
  const preview = (host as { previewUninstall?: (root: string, query: object, options: ConfigLoadOptions) => Promise<{ readonly work: { readonly complete: boolean; readonly uncertain: readonly unknown[] } }> } | undefined)?.previewUninstall;
  // R12: an incomplete observation is "could not check", never a count of zero.
  const count = preview && projectRoot ? await preview(projectRoot, { schemaVersion: 2, tier: 'keep-data', force: false, disableUnit: false }, options ?? {})
    .then(plan => plan.work.complete ? plan.work.uncertain.length : null, () => null) : undefined;
  const open = count === undefined || count === 0 ? [] : [count === null ? t('cli.uninstall.reopen.unchecked', {}, locale) : t('cli.uninstall.reopen.uncertain', { count: String(count) }, locale)];
  const answer = await askCliCard({ title: t('cli.uninstall.reopen.title', {}, locale), body: [t('cli.uninstall.reopen.body', {}, locale), ...open], initial: 'continue',
    options: [{ id: 'continue', label: t('cli.uninstall.reopen.continue', {}, locale), role: 'yes' }, { id: 'cancel', label: t('cli.uninstall.reopen.cancel', {}, locale), role: 'no' }] }, { locale, env });
  if (answer === 'continue') await reopenInstallation(root);
  return answer === 'continue';
}
