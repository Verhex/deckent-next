import { ErrorRegistry, loadConfig, MESSAGE_REGISTRY, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { parseConfigInput, type ConfigFieldView, type ConfigWritePermission } from '#engine/index.js';
import { CONFIG_VALUE_CHOICES, configEntryAllowed } from '#platform/index.js';
import { configValueModel, type ConfigChoiceSourcePort, type ConfigValueModel } from './choices.js';
export { configSchemaChoices } from './choices.js';
import { configValueWord, schemaWord, sourceWord, applyWord } from './render.js';
import { terminalConfigWrite, type ConfigCommandContext } from './command.js';

type Layer = 'project' | 'global';
const LAYERS: readonly Layer[] = ['project', 'global'];
/** The panel's view of one key (the shape the terminal's `/config` window takes; localized words only). */
export type ConfigPanelFieldView = Readonly<{ key: string; section: string; description: string; value: string; source: string; apply: string; expected: string;
  choices: ConfigValueModel['choices']; free: boolean; stepper: ConfigValueModel['stepper']; readOnly: string | null; generated: boolean; choiceNotice: string | null; unsettable: boolean; sensitive: boolean;
  locks: Readonly<Record<Layer, Readonly<{ blocked: string | null; note: string | null }>>> }>;

/** What a layer's policy decision means for the person: a lock with its reason, a note (asks for approval), or nothing. */
function layerLock(permission: ConfigWritePermission | undefined, readOnly: boolean, locale: Locale): { blocked: string | null; note: string | null } {
  if (readOnly) return { blocked: t('config.surface.slashReadOnly', {}, locale), note: null };
  if (!permission) return { blocked: null, note: null };
  if (permission.decision === 'refused') return { blocked: t('config.panel.lock.secrets', {}, locale), note: null };
  if (permission.decision === 'deny') return { blocked: t('config.panel.lock.denied', {}, locale), note: null };
  if (permission.decision === 'require-approval') return { blocked: null, note: t('config.panel.lock.approval', { rule: permission.ruleId ?? '-' }, locale) };
  return { blocked: null, note: null };
}

/**
 * The terminal `/config` window's port (T3 L4): the registry's keys with value, source and apply mode, the choices their schema allows, and the
 * principal's policy decision per layer as a lock (read only: `ConfigApplication.permissions` writes nothing). Writes go through the L2 port
 * (`terminalConfigWrite`: principal'd, policy-checked, approval-aware), the same as `/config set|unset`; nothing else writes config here.
 */
export function configPanelPort(root: string, context: ConfigCommandContext, options: ConfigLoadOptions, locale: Locale, sources?: ConfigChoiceSourcePort) {
  if (!context.configApplication) throw ErrorRegistry.createError('CLI_USAGE');
  const application = () => context.configApplication!(root, options);
  // The words of what each key takes, from the last inspection (the entry's reason when a value does not fit).
  const expected = new Map<string, string>(), current = new Map<string, unknown>(), sensitive = new Set<string>();
  const described = (field: ConfigFieldView) => (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[field.descriptionKey] ?? field.description;
  return {
    async inspect() {
      const view = await application().inspect({}), readOnly = !context.resolveConfigPrincipal, notes: string[] = [];
      const config = await loadConfig(root, options), scopeId = (config['terminal'] as { scopeId?: string } | undefined)?.scopeId;
      const inspected = [...view.fields];
      for (const [parent, rule] of Object.entries(CONFIG_VALUE_CHOICES)) {
        if (parent.includes('*') || inspected.some(field => field.key === parent) || !inspected.some(field => field.key.startsWith(parent + '.'))) continue;
        if (rule.kind === 'document' || rule.kind === 'container' || rule.kind === 'reference') {
          try { inspected.push(await application().explain({ keyPath: parent })); } catch { /* Optional extension is absent. */ }
        }
      }
      let permissions: readonly ConfigWritePermission[] | null = null;
      if (!readOnly && scopeId) {
        try {
          const principal = await context.resolveConfigPrincipal!(root, scopeId, options);
          permissions = await application().permissions({ principal, scopeId, keys: inspected.map(field => field.key), layers: LAYERS });
        } catch (error) {
          // A policy that cannot be read shows no locks; the write decides (and refuses) on its own.
          notes.push(t('config.panel.permissionsUnread', { code: String((error as { code?: unknown })?.code ?? 'failed') }, locale));
        }
      }
      if (readOnly) notes.push(t('config.surface.slashReadOnly', {}, locale));
      const projectName = view.fields.find(field => field.key === 'projectName')?.value;
      expected.clear(); current.clear(); sensitive.clear();
      const discovery = sources ?? context.configChoiceSources?.(root, options);
      const fields = (await Promise.all(inspected.map(async field => {
        current.set(field.key, field.value); if (field.redacted) sensitive.add(field.key);
        expected.set(field.key, schemaWord(field.schema, locale));
        const model = await configValueModel(field, root, locale, discovery);
        if (model.hidden) return null;
        const value = configValueWord(field.value, field.redacted, locale);
        const of = (layer: Layer) => permissions?.find(item => item.keyPath === field.key && item.layer === layer);
        return { key: field.key, section: field.key.split('.')[0]!, description: described(field), value, source: sourceWord(field.source, locale), apply: applyWord(field.apply, locale),
          expected: schemaWord(field.schema, locale), choices: model.choices, stepper: model.stepper, readOnly: model.readOnly, generated: model.generated, choiceNotice: model.notice,
          free: model.free, unsettable: field.source === 'project' || field.source === 'global', sensitive: field.redacted,
          locks: { project: layerLock(of('project'), readOnly, locale), global: layerLock(of('global'), readOnly, locale) } };
      }))).filter((field): field is ConfigPanelFieldView => field !== null);
      return { title: t('config.surface.title', { project: typeof projectName === 'string' ? projectName : '-' }, locale), fields, notes };
    },
    parse(keyPath: string, text: string) {
      if (!configEntryAllowed(keyPath, sensitive.has(keyPath))) return { ok: false as const, reason: t('config.select.selectionOnly', {}, locale) };
      if (keyPath === 'terminal.fetch.allowedHosts' && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(text.trim())) return { ok: false as const, reason: t('config.select.invalidHost', {}, locale) };
      if (keyPath === 'toolchains.currency.registryEndpoint') { try { const url = new URL(text); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(); } catch { return { ok: false as const, reason: t('config.select.invalidUrl', {}, locale) }; } }
      const parsed = parseConfigInput(keyPath, keyPath === 'terminal.fetch.allowedHosts' ? JSON.stringify([...new Set([...(Array.isArray(current.get(keyPath)) ? current.get(keyPath) as unknown[] : []), text.trim().toLowerCase()])]) : text);
      if (parsed.ok) return parsed;
      return { ok: false as const, reason: t('config.panel.invalid', { expected: expected.get(keyPath) ?? '-' }, locale) };
    },
    write(request: { readonly action: 'set' | 'unset'; readonly keyPath: string; readonly value?: unknown; readonly layer: Layer }) {
      return terminalConfigWrite(root, { action: request.action, keyPath: request.keyPath, ...(request.action === 'set' ? { value: request.value } : {}), layer: request.layer },
        context, options, locale);
    },
  };
}
