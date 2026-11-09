import { ErrorRegistry, messageText, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { parseConfigInput, type ConfigWritePermission } from '#engine/index.js';
import { CONFIG_VALUE_CHOICES, configChoiceDeclaration, parseConfigEntry, configEntryAllowed } from '#platform/index.js';
import { configValueModel, type ConfigChoiceSourcePort, type ConfigValueModel } from './choices.js';
export { configSchemaChoices } from './choices.js';
import { CONFIG_RECORD_KEYS, CONFIG_IMPORT_KEYS, configRecordPort, configRecordSupported } from './records.js';
import { configValueWord, fieldDescription, schemaWord, sourceWord, applyWord } from './render.js';
import { terminalConfigWrite, type ConfigCommandContext } from './command.js';
import { applyOperationsBaseline, operationsBaselineOffer, type OperationsBaselineOffer } from './operations-baseline.js';
import { isProtectedConfigWrite } from '#engine/index.js';

type Layer = 'project' | 'global';
const LAYERS: readonly Layer[] = ['project', 'global'];
/** The panel's view of one key (the shape the terminal's `/config` window takes; localized words only). */
export type ConfigPanelFieldView = Readonly<{ key: string; section: string; description: string; value: string; source: string; apply: string; expected: string;
  records: boolean; choices: ConfigValueModel['choices']; free: boolean;
  /** BeUser E-07: a protected key's confirm lines (who may change it, and for a model-calling switch what is sent and spent); empty otherwise. */
  guard: readonly string[]; stepper: ConfigValueModel['stepper']; readOnly: string | null; generated: boolean; choiceNotice: string | null; unsettable: boolean; sensitive: boolean;
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
export function configPanelPort(root: string, context: ConfigCommandContext, options: ConfigLoadOptions, locale: Locale, sources?: ConfigChoiceSourcePort,
  surface: 'terminal' | 'cli' = 'terminal') {
  if (!context.configApplication) throw ErrorRegistry.createError('CLI_USAGE');
  const application = context.configApplication(root, options);
  // The words of what each key takes, from the last inspection (the entry's reason when a value does not fit).
  const expected = new Map<string, string>(), current = new Map<string, unknown>(), sensitive = new Set<string>();
  return {
    records: configRecordPort(root, context, options, locale, sources, surface),
    async inspect() {
      const view = await application.inspect({ include: [...Object.entries(CONFIG_VALUE_CHOICES).filter(([parent, rule]) => !parent.includes('*') && ['document', 'container', 'reference'].includes(rule.kind)).map(([parent]) => parent), ...CONFIG_RECORD_KEYS, ...CONFIG_IMPORT_KEYS] }), readOnly = !context.resolveConfigPrincipal, notes: string[] = [];
      const scope = view.fields.find(field => field.key === 'terminal.scopeId')?.value, scopeId = typeof scope === 'string' ? scope : undefined;
      const inspected = [...view.fields];
      let permissions: readonly ConfigWritePermission[] | null = null;
      if (!readOnly && scopeId) {
        try {
          const principal = await context.resolveConfigPrincipal!(root, scopeId, options);
          permissions = await application.permissions({ principal, scopeId, keys: inspected.map(field => field.key), layers: LAYERS });
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
        if (model.hidden && !configRecordSupported(field.key)) return null;
        const value = configValueWord(field.value, field.redacted, locale);
        const of = (layer: Layer) => permissions?.find(item => item.keyPath === field.key && item.layer === layer);
        return { key: field.key, section: field.key.split('.')[0]!, description: fieldDescription(field, locale), value, source: sourceWord(field.source, locale), apply: applyWord(field.apply, locale),
          expected: schemaWord(field.schema, locale), choices: model.choices, stepper: model.stepper, readOnly: configRecordSupported(field.key) ? null : model.readOnly, records: configRecordSupported(field.key), generated: model.generated, choiceNotice: model.notice,
          free: model.free, guard: guardLines(field.key, locale), unsettable: field.source === 'project' || field.source === 'global', sensitive: field.redacted,
          locks: { project: layerLock(of('project'), readOnly, locale), global: layerLock(of('global'), readOnly, locale) } };
      }))).filter((field): field is ConfigPanelFieldView => field !== null);
      return { title: t('config.surface.title', { project: typeof projectName === 'string' ? projectName : '-' }, locale), fields, notes };
    },
    parse(keyPath: string, text: string) {
      if (!configEntryAllowed(keyPath, sensitive.has(keyPath))) return { ok: false as const, reason: t('config.select.selectionOnly', {}, locale) };
      const entry = parseConfigEntry(configChoiceDeclaration(keyPath), text, current.get(keyPath));
      if (!entry.ok) return { ok: false as const, reason: ({ 'config.select.invalidHost': t('config.select.invalidHost', {}, locale), 'config.select.invalidUrl': t('config.select.invalidUrl', {}, locale) })[entry.reason] };
      const parsed = parseConfigInput(keyPath, entry.text);
      if (parsed.ok) return parsed;
      return { ok: false as const, reason: t('config.panel.invalid', { expected: expected.get(keyPath) ?? '-' }, locale) };
    },
    ...(context.openOwnerBaselineInstallation ? { operationsBaseline: { offer: () => operationsBaselineOffer(root, context.openOwnerBaselineInstallation, options, locale),
      apply: (offer: OperationsBaselineOffer) => applyOperationsBaseline(root, context.openOwnerBaselineInstallation!, offer, locale) } } : {}),
    write(request: { readonly action: 'set' | 'unset'; readonly keyPath: string; readonly value?: unknown; readonly layer: Layer }) {
      return terminalConfigWrite(root, { action: request.action, keyPath: request.keyPath, ...(request.action === 'set' ? { value: request.value } : {}), layer: request.layer },
        context, options, locale, surface);
    },
  };
}
/** A protected key asks for confirmation; a switch whose shadow already calls a model says so (the catalog holds that text, keyed by the key). */
function guardLines(keyPath: string, locale: Locale): readonly string[] {
  if (!isProtectedConfigWrite(keyPath)) return [];
  const cost = messageText(`config.panel.guard.${keyPath}`, locale);
  return [t('config.panel.guard.protected', {}, locale), ...(cost ? [cost] : [])];
}
