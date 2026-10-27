import { t, terminalSafeText as safe, type Locale } from '#platform/index.js';
import type { UninstallItem, UninstallPlan, UninstallResult, UninstallTier } from '#engine/index.js';
import registry from './uninstall-groups.json' with { type: 'json' };

/** Closed, translated projection vocabulary; unknown extension codes keep their machine value in JSON. */
export function uninstallMessages(locale: Locale): Readonly<Record<string, string>> {
  return {
    'blocker.backup-destination': t('cli.uninstall.blocker.backup-destination', {}, locale),
    'blocker.work-active': t('cli.uninstall.blocker.work-active', {}, locale), 'blocker.work-pending': t('cli.uninstall.blocker.work-pending', {}, locale),
    'blocker.delivery-queued': t('cli.uninstall.blocker.delivery-queued', {}, locale), 'blocker.uncertain-effects': t('cli.uninstall.blocker.uncertain-effects', {}, locale),
    'blocker.uncertain-managed': t('cli.uninstall.blocker.uncertain-managed', {}, locale), 'blocker.service-managed': t('cli.uninstall.blocker.service-managed', {}, locale),
    'blocker.work-unverified': t('cli.uninstall.blocker.work-unverified', {}, locale), 'blocker.policy': t('cli.uninstall.blocker.policy', {}, locale),
    'state.claimed': t('cli.uninstall.state.claimed', {}, locale), 'state.settled': t('cli.uninstall.state.settled', {}, locale),
    'state.unknown': t('cli.uninstall.state.unknown', {}, locale), 'state.refused': t('cli.uninstall.state.refused', {}, locale),
    'state.kept': t('cli.uninstall.state.kept', {}, locale),
    'reason.absent': t('cli.uninstall.reason.absent', {}, locale), 'reason.protected': t('cli.uninstall.reason.protected', {}, locale),
    'reason.ownership': t('cli.uninstall.reason.ownership', {}, locale), 'reason.durable': t('cli.uninstall.reason.durable', {}, locale),
    'reason.protected-session': t('cli.uninstall.reason.protected-session', {}, locale), 'reason.non-exportable': t('cli.uninstall.reason.non-exportable', {}, locale),
    'reason.observation-unknown': t('cli.uninstall.reason.observation-unknown', {}, locale), 'reason.unsupported': t('cli.uninstall.reason.unsupported', {}, locale),
    'reason.backup-coverage': t('cli.uninstall.reason.backup-coverage', {}, locale), 'reason.owned': t('cli.uninstall.reason.owned', {}, locale),
    'reason.unsafe-path': t('cli.uninstall.reason.unsafe-path', {}, locale), 'reason.service-unresolved': t('cli.uninstall.reason.service-unresolved', {}, locale),
    'reason.retained-overlap': t('cli.uninstall.reason.retained-overlap', {}, locale), 'reason.dependency-unresolved': t('cli.uninstall.reason.dependency-unresolved', {}, locale),
    'reason.resume': t('cli.uninstall.reason.resume', {}, locale), 'reason.vcs-tracked': t('cli.uninstall.reason.vcs-tracked', {}, locale),
    'reason.not-backed-up': t('cli.uninstall.reason.not-backed-up', {}, locale), 'reason.vcs-unverified': t('cli.uninstall.reason.vcs-unverified', {}, locale),
    'group.authority': t('cli.uninstall.group.authority', {}, locale),
    'group.cache': t('cli.uninstall.group.cache', {}, locale), 'group.work': t('cli.uninstall.group.work', {}, locale),
    'group.settings': t('cli.uninstall.group.settings', {}, locale), 'group.identity': t('cli.uninstall.group.identity', {}, locale),
    'group.history': t('cli.uninstall.group.history', {}, locale), 'group.backups': t('cli.uninstall.group.backups', {}, locale),
    'group.workspaces': t('cli.uninstall.group.workspaces', {}, locale), 'group.service': t('cli.uninstall.group.service', {}, locale),
    'group.shared': t('cli.uninstall.group.shared', {}, locale), 'group.images': t('cli.uninstall.group.images', {}, locale),
    'tier.keep-data': t('cli.uninstall.tier.keep-data', {}, locale), 'tier.keep-work': t('cli.uninstall.tier.keep-work', {}, locale),
    'tier.all': t('cli.uninstall.tier.all', {}, locale),
  };
}
export function uninstallStatusMessage(status: UninstallResult['status'], locale: Locale): string {
  return { completed: t('cli.uninstall.status.completed', {}, locale), noop: t('cli.uninstall.status.noop', {}, locale),
    cancelled: t('cli.uninstall.status.cancelled', {}, locale), partial: t('cli.uninstall.status.partial', {}, locale),
    unknown: t('cli.uninstall.status.unknown', {}, locale) }[status];
}
/** A resource's card group from the registry; null for a file the card names by its path (unlisted, VCS-tracked, other owners' entries). */
export function uninstallGroup(item: Pick<UninstallItem, 'resourceId'>): string | null {
  const exact = Object.entries(registry.groups).find(([, ids]) => ids.includes(item.resourceId))?.[0];
  return exact ?? Object.entries(registry.prefixes).find(([prefix]) => item.resourceId.startsWith(prefix))?.[1] ?? null;
}
/** One readable line per tier blocker: an authority path keeps its path; a resource blocker its reason. */
export function uninstallBlockerText(blocker: string, locale: Locale): string {
  const messages = uninstallMessages(locale), path = /^authority-(relocated|unsafe):(.+)$/su.exec(blocker), where = { path: safe(path?.[2] ?? '') };
  if (path) return path[1] === 'relocated' ? t('cli.uninstall.blocker.authority-relocated', where, locale) : t('cli.uninstall.blocker.authority-unsafe', where, locale);
  const key = blocker.startsWith('policy:') ? 'blocker.policy' : `blocker.${blocker}`, reason = blocker.slice(blocker.lastIndexOf(':') + 1);
  return messages[key] ?? messages[`reason.${reason}`] ?? `${t('cli.uninstall.unknown', {}, locale)} (${safe(blocker)})`;
}
const names = (items: readonly UninstallItem[], locale: Locale) => { const messages = uninstallMessages(locale), shown: string[] = [], files: string[] = [];
  for (const item of items) { const group = uninstallGroup(item); if (group) { const label = messages[`group.${group}`]!; if (!shown.includes(label)) shown.push(label); } else files.push(safe(item.locator)); }
  const listed = files.slice(0, registry.listedLimit);
  return [...shown, ...listed, ...(files.length > listed.length ? [t('cli.uninstall.more', { count: String(files.length - listed.length) }, locale)] : [])].join(' · '); };
