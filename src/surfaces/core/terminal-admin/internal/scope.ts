import { basename } from 'node:path';
import { loadConfig, t } from '#platform/index.js';
import { attempt } from './failure.js';
import { shortId } from '#surfaces/core/terminal-kit/index.js';
import type { TerminalAdminCall } from './context.js';

/**
 * `/scope`: who acts where on one line (you, project, company, mode, rule version, short identities), the surface access in words, then the details
 * with the full identities and the full permission-mode record. Read fresh on every call; a part that could not be read is named, not guessed.
 */
export async function scopeLines(call: TerminalAdminCall, identity: Readonly<{ installationId: string; projectId: string }>, args: string, principalName: string | null): Promise<readonly string[]> {
  const { root, scopeId, options, locale, context } = call;
  if (args.trim()) return [t('terminal.admin.scope.usage', {}, locale)];
  const company = await attempt(t('terminal.admin.scope.partCompany', {}, locale), locale, async () => (await loadConfig(root, options)).company.id);
  const mode = await attempt(t('terminal.admin.scope.partMode', {}, locale), locale, context.inspectPermissionMode
    ? () => context.inspectPermissionMode!(root, { schemaVersion: 1, scopeId }, options) : null);
  const access = await attempt(t('terminal.admin.scope.partAccess', {}, locale), locale, context.inspectSurfaceAccess ? () => context.inspectSurfaceAccess!(root, scopeId, options) : null);
  const flag = (value: boolean) => value ? t('terminal.value.yes', {}, locale) : t('terminal.value.no', {}, locale);
  const summary = [
    ...(principalName ? [t('terminal.admin.scope.you', { name: principalName }, locale)] : []),
    t('terminal.admin.scope.projectNamed', { name: basename(root) || root, id: shortId(identity.projectId) }, locale),
    ...('value' in company ? [t('terminal.admin.scope.company', { id: company.value === 'default' ? t('terminal.admin.scope.companyDefault', {}, locale) : company.value }, locale)] : []),
    ...('value' in mode ? [t('terminal.admin.scope.modeShort', { mode: mode.value.mode }, locale), t('terminal.admin.scope.rule', { revision: mode.value.revision }, locale)] : []),
  ].join(' · ');
  const kindWord = (kind: string) => kind === 'run' ? t('terminal.admin.scope.kindRun', {}, locale) : kind === 'worker' ? t('terminal.admin.scope.kindWorker', {}, locale)
    : kind === 'approval' ? t('terminal.admin.scope.kindApproval', {}, locale) : kind;
  const accessLine = 'note' in access ? access.note : access.value
    ? t('terminal.admin.scope.access', { kinds: access.value.kinds.map(kindWord).join(', ') || t('terminal.value.none', {}, locale) }, locale)
    : t('terminal.admin.scope.accessNone', {}, locale);
  return [summary, t('terminal.admin.scope.scope', { scope: scopeId }, locale), accessLine,
    ...('note' in company ? [company.note] : []), ...('note' in mode ? [mode.note] : []),
    t('terminal.admin.scope.details', {}, locale),
    ...[t('terminal.admin.scope.installation', { id: identity.installationId }, locale), t('terminal.admin.scope.project', { id: identity.projectId }, locale),
      ...('value' in mode ? [t('terminal.admin.scope.mode', { mode: mode.value.mode, revision: mode.value.revision, supported: flag(mode.value.supported), fullAccess: flag(mode.value.fullAccess) }, locale)] : [])]
      .map(line => `  ${line}`)];
}
