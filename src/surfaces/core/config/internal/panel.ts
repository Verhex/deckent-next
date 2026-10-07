import { ErrorRegistry, loadConfig, MESSAGE_REGISTRY, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { parseConfigInput, type ConfigFieldView, type ConfigWritePermission } from '#engine/index.js';
import { configValueWord, schemaWord, sourceWord, applyWord } from './render.js';
import { terminalConfigWrite, type ConfigCommandContext } from './command.js';

type Layer = 'project' | 'global';
const LAYERS: readonly Layer[] = ['project', 'global'];
/** The panel's view of one key (the shape the terminal's `/config` window takes; localized words only). */
export type ConfigPanelFieldView = Readonly<{ key: string; section: string; description: string; value: string; source: string; apply: string; expected: string;
  choices: readonly Readonly<{ id: string; label: string; value: unknown }>[]; free: boolean; unsettable: boolean; sensitive: boolean;
  locks: Readonly<Record<Layer, Readonly<{ blocked: string | null; note: string | null }>>> }>;

/** Values a JSON schema enumerates (enum, boolean, constants of a union); none for open values (a typed entry then). */
export function configSchemaChoices(schema: unknown): readonly unknown[] {
  if (!schema || typeof schema !== 'object') return [];
  const value = schema as Record<string, unknown>;
  if (Array.isArray(value['enum'])) return value['enum'];
  if (Object.hasOwn(value, 'const')) return [value['const']];
  if (value['type'] === 'boolean') return [true, false];
  const options = value['anyOf'] ?? value['oneOf'];
  if (Array.isArray(options)) {
    const parts = options.map(option => configSchemaChoices(option));
    // A union is a closed list only when every member is.
    return parts.every(part => part.length) ? parts.flat() : [];
  }
  return [];
}

/** What a layer's policy decision means for the person: a lock with its reason, a note (asks for approval), or nothing. */
function layerLock(permission: ConfigWritePermission | undefined, readOnly: boolean, locale: Locale): { blocked: string | null; note: string | null } {
  if (readOnly) return { blocked: t('config.surface.slashReadOnly', {}, locale), note: null };
  if (!permission) return { blocked: null, note: null };
  if (permission.decision === 'refused') return { blocked: t('config.panel.lock.secrets', {}, locale), note: null };
  if (permission.decision === 'deny') return { blocked: t('config.panel.lock.denied', { layer: sourceWord(permission.layer, locale) }, locale), note: null };
  if (permission.decision === 'require-approval') return { blocked: null, note: t('config.panel.lock.approval', { rule: permission.ruleId ?? '-' }, locale) };
  return { blocked: null, note: null };
}

/**
 * The terminal `/config` window's port (T3 L4): the registry's keys with value, source and apply mode, the choices their schema allows, and the
 * principal's policy decision per layer as a lock (read only: `ConfigApplication.permissions` writes nothing). Writes go through the L2 port
 * (`terminalConfigWrite`: principal'd, policy-checked, approval-aware), the same as `/config set|unset`; nothing else writes config here.
 */
export function configPanelPort(root: string, context: ConfigCommandContext, options: ConfigLoadOptions, locale: Locale) {
  if (!context.configApplication) throw ErrorRegistry.createError('CLI_USAGE');
  const application = () => context.configApplication!(root, options);
  // The words of what each key takes, from the last inspection (the entry's reason when a value does not fit).
  const expected = new Map<string, string>();
  const described = (field: ConfigFieldView) => (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[field.descriptionKey] ?? field.description;
  return {
    async inspect() {
      const view = await application().inspect({}), readOnly = !context.resolveConfigPrincipal, notes: string[] = [];
      const config = await loadConfig(root, options), scopeId = (config['terminal'] as { scopeId?: string } | undefined)?.scopeId;
      let permissions: readonly ConfigWritePermission[] | null = null;
      if (!readOnly && scopeId) {
        try {
          const principal = await context.resolveConfigPrincipal!(root, scopeId, options);
          permissions = await application().permissions({ principal, scopeId, keys: view.fields.map(field => field.key), layers: LAYERS });
        } catch (error) {
          // A policy that cannot be read shows no locks; the write decides (and refuses) on its own.
          notes.push(t('config.panel.permissionsUnread', { code: String((error as { code?: unknown })?.code ?? 'failed') }, locale));
        }
      }
      if (readOnly) notes.push(t('config.surface.slashReadOnly', {}, locale));
      const projectName = view.fields.find(field => field.key === 'projectName')?.value;
      expected.clear();
      const fields: ConfigPanelFieldView[] = view.fields.map(field => {
        expected.set(field.key, schemaWord(field.schema, locale));
        const choices = field.redacted ? [] : configSchemaChoices(field.schema);
        const value = configValueWord(field.value, field.redacted, locale);
        const of = (layer: Layer) => permissions?.find(item => item.keyPath === field.key && item.layer === layer);
        return { key: field.key, section: field.key.split('.')[0]!, description: described(field), value, source: sourceWord(field.source, locale), apply: applyWord(field.apply, locale),
          expected: schemaWord(field.schema, locale), choices: choices.map((choice, index) => ({ id: String(index), label: configValueWord(choice, false, locale), value: choice })),
          free: !choices.length, unsettable: field.source === 'project' || field.source === 'global', sensitive: field.redacted,
          locks: { project: layerLock(of('project'), readOnly, locale), global: layerLock(of('global'), readOnly, locale) } };
      });
      return { title: t('config.surface.title', { project: typeof projectName === 'string' ? projectName : '-' }, locale), fields, notes };
    },
    parse(keyPath: string, text: string) {
      const parsed = parseConfigInput(keyPath, text);
      if (parsed.ok) return parsed;
      return { ok: false as const, reason: t('config.panel.invalid', { expected: expected.get(keyPath) ?? '-' }, locale) };
    },
    write(request: { readonly action: 'set' | 'unset'; readonly keyPath: string; readonly value?: unknown; readonly layer: Layer }) {
      return terminalConfigWrite(root, { action: request.action, keyPath: request.keyPath, ...(request.action === 'set' ? { value: request.value } : {}), layer: request.layer },
        context, options, locale);
    },
  };
}