const workLine = (plan: UninstallPlan, locale: Locale) => { const work = plan.work, total = work.running.length + work.parked.length + work.approvals.length + work.deliveries.length + work.uncertain.length;
  return total ? t('cli.uninstall.work.some', { running: String(work.running.length), parked: String(work.parked.length), approvals: String(work.approvals.length),
    deliveries: String(work.deliveries.length), uncertain: String(work.uncertain.length) }, locale) : t('cli.uninstall.work.none', {}, locale); };

/** The menu card (owner 2026-10-27): what runs, what is pending, what this folder and the shared places hold; absent entries are not named. */
export function uninstallSummaryLines(plan: UninstallPlan, locale: Locale): readonly string[] {
  const present = plan.items.filter(item => item.present !== false), shared = (item: UninstallItem) => registry.sharedGroups.includes(uninstallGroup(item) ?? '');
  const here = present.filter(item => !shared(item) && uninstallGroup(item)), elsewhere = present.filter(shared);
  return [...(!plan.service.running ? [] : [plan.service.unit ? t('cli.uninstall.service.unit', { unit: safe(plan.service.unit) }, locale) : t('cli.uninstall.service.plain', {}, locale)]),
    workLine(plan, locale), ...(here.length ? [t('cli.uninstall.here', { groups: names(here, locale) }, locale)] : []),
    ...(elsewhere.length ? [t('cli.uninstall.shared', { groups: names(elsewhere, locale) }, locale)] : [])];
}
/** The plan card: first what WILL change (removed, stopped, disabled, cancelled), then what stays and why, absent entries collapsed, then the
 * person's own steps, the backup, restore and remote notes. The same lines precede `--yes` and open `--dry-run`. */
