import { t, type Locale } from '#platform/index.js';
import type { MonitorInstall, MonitorMap } from '#engine/index.js';
import { span, type MonitorBlock, type MonitorLine } from './layout.js';

/**
 * Harita (MONITOR v1.1): "what feeds what" per observed install, in sentences — config layers and the sections each sets, the execution
 * registry (task kind → profile), the model catalog, the policy summary and memory. No values and no raw JSON: secrets never reach it.
 */
export function mapBlocks(installs: readonly MonitorInstall[], locale: Locale, marks: { readonly active: string; readonly off: string; readonly sep: string }): MonitorBlock[] {
  const line = (text: string, role?: 'accent' | 'muted' | 'strong' | 'success' | 'warning'): MonitorBlock => ({ kind: 'line', line: [span(text, role)] });
  const layer = (name: MonitorMap['config'][number]['layer']) => ({ default: t('monitor.map.layer.default', {}, locale), global: t('monitor.map.layer.global', {}, locale),
    project: t('monitor.map.layer.project', {}, locale), environment: t('monitor.map.layer.environment', {}, locale) })[name];
  const none = t('monitor.map.none', {}, locale);
  return installs.flatMap((install, index): MonitorBlock[] => {
    const head: MonitorBlock[] = [...(index ? [line('')] : []), line(`${install.id}${` ${marks.sep} `}${install.path}`, 'strong')];
    const map = install.map;
    if (!map) return [...head, line(`  ${t('monitor.map.unread', {}, locale)}`, 'muted')];
    // A kind names its profile as `id@version` or as a bare id; both resolve.
    const profileOf = (name: string) => map.registry.profiles.find(profile => `${profile.id}@${profile.version}` === name || profile.id === name);
    const policy = map.policy;
    return [...head,
      line(t('monitor.map.config', {}, locale), 'accent'),
      ...map.config.map((entry, at) => line(`  ${t('monitor.map.configLayer', { n: at + 1, layer: layer(entry.layer), path: entry.path ?? (entry.layer === 'default' ? t('monitor.map.builtIn', {}, locale) : '—'),
        sections: entry.sections.join(', ') || none }, locale)}`)),
      line(t('monitor.map.registry', { profiles: map.registry.profiles.length, kinds: map.registry.kinds.length }, locale), 'accent'),
      ...map.registry.kinds.map(entry => line(`  ${t('monitor.map.kind', { kind: entry.kind, profile: entry.profile, adapter: profileOf(entry.profile)?.adapter ?? '—' }, locale)}`)),
      ...map.registry.profiles.filter(profile => !map.registry.kinds.some(entry => profileOf(entry.profile) === profile))
        .map(profile => line(`  ${t('monitor.map.unusedProfile', { profile: `${profile.id}@${profile.version}`, adapter: profile.adapter }, locale)}`, 'muted')),
      line(t('monitor.map.models', { count: map.models.length, active: map.models.filter(model => model.active).length }, locale), 'accent'),
      ...map.models.map(model => ({ kind: 'line' as const, line: [span(`  ${model.active ? marks.active : marks.off} `, model.active ? 'success' : 'muted'),
        span(`${model.channelId} / ${model.modelId}`), span(model.active ? '' : ` (${t('monitor.map.inactive', {}, locale)})`, 'muted')] satisfies MonitorLine })),
      ...(map.models.length ? [] : [line(`  ${none}`, 'muted')]),
      line(policy ? t('monitor.map.policy', { grants: policy.grants, kinds: Object.entries(policy.byResourceKind).map(([kind, count]) => `${kind} ${count}`).join(', ') || none,
        sod: policy.separationOfDuties }, locale) : t('monitor.map.policyNone', {}, locale), 'accent'),
      ...(policy?.permissionModes.length ? [line(`  ${t('monitor.map.modes', { modes: policy.permissionModes.map(entry => `${entry.principal}: ${entry.mode}`).join(', ') }, locale)}`)] : []),
      line(map.memory.available ? t('monitor.map.memory', {}, locale) : t('monitor.map.memoryNone', {}, locale), map.memory.available ? 'accent' : 'muted'),
    ];
  });
}
