import { relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ErrorRegistry, loadConfig, t, type ConfigLoadOptions, type ConfigStepper, type Locale, PRODUCT_LAYOUT_REGISTRY, resolveProductLayout } from '#platform/index.js';
import { PROVIDER_SPEND_SCOPE_BUDGET_ID } from '#domain/index.js';
import { SCOPE_BUDGET_CHOICES } from '#surfaces/core/cli-models/index.js';
import { terminalConfigWrite, type ConfigCommandContext } from './command.js';
import type { ConfigChoiceSourcePort, ConfigValueChoice } from './choices.js';

export const CONFIG_RECORD_KEYS = ['provider_spending.budgets', 'inspection.workers.sources', 'execution.adoption.targets', 'execution.workTargets.targets', 'layout.resources'] as const;
export const CONFIG_IMPORT_KEYS = ['provider_catalog.providers', 'provider_invocation_profiles.profiles', 'operations.catalog', 'operations.targets'] as const;
type Layer = 'project' | 'global';
export type ConfigRecordField = Readonly<{ id: string; label: string; choices: readonly ConfigValueChoice[]; stepper?: ConfigStepper; fileSystem?: 'directory' | 'any' }>;
export type ConfigRecordView = Readonly<{ key: string; layer: Layer; digest: string | null; note?: string | null; members: readonly Readonly<{ id: string; label: string; detail: string }>[] }>;
export type ConfigRecordDraft = Readonly<{ fields: readonly ConfigRecordField[]; values: Readonly<Record<string, unknown>> }>;
export type ConfigRecordPreview = Readonly<{ token: string; before: string; after: string }>;
export type ConfigFileChoice = Readonly<{ path: string; label: string; kind: 'file' | 'directory' }>;
/** Selection/preview is inert; only commit goes to the common config submit path. No JSON/text parser is exposed. */
export interface ConfigRecordPort {
  open(key: string, layer: Layer): Promise<ConfigRecordView>;
  draft(member: string | null, values?: Readonly<Record<string, unknown>>): Promise<ConfigRecordDraft>;
  preview(member: string | null, values: Readonly<Record<string, unknown>> | null): Promise<ConfigRecordPreview>;
  browse(directory?: string): Promise<readonly ConfigFileChoice[]>;
  importFile(path: string): Promise<ConfigRecordPreview>;
  commit(token: string): ReturnType<typeof terminalConfigWrite>;
}
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function configRecordSupported(key: string) { return (CONFIG_RECORD_KEYS as readonly string[]).includes(key) || (CONFIG_IMPORT_KEYS as readonly string[]).includes(key); }
export function configRecordPort(root: string, context: ConfigCommandContext, options: ConfigLoadOptions, locale: Locale, discovery?: ConfigChoiceSourcePort): ConfigRecordPort {
  let session: { view: ConfigRecordView; value: unknown[]; writeKey: string; container: Record<string, unknown> | null; layoutRoot: string } | null = null;
  let prepared: { token: string; action: 'set' | 'unset'; writeKey: string; value: unknown; expect: string | null } | null = null;
  const paths = new Set<string>();
  let offered: ConfigRecordDraft | null = null;
  let sourcePort = discovery;
  const sources = () => sourcePort;
  const app = () => context.configApplication!(root, options);
  const refused = () => ErrorRegistry.createError('CONFIG_RECORD_INVALID');
  const active = () => { if (!session) throw refused(); return session; };
  const indexOf = (member: string) => { const index = active().view.members.findIndex(row => row.id === member); if (index < 0) throw refused(); return index; };
  const choices = async (source: Parameters<ConfigChoiceSourcePort['list']>[0], key: string) => await sources()?.list(source, key) ?? [];
  const fieldLabels = { scopeId: t('config.records.field.scopeId', {}, locale), usd: t('config.records.field.usd', {}, locale), kind: t('config.records.field.kind', {}, locale), path: t('config.records.field.path', {}, locale), branch: t('config.records.field.branch', {}, locale), resource: t('config.records.field.resource', {}, locale) };
  const field = (id: keyof typeof fieldLabels, entries: readonly ConfigValueChoice[], stepper?: ConfigStepper): ConfigRecordField => ({ id, label: fieldLabels[id], choices: entries, ...(stepper ? { stepper } : {}) });
  const previewValue = async (value: unknown, requestedKey?: string, action: 'set' | 'unset' = 'set'): Promise<ConfigRecordPreview> => {
    prepared = null;
    const { view, writeKey } = active(), config = await loadConfig(root, options), scopeId = (config['terminal'] as { scopeId?: string } | undefined)?.scopeId;
    if (!context.resolveConfigPrincipal || !scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
    const principal = await context.resolveConfigPrincipal(root, scopeId, options);
    const targetKey = requestedKey ?? writeKey;
    const actualValue = targetKey === 'provider_spending' ? { schemaVersion: 1, budgets: value } : value;
    const command = { keyPath: targetKey, value: actualValue, layer: view.layer, expect: view.digest, principal, scopeId, commandId: randomUUID() };
    const result = await app().preview(action, command);
    const token = randomUUID(); prepared = { token, action, writeKey: targetKey, value: structuredClone(actualValue), expect: result.digest };
    return { token, before: result.before, after: result.after };
  };
  return {
    async open(key, layer) {
      if (!configRecordSupported(key) || !context.configApplication) throw refused();
      prepared = null; offered = null; paths.clear(); sourcePort = discovery ?? context.configChoiceSources?.(root, options);
      const read = await app().inspectValue({ keyPath: key, layer });
      const value = read.value ?? (layer === 'project' ? read.effective : undefined) ?? [];
      const spendingRead = key === 'provider_spending.budgets' ? await app().inspectValue({ keyPath: 'provider_spending', layer }) : null;
      const config = await loadConfig(root, options);
      const containerRead = key === 'execution.workTargets.targets' ? await app().inspectValue({ keyPath: 'execution.workTargets', layer }) : null;
      const parent = containerRead?.value ?? (layer === 'project' ? containerRead?.effective : undefined);
      const container = isRecord(parent) ? parent : null;
      const entries = key === 'layout.resources' && isRecord(value) ? Object.entries(value).map(([resource, path]) => ({ resource, path })) : Array.isArray(value) ? value : [];
      const members = entries.map((entry, i) => {
        const record = isRecord(entry) ? entry : {};
        return { id: String(i), label: typeof entry === 'string' ? entry.replace(/^refs\/heads\//u, '') : String(record['resource'] ?? record['scopeId'] ?? record['id'] ?? i + 1),
          detail: key === 'provider_spending.budgets' ? `${Number(record['limitMinorUnits']) / SCOPE_BUDGET_CHOICES.minorUnitsPerUsd} ${String(record['currency'])}` : String(record['path'] ?? '') };
      });
      const view = { key, layer, digest: read.digest, members, note: key === 'provider_spending.budgets' ? t('config.records.budgetNote', {}, locale) : key === 'execution.workTargets.targets' ? t('config.records.targetNote', {}, locale) : null };
      session = { view, value: structuredClone(entries), writeKey: key === 'provider_spending.budgets' && spendingRead?.value === undefined ? 'provider_spending' : key, container, layoutRoot: config.productLayout.root }; return view;
    },
    async draft(member, selected) {
      prepared = null;
      const { view, value } = active();
      const entry = member === null ? undefined : value[indexOf(member)], record = isRecord(entry) ? entry : {};
      let fields: ConfigRecordField[], values: Record<string, unknown>;
      if (view.key === 'provider_spending.budgets') {
        if (member !== null && record['currency'] !== 'USD') throw refused();
        const usd = typeof record['limitMinorUnits'] === 'number' ? record['limitMinorUnits'] / SCOPE_BUDGET_CHOICES.minorUnitsPerUsd : SCOPE_BUDGET_CHOICES.presetsUsd[0]!;
        const stepper: ConfigStepper = { min: SCOPE_BUDGET_CHOICES.minUsd, max: SCOPE_BUDGET_CHOICES.maxUsd, step: SCOPE_BUDGET_CHOICES.stepUsd, unit: 'count', current: usd };
        fields = [field('scopeId', await choices('scopes', view.key)), field('usd', SCOPE_BUDGET_CHOICES.presetsUsd.map(amount => ({ id: String(amount), label: `${amount} USD`, value: amount })), stepper)];
        values = { scopeId: record['scopeId'], usd };
      } else if (view.key === 'inspection.workers.sources') {
        fields = [field('kind', ['next-project', 'legacy-tasks'].map(kind => ({ id: kind, label: kind === 'next-project' ? t('config.records.kind.next-project', {}, locale) : t('config.records.kind.legacy-tasks', {}, locale), value: kind }))),
          field('path', await choices('paths', view.key)), field('scopeId', await choices('scopes', view.key))];
        values = { kind: record['kind'], path: record['path'], scopeId: record['scopeId'] };
      } else if (view.key === 'execution.adoption.targets') {
        fields = [field('branch', await choices('branches', view.key))]; values = { branch: entry };
      } else if (view.key === 'execution.workTargets.targets') {
        if (member === null && value.length) throw refused();
        const path = selected?.['path'] ?? record['path'] ?? root;
        const branches = await sources()?.list('branches', 'execution.workTargets.targets.0.baseRef', { path: String(path) }) ?? [];
        fields = [field('path', await choices('paths', view.key)), field('branch', branches)];
        values = { path, branch: record['baseRef'] };
      } else if (view.key === 'layout.resources') {
        const resources = Object.entries(PRODUCT_LAYOUT_REGISTRY.resources).filter(([resource]) => !PRODUCT_LAYOUT_REGISTRY.fixedResources.includes(resource));
        fields = [field('resource', resources.map(([resource, path]) => ({ id: resource, label: resource, value: resource, detail: path }))),
          { ...field('path', resources.filter(([resource]) => resource === (selected?.['resource'] ?? record['resource'])).map(([resource, path]) => ({ id: resource, label: path, value: path }))), fileSystem: 'any' }];
        values = { resource: record['resource'], path: record['path'] };
      } else throw refused();
      if (selected) values = { ...values, ...selected };
      if (view.key === 'execution.workTargets.targets' && !fields[1]!.choices.some(choice => choice.value === values['branch'])) delete values['branch'];
      offered = { fields, values }; return offered;
    },
    async preview(member, values) {
      prepared = null;
      const { view, value } = active(), index = member === null ? value.length : indexOf(member), next = [...value];
      if (values === null) { if (member === null) throw refused(); next.splice(index, 1);
        if (view.key === 'execution.workTargets.targets') return previewValue(undefined, 'execution.workTargets', 'unset');
        if (view.key === 'layout.resources') return previewValue(Object.fromEntries(next.map(entry => [(entry as Record<string, unknown>)['resource'], (entry as Record<string, unknown>)['path']])));
        return previewValue(next); }
      if (!offered || Object.keys(values).some(key => !offered!.fields.some(field => field.id === key))) throw refused();
      for (const item of offered.fields) {
        const chosen = values[item.id];
        if (item.stepper) { const s = item.stepper; if (typeof chosen !== 'number' || !Number.isSafeInteger(chosen) || chosen < s.min || chosen > s.max || (chosen - s.min) % s.step !== 0) throw refused(); }
        else if (!(item.id === 'path' && typeof chosen === 'string' && paths.has(chosen)) && !item.choices.some(choice => JSON.stringify(choice.value) === JSON.stringify(chosen))) throw refused();
      }
      const previous = isRecord(value[index]) ? value[index] as Record<string, unknown> : {};
      if (view.key === 'provider_spending.budgets') {
        if (next.some((entry, i) => i !== index && isRecord(entry) && entry['scopeId'] === values['scopeId'])) throw refused();
        next[index] = { schemaVersion: 1, scopeId: values['scopeId'], budgetId: previous['budgetId'] ?? PROVIDER_SPEND_SCOPE_BUDGET_ID, revision: previous['revision'] ?? 1,
          currency: 'USD', limitMinorUnits: Number(values['usd']) * SCOPE_BUDGET_CHOICES.minorUnitsPerUsd };
      } else if (view.key === 'inspection.workers.sources') {
        next[index] = { id: previous['id'] ?? `source-${randomUUID().slice(0, 32)}`, kind: values['kind'], path: values['path'], scopeId: values['scopeId'] };
      } else if (view.key === 'execution.workTargets.targets') {
        const prior = active().container;
        const target = { ...previous, id: previous['id'] ?? `target-${randomUUID()}`, kind: 'git', path: values['path'], baseRef: values['branch'] };
        return previewValue({ ...prior, schemaVersion: prior?.['schemaVersion'] ?? 2, targets: [target] }, 'execution.workTargets');
      } else if (view.key === 'layout.resources') {
        const chosenPath = String(values['path']), path = isAbsolute(chosenPath) ? relative(active().layoutRoot, chosenPath) : chosenPath;
        if (!path || path.startsWith('..') || isAbsolute(path)) throw refused();
        const resources = Object.fromEntries(next.filter((_, i) => i !== index).map(entry => [(entry as Record<string, unknown>)['resource'], (entry as Record<string, unknown>)['path']]));
        if (Object.hasOwn(resources, String(values['resource']))) throw refused();
        resources[String(values['resource'])] = path;
        const resolved = resolveProductLayout({ projectRoot: root, root: active().layoutRoot, resources });
        if (new Set(Object.values(resolved.resources)).size !== Object.values(resolved.resources).length) throw refused();
        return previewValue(resources);
      } else {
        if (next.some((entry, i) => i !== index && entry === values['branch'])) throw refused();
        next[index] = values['branch'];
      }
      return previewValue(next);
    },
    async browse(directory) {
      const entries = await sources()?.browse?.(directory ?? (active().view.key === 'layout.resources' ? active().layoutRoot : root)) ?? [];
      paths.clear(); for (const entry of entries) if (entry.kind === 'directory' || active().view.key === 'layout.resources') paths.add(entry.path);
      return entries;
    },
    async importFile(path) {
      prepared = null;
      const { view } = active();
      if (!(CONFIG_IMPORT_KEYS as readonly string[]).includes(view.key) || !sources()?.readDocument) throw refused();
      const value = await sources()!.readDocument!(path), parent = view.key.split('.')[0]!;
      return isRecord(value) ? previewValue(value, parent) : previewValue(value);
    },
    async commit(token) {
      if (!prepared || prepared.token !== token) throw refused();
      const { value, expect, writeKey, action } = prepared, { view } = active(); prepared = null;
      return terminalConfigWrite(root, { action, keyPath: writeKey, value, layer: view.layer, expect }, context, options, locale);
    },
  };
}
