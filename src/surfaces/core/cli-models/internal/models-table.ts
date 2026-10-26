import type { ModelCatalogChannelView, ModelCatalogInspection } from '#engine/index.js';
import { t, terminalSafeText, type Locale } from '#platform/index.js';
import { renderCliTable, type CliTableStyle } from '#surfaces/core/cli-human/index.js';

const DAY_MS = 86_400_000;
type AllowedChannel = Extract<ModelCatalogChannelView, { access: 'allowed' }>;
type CatalogModel = AllowedChannel['models'][number];
/** The day (UTC, `YYYY-MM-DD`) the lifecycle days of the catalog are compared with. */
export const catalogToday = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
/** The model's retirement day: the recorded day, else the announced one (after which admission treats it as retired). */
const retireDay = (model: CatalogModel['model']): string | null => model.lifecycle.retiredOn ?? model.lifecycle.retireNotBefore ?? null;
const retired = (model: CatalogModel['model'], today: string) => model.lifecycle.state === 'retired' || (retireDay(model) !== null && retireDay(model)! <= today);
/** Worker admission needs both rows active: the channel's in this scope and the model's (engine worker admission). */
const usable = (channel: AllowedChannel, entry: CatalogModel) => channel.activation?.state === 'active' && entry.activation?.state === 'active';

/** How a channel is reached, in words: a CLI subscription, an API, a local server (catalog channel kinds; the id itself is data). */
export function channelLabel(channel: AllowedChannel, locale: Locale): string {
  const id = terminalSafeText(channel.channelId);
  if (channel.channel.kind === 'native-cli') return t('climodels.models.channel.subscription', { cli: terminalSafeText(channel.channel.cli ?? id) }, locale);
  if (channel.channel.kind === 'local-server') return t('climodels.models.channel.local', { id }, locale);
  return t('climodels.models.channel.api', { id }, locale);
}

/** A switched-on model whose retirement day is within `days` (or already past): the line `deckent models` and doctor show (law 6 threshold). */
export type ModelRetirementWarning = Readonly<{ channelId: string; modelId: string; day: string; daysLeft: number }>;
export function modelRetirementWarnings(inspection: ModelCatalogInspection, nowMs: number, days: number): readonly ModelRetirementWarning[] {
  const today = catalogToday(nowMs);
  return inspection.channels.flatMap(channel => channel.access !== 'allowed' ? [] : channel.models.flatMap(entry => {
    const day = retireDay(entry.model);
    if (!usable(channel, entry) || day === null) return [];
    const daysLeft = daysBetween(today, day);
    return daysLeft <= days ? [{ channelId: channel.channelId, modelId: entry.modelId, day, daysLeft }] : [];
  }));
}
export function renderRetirementWarning(warning: ModelRetirementWarning, locale: Locale): string {
  const model = terminalSafeText(warning.modelId), day = warning.day;
  return warning.daysLeft > 0 ? t('climodels.models.retire.soon', { model, day, days: warning.daysLeft }, locale)
    : t('climodels.models.retire.past', { model, day }, locale);
}

/**
 * Bare `deckent models` (owner CLI review 2026-10-19): one table of the models this scope's workers may use, grouped by channel (model ·
 * channel · state · effort), retired models with their day, a channel this person may not read named as such; then the retirement warnings.
 * `verbose` adds the raw catalog facts (revisions, catalog revision, vendor, context window). Rendering only: no view or wire field is added.
 */
export function renderModelsTable(inspection: ModelCatalogInspection, input: Readonly<{ locale: Locale; nowMs: number; warnDays: number; verbose: boolean; style: CliTableStyle }>): string {
  const { locale } = input, today = catalogToday(input.nowMs);
  const state = (channel: AllowedChannel, entry: CatalogModel) => entry.activationConflict ? t('tui.model.reconcile.title', {}, locale) : retired(entry.model, today) ? t('climodels.models.state.retired', { day: retireDay(entry.model) ?? '?' }, locale)
    : usable(channel, entry) ? t('climodels.models.state.active', {}, locale)
      : entry.activation?.state === 'active' ? t('climodels.models.state.channelOff', {}, locale) : t('climodels.models.state.inactive', {}, locale);
  const rows: unknown[][] = [];
  for (const channel of inspection.channels) {
    if (channel.access !== 'allowed') { rows.push([terminalSafeText(channel.channelId), '', t('climodels.models.state.denied', {}, locale), '', ...(input.verbose ? [''] : [])]); continue; }
    for (const entry of channel.models) {
      const metadata = 'vendorId' in entry.model ? entry.model as { vendorId?: string; contextWindow?: number | null } : null;
      rows.push([terminalSafeText(entry.modelId), channelLabel(channel, locale), state(channel, entry), entry.model.efforts.join(', '),
        ...(input.verbose ? [t('climodels.models.verbose', { revision: entry.revision, activation: entry.activation?.revision ?? 0, catalog: terminalSafeText(channel.catalogRevision),
          vendor: terminalSafeText(metadata?.vendorId ?? '-'), context: metadata?.contextWindow ?? '-' }, locale)] : [])]);
    }
  }
  const columns = [{ header: t('climodels.models.table.model', {}, locale), shrink: false }, { header: t('climodels.models.table.channel', {}, locale) },
    { header: t('climodels.models.table.state', {}, locale) }, { header: t('climodels.models.table.effort', {}, locale) },
    ...(input.verbose ? [{ header: t('climodels.models.table.details', {}, locale) }] : [])];
  const warnings = modelRetirementWarnings(inspection, input.nowMs, input.warnDays).map(warning => `! ${renderRetirementWarning(warning, locale)}`);
  return [t('climodels.models.heading', { scope: terminalSafeText(inspection.scopeId) }, locale),
    rows.length ? renderCliTable(columns, rows, input.style) : t('climodels.models.empty', {}, locale),
    ...(warnings.length ? ['', ...warnings] : []), '', t('climodels.models.footer', {}, locale)].join('\n');
}
