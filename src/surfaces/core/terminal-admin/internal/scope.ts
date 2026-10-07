import { loadConfig, t } from '#platform/index.js';
import { part } from './failure.js';
import type { TerminalAdminCall } from './context.js';

/** `/scope`: the scope this terminal acts in and what the service says about the person's access to it, read fresh on every call. */
export async function scopeLines(call: TerminalAdminCall, identity: Readonly<{ installationId: string; projectId: string }>, args: string): Promise<readonly string[]> {
  const { root, scopeId, options, locale, context } = call;
  if (args.trim()) return [t('terminal.admin.scope.usage', {}, locale)];
  const own = [t('terminal.admin.scope.scope', { scope: scopeId }, locale), t('terminal.admin.scope.installation', { id: identity.installationId }, locale),
    t('terminal.admin.scope.project', { id: identity.projectId }, locale)];
  const company = await part(t('terminal.admin.scope.partCompany', {}, locale), locale, async () =>
    [t('terminal.admin.scope.company', { id: (await loadConfig(root, options)).company.id }, locale)]);
  const mode = await part(t('terminal.admin.scope.partMode', {}, locale), locale, context.inspectPermissionMode ? async () => {
    const view = await context.inspectPermissionMode!(root, { schemaVersion: 1, scopeId }, options);
    const flag = (value: boolean) => value ? t('terminal.value.yes', {}, locale) : t('terminal.value.no', {}, locale);
    return [t('terminal.admin.scope.mode', { mode: view.mode, revision: view.revision, supported: flag(view.supported), fullAccess: flag(view.fullAccess) }, locale)];
  } : null);
  const access = await part(t('terminal.admin.scope.partAccess', {}, locale), locale, context.inspectSurfaceAccess ? async () => {
    const found = await context.inspectSurfaceAccess!(root, scopeId, options);
    return [found ? t('terminal.admin.scope.access', { binding: found.binding, kinds: found.kinds.join(', ') || t('terminal.value.none', {}, locale) }, locale)
      : t('terminal.admin.scope.accessNone', {}, locale)];
  } : null);
  return [...own, ...company, ...mode, ...access];
}
