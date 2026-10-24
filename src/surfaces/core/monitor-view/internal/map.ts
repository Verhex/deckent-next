import { t, type Locale } from '#platform/index.js';
import type { MonitorInstall, MonitorMap } from '#engine/index.js';
import { modelInvocabilityText } from '#surfaces/core/model-invocability/index.js';
import { recoveryStateLines } from '#surfaces/core/recovery-text/index.js';
import { span, type MonitorBlock, type MonitorColumn, type MonitorRole, type MonitorRow, type MonitorSpan } from './layout.js';

/** The text markers of one view: ✓ ready, ○ off/unused, ! needs attention, → next action (ASCII `+ o ! ->`). */
export interface MonitorMarkers { readonly ok: string; readonly off: string; readonly warn: string; readonly next: string; readonly sep: string }
type Group = 'execution' | 'models' | 'tools' | 'admin' | 'other';
/** Policy resource kinds → the four permission groups a person reads (PB-MON-UX); a kind added later lands in "other", never hidden. */
const RESOURCE_GROUPS: Readonly<Record<string, Group>> = {
  run: 'execution', task: 'execution', attempt: 'execution', 'task-decision': 'execution', 'run-decision': 'execution', decision: 'execution', pool: 'execution',
  operation: 'execution', 'work-target': 'execution', scope: 'execution',
  'model-activation': 'models', 'model-invocation': 'models', 'provider-spend-account': 'models',
  'agent-tool': 'tools', 'agent-tool-call': 'tools', 'mcp-server': 'tools', command: 'tools',
  approval: 'admin', config: 'admin', backup: 'admin', secret: 'admin', service: 'admin', 'permission-mode': 'admin',
};
const GROUP_ORDER: readonly Group[] = ['execution', 'models', 'tools', 'admin', 'other'];

const col = (header: string, priority: number, min: number, max: number, cut?: 'start'): MonitorColumn => ({ header, priority, min, max, ...(cut ? { cut } : {}) });
/** A plain map row: its detail repeats the cells whole, so Enter on a cut cell still shows the full text. */
const row = (key: string, cells: readonly MonitorSpan[]): MonitorRow => ({ key, cells, detail: () => cells.map(cell => [span(cell.text, cell.role)]) });

function recoveryLines(state: NonNullable<MonitorMap['recovery']>, locale: Locale, marks: MonitorMarkers): readonly (readonly [string, MonitorRole])[] {
  const [head, effect] = recoveryStateLines(state, locale), attention = state.recovery === 'live' && state.continuation !== 'automatic';
  return [[`${state.recovery === 'off' ? marks.off : attention ? marks.warn : marks.ok} ${head}`, state.recovery === 'off' ? 'muted' : 'sectionHeader'],
    [`  ${effect}`, attention ? 'warning' : 'muted']];
}
/**
 * Harita (MONITOR v1.1, tables since PB-MON-UX): "what feeds what" per observed install — config layers and the sections each sets, task
 * kind → profile → runner (unused old profile versions collapsed into a count), models with what to do next, permissions in four groups
 * plus the permission modes, and memory. No values and no raw JSON: secrets never reach it.
 */
