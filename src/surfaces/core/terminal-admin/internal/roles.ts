import { t } from '#platform/index.js';
import { renderModelRoleInspection } from '#surfaces/core/cli-models/index.js';
import type { TerminalAdminCall } from './context.js';

/** `/roles`: the very read view `deckent models roles` prints (same query, same table and legend); read-only, assigning stays a person's `models roles set`. */
export async function rolesLines(call: TerminalAdminCall, args: string): Promise<readonly string[]> {
  const { root, scopeId, options, locale, context } = call;
  if (args.trim()) return [t('terminal.admin.roles.usage', {}, locale)];
  if (!context.inspectModelRoles) return [t('terminal.admin.roles.unavailable', {}, locale)];
  const view = await context.inspectModelRoles(root, { schemaVersion: 1, scopeId }, options);
  const ascii = /^(linux|dumb)$/u.test(options.env?.['TERM'] ?? '');
  return renderModelRoleInspection(view, locale, { width: call.columns ?? Number.POSITIVE_INFINITY, ascii }).split('\n');
}