export function uninstallPlanLines(plan: UninstallPlan, locale: Locale): readonly string[] {
  const messages = uninstallMessages(locale), removed = plan.items.filter(item => item.action === 'remove');
  const kept = plan.items.filter(item => item.action !== 'remove' && item.present !== false), absent = plan.items.filter(item => item.present === false && item.action !== 'remove');
  const manual = [...new Set([...kept.flatMap(item => item.manualCommand ? [item.manualCommand] : []),
    ...(plan.service.running && plan.service.command && !plan.steps.disableUnit ? [plan.service.command] : []), ...(plan.packageRemoval.command ? [plan.packageRemoval.command] : [])])];
  return [
    ...(removed.length ? [plan.purge ? t('cli.uninstall.removeBackup', { groups: names(removed, locale) }, locale) : t('cli.uninstall.remove', { groups: names(removed, locale) }, locale)] : []),
    ...(plan.steps.stopService ? [t('cli.uninstall.stop', {}, locale)] : []),
    ...(plan.steps.disableUnit && plan.service.unit ? [t('cli.uninstall.unit', { unit: safe(plan.service.unit) }, locale)] : []),
    ...(plan.steps.cancelRuns.length || plan.steps.rejectApprovals.length ? [t('cli.uninstall.force', { runs: String(plan.steps.cancelRuns.length), approvals: String(plan.steps.rejectApprovals.length) }, locale)] : []),
    ...[...new Set(kept.map(item => item.reason))].map(reason => t('cli.uninstall.kept', { groups: names(kept.filter(item => item.reason === reason), locale), reason: messages[`reason.${reason}`] ?? safe(reason) }, locale)),
    ...(absent.length ? [t('cli.uninstall.absent', { count: String(absent.length) }, locale)] : []),
    ...plan.blockers.map(blocker => t('cli.uninstall.blocked', { reason: uninstallBlockerText(blocker, locale) }, locale)),
    ...(manual.length ? [t('cli.uninstall.forYou', {}, locale), ...manual.map(command => `  ${safe(command)}`)] : []),
    ...(plan.packageRemoval.command ? [] : [t('cli.uninstall.packageUnknown', {}, locale)]),
    ...(plan.purge ? [t('cli.uninstall.backup', { path: safe(plan.backup.destination ?? '') }, locale), t('cli.uninstall.restore', {}, locale), t('cli.uninstall.remote', {}, locale)] : []),
    ...(plan.purge && plan.force && plan.work.uncertain.length ? [t('cli.uninstall.uncertain', { list: plan.work.uncertain.map(item => safe(`${item.kind} ${item.id}`)).join(', ') }, locale)] : []),
  ];
}
/** `--dry-run`: the plan card, then every present item with its path and reason (`verbose`: absent ones too), the installation and the digest. */
export function uninstallDetailLines(plan: UninstallPlan, locale: Locale, verbose = false): readonly string[] {
  const messages = uninstallMessages(locale), unknown = t('cli.uninstall.unknown', {}, locale);
  const label = (item: UninstallItem) => item.action === 'remove' ? t('cli.uninstall.item.remove', {}, locale) : item.action === 'keep' ? t('cli.uninstall.item.keep', {}, locale)
    : item.action === 'manual' ? t('cli.uninstall.item.manual', {}, locale) : unknown;
  return [...uninstallPlanLines(plan, locale), t('cli.uninstall.installation', { path: safe(plan.installation.root), scopes: plan.scopeSummary.map(safe).join(', ') }, locale),
    ...plan.items.filter(item => verbose || item.present !== false).flatMap(item => (item.members ?? [item.locator]).map(locator => `${label(item)}: ${safe(locator)} · ${messages[`reason.${item.reason}`] ?? unknown}`)),
    t('cli.uninstall.digest', { digest: plan.planDigest }, locale)];
}
/** A blocker the person can resolve on the next card (running or pending work, unknown results, an eligible unit), offered with its flag twin. */
export const uninstallResolvable = (blocker: string | null | undefined, plan: UninstallPlan) => !!blocker
  && (['work-active', 'work-pending', 'uncertain-effects'].includes(blocker) || blocker === 'service-managed' && plan.service.unitDisable === 'eligible');
/** The menu's tiers: keep-data always (recommended), keep-work only with pending work it treats differently from keep-data, all always; a tier
 * the same observation refuses for good carries its reason, shown under the card (a resolvable refusal stays selectable). */
export function uninstallTierChoices(plan: UninstallPlan, locale: Locale): readonly { readonly tier: UninstallTier; readonly label: string; readonly blocked: string | null }[] {
  const messages = uninstallMessages(locale), pending = plan.work.parked.length + plan.work.approvals.length + plan.work.deliveries.length + plan.work.uncertain.length > 0;
  return (['keep-data', 'keep-work', 'all'] as const).filter(tier => tier !== 'keep-work' || pending && plan.tiers['keep-work'].removes !== plan.tiers['keep-data'].removes)
    .map(tier => { const blocker = plan.tiers[tier].blocker;
      return { tier, label: messages[`tier.${tier}`]!, blocked: blocker && !uninstallResolvable(blocker, plan) ? uninstallBlockerText(blocker, locale) : null }; });
}
