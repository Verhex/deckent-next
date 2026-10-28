import { ownerBaselineFamilyKnown, type InstallerOwnerBaselineResult } from '#engine/index.js';
import { ErrorRegistry, emit, loadConfig, t, terminalSafeText, type Locale, type OutputSink } from '#platform/index.js';
import { askCliCard, cliMode } from '#surfaces/core/cli-human/index.js';
import type { InstallationCommandContext } from './context.js';

type Person = { readonly issuer: string; readonly subject: string };
export type OwnerBaselineHandler = (root: string, scopeId: string, input: { readonly families: readonly string[]; readonly apply: boolean;
  readonly person?: Person; readonly expect?: string }) => Promise<InstallerOwnerBaselineResult>;
export function parseBaseline(text: string | undefined): readonly string[] {
  if (!text) throw ErrorRegistry.createError('CLI_USAGE');
  if (text === 'none') return [];
  const families = text.split(',');
  if (families.some(family => !ownerBaselineFamilyKnown(family)) || new Set(families).size !== families.length) throw ErrorRegistry.createError('CLI_USAGE');
  return families;
}
/** Same installer custody as PRE-9; applying always previews the exact cells on a person's terminal. */
export async function ownerBaselineCommand(context: InstallationCommandContext, input: { readonly root: string; readonly scopeId: string; readonly families: readonly string[];
  readonly apply: boolean; readonly expect?: string; readonly person?: Person; readonly json: boolean; readonly locale: Locale;
  readonly sinks: { readonly stdout?: OutputSink; readonly stderr?: OutputSink } }): Promise<void> {
  const handler = context.openOwnerBaselineInstallation;
  if (!handler || input.expect !== undefined && !input.apply) throw ErrorRegistry.createError('CLI_USAGE');
  if (input.apply && cliMode(context).mode !== 'interactive') throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: 'policyPermissionModes' } });
  const call = { families: input.families, ...(input.person ? { person: input.person } : {}) };
  const lines = (view: InstallerOwnerBaselineResult) => [t('cli.init.ownerBaseline.summary', { status: view.status, reason: view.reason ?? '-', scope: terminalSafeText(input.scopeId),
    who: terminalSafeText(`${view.principal.issuer}/${view.principal.subject}`), added: view.added.length, removed: view.removed.length, remaining: view.remaining }, input.locale),
    ...view.cells.map(cell => `${terminalSafeText(cell.id)}: ${cell.kind} / ${cell.actions.join(', ')} / ${cell.ids === 'all' ? '*' : cell.ids.join(', ')} / ${cell.scopes === 'all' ? '*' : cell.scopes.join(', ')}: ${cell.before} → ${cell.after}`),
    ...view.removed.map(id => `- ${terminalSafeText(id)}`), ...view.conflicts.map(terminalSafeText), t('cli.init.ownerBaseline.notice', {}, input.locale)];
  const show = (view: InstallerOwnerBaselineResult): void => { emit(view, { ...input.sinks, json: input.json, render: value => lines(value).join('\n') }); };
  const preview = await handler(input.root, input.scopeId, { ...call, apply: false });
  if (!input.apply || preview.status !== 'preview') return show(preview);
  if (input.expect !== undefined && input.expect !== preview.expect) return show({ ...preview, status: 'conflict', reason: 'revision-changed' });
  const ttlMs = (await loadConfig(input.root, { env: context.env ?? process.env, heal: false })).approvals.sessionTtlMs;
  const answer = await askCliCard({ title: t('cli.init.ownerBaseline.title', {}, input.locale), body: lines(preview),
    options: [{ id: 'apply', label: t('cli.init.policyModes.cardApply', {}, input.locale), key: 'y' }, { id: 'no', label: t('cli.init.policyModes.cardNo', {}, input.locale), key: 'n' }] },
  { locale: input.locale, env: context.env ?? process.env, signal: AbortSignal.timeout(ttlMs) });
  if (answer !== 'apply') return show(preview);
  show(await handler(input.root, input.scopeId, { ...call, apply: true, expect: preview.expect! }));
}