export function mapBlocks(installs: readonly MonitorInstall[], locale: Locale, marks: MonitorMarkers): MonitorBlock[] {
  const line = (text: string, role?: MonitorRole): MonitorBlock => ({ kind: 'line', line: [span(text, role)] });
  const heading = (text: string): MonitorBlock => line(text, 'sectionHeader');
  const layer = (name: MonitorMap['config'][number]['layer']) => ({ default: t('monitor.map.layer.default', {}, locale), global: t('monitor.map.layer.global', {}, locale),
    project: t('monitor.map.layer.project', {}, locale), environment: t('monitor.map.layer.environment', {}, locale) })[name];
  const groupName = (group: Group) => ({ execution: t('monitor.map.group.execution', {}, locale), models: t('monitor.map.group.models', {}, locale),
    tools: t('monitor.map.group.tools', {}, locale), admin: t('monitor.map.group.admin', {}, locale), other: t('monitor.map.group.other', {}, locale) })[group];
  const none = t('monitor.map.none', {}, locale);
  return installs.flatMap((install, index): MonitorBlock[] => {
    const head: MonitorBlock[] = [...(index ? [line('')] : []), line(`${install.id}${` ${marks.sep} `}${install.path}`, 'strong')];
    const map = install.map;
    if (!map) return [...head, line(`  ${t('monitor.map.unread', {}, locale)}`, 'muted')];
    // A kind names its profile as `id@version` or as a bare id; both resolve.
    const profileOf = (name: string) => map.registry.profiles.find(profile => `${profile.id}@${profile.version}` === name || profile.id === name);
    const used = new Set(map.registry.kinds.map(entry => profileOf(entry.profile)).filter(profile => profile !== undefined));
    const usedIds = new Set([...used].map(profile => profile.id));
    const unused = map.registry.profiles.filter(profile => !used.has(profile));
    // An unused version of a profile some kind still uses is an old version (kept for rollback): counted, not listed.
    const old = unused.filter(profile => usedIds.has(profile.id)), idle = unused.filter(profile => !usedIds.has(profile.id));
    const layers: MonitorBlock = { kind: 'table', empty: none, columns: [col('#', 0, 1, 2), col(t('monitor.map.col.layer', {}, locale), 1, 10, 40),
      col(t('monitor.map.col.file', {}, locale), 3, 12, 70, 'start'), col(t('monitor.map.col.sections', {}, locale), 2, 12, 60)],
    rows: map.config.map((entry, at) => row(`map:${install.id}:layer:${at}`, [span(String(at + 1), 'muted'),
      // The global layer of an observed install is resolved from the observer's own environment: say whose it is (Fable #3).
      span(entry.layer === 'global' && install.id !== 'current' ? t('monitor.map.layer.globalObserver', {}, locale) : layer(entry.layer)),
      span(entry.path ?? (entry.layer === 'default' ? t('monitor.map.builtIn', {}, locale) : t('monitor.map.noFile', {}, locale)), entry.path ? undefined : 'muted'),
      span(entry.sections.join(', ') || none, entry.sections.length ? undefined : 'muted')])) };
    const kinds: MonitorBlock = { kind: 'table', empty: none, columns: [col(t('monitor.map.col.kind', {}, locale), 0, 10, 32),
      col(t('monitor.map.col.profile', {}, locale), 1, 12, 40), col(t('monitor.map.col.runner', {}, locale), 2, 8, 24)],
    rows: map.registry.kinds.map(entry => row(`map:${install.id}:kind:${entry.kind}`, [span(entry.kind), span(entry.profile), span(profileOf(entry.profile)?.adapter ?? '—', 'muted')])) };
    const state = (model: MonitorMap['models'][number]): MonitorSpan => model.availability?.invocable ? span(`${marks.ok} ${t('monitor.map.model.ready', {}, locale)}`, 'success')
      : !model.availability && model.billing === 'subscription' ? span(`${marks.off} ${t('monitor.map.model.subscription', {}, locale)}`, 'muted')
        : span(`${marks.warn} ${t('monitor.map.model.blocked', {}, locale)}`, 'warning');
    // A subscription channel offers no readiness check: say so plainly instead of a generic unverifiable state (lead 2026-10-10, E2 4).
    const reason = (model: MonitorMap['models'][number]) => !model.availability && model.billing === 'subscription' ? t('model.invocable.subscription', {}, locale)
      : modelInvocabilityText(model.availability ?? { invocable: false, reason: { kind: 'unavailable', code: 'MODEL_INVOCATION_UNAVAILABLE' } }, locale);
    const models: MonitorBlock = { kind: 'table', empty: none, columns: [col(t('monitor.col.state', {}, locale), 0, 6, 26), col(t('monitor.map.col.model', {}, locale), 1, 12, 44),
      col(t('monitor.map.col.channel', {}, locale), 2, 8, 28), col(t('monitor.col.scope', {}, locale), 4, 6, 20), col(t('monitor.map.col.billing', {}, locale), 3, 8, 24)],
    rows: map.models.map((model, at) => ({ ...row(`map:${install.id}:model:${at}`, [state(model), span(`${model.modelId}${model.reference ? `@${model.reference.modelVersion}` : ''}`),
      span(`${model.channelId}${model.reference ? `@${model.reference.providerVersion}` : ''}`, 'muted'), span(model.scopeId ?? '—', 'muted'),
      span([model.vendorId, model.billing].filter(Boolean).join(` ${marks.sep} `) || '—', 'muted')]), detail: () => [[state(model), span(` ${model.modelId}`)], [span(reason(model))]] })) };
    // One line per distinct decision, in the same words every model surface uses (✓ ready, → what to do); a sentence shared by several
    // models is not repeated for each of them.
    const reasons = new Map<string, { count: number; ready: boolean }>();
    for (const model of map.models) { const text = reason(model), seen = reasons.get(text);
      reasons.set(text, { count: (seen?.count ?? 0) + 1, ready: model.availability?.invocable === true }); }
    const policy = map.policy, groups = new Map<Group, Map<string, number>>();
    for (const [kind, count] of Object.entries(policy?.byResourceKind ?? {})) {
      const group = RESOURCE_GROUPS[kind] ?? 'other', kinds = groups.get(group) ?? new Map<string, number>();
      kinds.set(kind, count); groups.set(group, kinds);
    }
    const permissions: MonitorBlock = { kind: 'table', empty: none, columns: [col(t('monitor.map.col.group', {}, locale), 0, 10, 20),
      col(t('monitor.map.col.rules', {}, locale), 1, 5, 8), col(t('monitor.map.col.kinds', {}, locale), 2, 12, 80)],
    rows: GROUP_ORDER.filter(group => groups.has(group)).map(group => { const kinds = [...groups.get(group)!];
      return row(`map:${install.id}:policy:${group}`, [span(groupName(group)), span(String(kinds.reduce((sum, [, count]) => sum + count, 0))),
        span(kinds.map(([kind, count]) => `${kind} ${count}`).join(', '), 'muted')]); }) };
    return [...head,
      heading(t('monitor.map.config', {}, locale)), layers,
      heading(t('monitor.map.registry', { profiles: map.registry.profiles.length, kinds: map.registry.kinds.length }, locale)), kinds,
      ...(old.length ? [line(`  ${marks.off} ${t('monitor.map.oldVersions', { count: old.length }, locale)}`, 'muted')] : []),
      ...idle.map(profile => line(`  ${marks.off} ${t('monitor.map.unusedProfile', { profile: `${profile.id}@${profile.version}`, adapter: profile.adapter }, locale)}`, 'muted')),
      heading(t('monitor.map.models', { count: map.models.length, active: map.models.filter(model => model.availability?.invocable).length }, locale)), models,
      ...[...reasons].map(([text, { count, ready }]) => line(`  ${ready ? marks.ok : marks.next} ${t('monitor.map.reason', { count, reason: text }, locale)}`, ready ? 'success' : 'info')),
      heading(policy ? t('monitor.map.policy', { grants: policy.grants, sod: policy.separationOfDuties }, locale) : t('monitor.map.policyNone', {}, locale)),
      ...(policy ? [permissions] : []),
      ...(policy?.permissionModes.length ? [line(`  ${t('monitor.map.modes', { modes: policy.permissionModes.map(entry => `${entry.principal}: ${entry.mode}`).join(', ') }, locale)}`)] : []),
      line(map.memory.available ? `${marks.ok} ${t('monitor.map.memory', {}, locale)}` : `${marks.off} ${t('monitor.map.memoryNone', {}, locale)}`, map.memory.available ? 'sectionHeader' : 'muted'),
      // S6R-6: lost-worker recovery — both protected modes, the owner's standing grant, and what that means (live without the grant: a person decides).
      ...(map.recovery ? recoveryLines(map.recovery, locale, marks).map(([text, role]) => line(text, role)) : []),
    ];
  });
}
