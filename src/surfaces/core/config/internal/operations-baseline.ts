import { loadConfig, t, terminalSafeText, type ConfigLoadOptions, type Locale } from '#platform/index.js';

type Person = { readonly issuer: string; readonly subject: string };
type BaselineCell = { readonly id: string; readonly kind: string; readonly actions: readonly string[]; readonly ids: 'all' | readonly string[];
  readonly scopes: 'all' | readonly string[]; readonly before: string; readonly after: string };
/** The installer's founder-baseline result as this surface reads it (the engine's `InstallerOwnerBaselineResult`; no engine edge here). */
type BaselineView = { readonly status: string; readonly reason: string | null; readonly expect?: string; readonly principal: Person;
  readonly cells: readonly BaselineCell[]; readonly added: readonly unknown[]; readonly removed: readonly unknown[]; readonly remaining: number };
export type OwnerBaselineOpener = (root: string, scopeId: string, input: { readonly families: readonly string[]; readonly apply: boolean; readonly expect?: string }) => Promise<BaselineView>;
export type OperationsBaselineOffer = Readonly<{ scopeId: string; digest: string; title: string; lines: readonly string[]; later: string }>;

const FAMILIES = ['mcp-delegable'] as const;
/** True for a write that registers or changes business operations (the whole section or one of its keys). */
export const registersOperations = (keyPath: string) => keyPath === 'operations' || keyPath.startsWith('operations.');

/**
 * BeUser ZEY-02 (lead 2026-10-28, option A): after a person registers operations, the founder-baseline card that grants the registered
 * operations, offered right there. Read only: the same installer preview `init policy --owner-baseline mcp-delegable` shows; null when the
 * person already holds every operation cell, is not the installation's founder, or the preview is unavailable (nothing to offer).
 */
export async function operationsBaselineOffer(root: string, opener: OwnerBaselineOpener | undefined, options: ConfigLoadOptions, locale: Locale): Promise<OperationsBaselineOffer | null> {
  if (!opener) return null;
  const scopeId = ((await loadConfig(root, options))['terminal'] as { scopeId?: unknown } | undefined)?.scopeId;
  if (typeof scopeId !== 'string') return null;
  let view: BaselineView;
  try { view = await opener(root, scopeId, { families: FAMILIES, apply: false }); } catch { return null; }
  if (view.status !== 'preview' || !view.expect || !view.cells.some(cell => cell.kind === 'operation' && cell.before !== 'allow' && cell.after === 'allow')) return null;
  return { scopeId, digest: view.expect, title: t('cli.init.ownerBaseline.title', {}, locale), later: t('config.operations.baseline.later', { scope: terminalSafeText(scopeId) }, locale),
    lines: [t('config.operations.baseline.offer', {}, locale), ...baselineLines(view, scopeId, locale)] };
}
/** Applies exactly the offered plan (the digest the person saw); a changed policy comes back as a conflict, never a wider write. */
export async function applyOperationsBaseline(root: string, opener: OwnerBaselineOpener, offer: OperationsBaselineOffer, locale: Locale): Promise<readonly string[]> {
  const view = await opener(root, offer.scopeId, { families: FAMILIES, apply: true, expect: offer.digest });
  return [summary(view, offer.scopeId, locale), ...(view.status === 'applied' ? [] : [offer.later])];
}
const summary = (view: BaselineView, scopeId: string, locale: Locale) => t('cli.init.ownerBaseline.summary', { status: view.status, reason: view.reason ?? '-',
  scope: terminalSafeText(scopeId), who: terminalSafeText(`${view.principal.issuer}/${view.principal.subject}`), added: view.added.length, removed: view.removed.length, remaining: view.remaining }, locale);
function baselineLines(view: BaselineView, scopeId: string, locale: Locale): string[] {
  const list = (value: 'all' | readonly string[]) => value === 'all' ? '*' : value.map(terminalSafeText).join(', ');
  return [summary(view, scopeId, locale), ...view.cells.map(cell => `${cell.kind} / ${cell.actions.join(', ')} / ${list(cell.ids)} / ${list(cell.scopes)}: ${cell.before} → ${cell.after}`),
    t('cli.init.ownerBaseline.notice', {}, locale)];
}
