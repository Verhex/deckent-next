import { ErrorRegistry, emit, loadConfig, t, terminalSafeText, type Locale, type OutputSink } from '#platform/index.js';
import { askCliCard, cliMode } from '#surfaces/core/cli-human/index.js';
import type { InstallationCommandContext } from './context.js';

type Person = { readonly issuer: string; readonly subject: string };
type ModeState = { readonly mode: string; readonly wanted: boolean; readonly before: string; readonly after: string; readonly managed: string; readonly others: readonly string[];
  readonly blockedBy: string | null };
/** The installer's permission-mode result as the surface words it (the engine's `InstallerPermissionModesResult`; the surface owns no rule). */
export interface PolicyModesView {
  readonly status: string; readonly reason?: string | null; readonly revision?: string | null; readonly basis?: string | null;
  readonly principal?: Person; readonly person?: Person | null; readonly people?: readonly Person[];
  readonly modes?: readonly ModeState[]; readonly added?: readonly { readonly id: string }[]; readonly removed?: readonly string[]; readonly conflicts?: readonly string[];
}
export type PolicyModesHandler = (projectRoot: string, scopeId: string, input: { readonly modes: readonly string[]; readonly apply: boolean; readonly expect?: string;
  readonly person?: Person }) => Promise<PolicyModesView>;
/** `--modes <list>|none`: the wanted set, each mode once (the engine checks the names again). */
export function parseModes(value: string | undefined): readonly string[] {
  if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
  if (value === 'none') return [];
  const modes = value.split(',');
  if (modes.some(mode => !['full-auto', 'full-access'].includes(mode)) || new Set(modes).size !== modes.length) throw ErrorRegistry.createError('CLI_USAGE');
  return modes;
}

/**
 * `deckent init policy --scope <id> --modes <list>|none --preview|--apply [--expect <rev>] [--person <issuer>/<subject>]` (PRE-9): the installation
 * owner opens or closes full-auto / full-access. `--apply` on the person's terminal previews, shows the plan on a y/N card and applies exactly
 * the previewed revision (the card is bound to that `--expect` token); off an interactive terminal it is refused (`AUTHORITY_WITNESS_REQUIRED`)
 * before anything is read, and the composition's authority witness refuses it again.
 */
export async function policyModesCommand(context: InstallationCommandContext, input: { readonly root: string; readonly scopeId: string; readonly modes: readonly string[];
  readonly modesText: string; readonly apply: boolean; readonly expect?: string; readonly person?: Person; readonly json: boolean; readonly locale: Locale;
  readonly sinks: { readonly stdout?: OutputSink; readonly stderr?: OutputSink } }): Promise<void> {
  const handler = context.openPermissionModesInstallation;
  if (!handler || (input.expect !== undefined && !input.apply)) throw ErrorRegistry.createError('CLI_USAGE');
  const { root, scopeId, locale } = input, call = { modes: input.modes, ...(input.person ? { person: input.person } : {}) };
  const show = (view: PolicyModesView): void => { emit(view, { ...input.sinks, json: input.json, render: value => policyModesText(value, scopeId, input.modesText, locale, typedMode(input.apply, input.expect)) }); };
  if (!input.apply) return show(await handler(root, scopeId, { ...call, apply: false }));
  // The y/N card is the person's confirmation: off an interactive terminal (a pipe, CI, an AI agent's shell even inside a pseudo-terminal) nothing
  // is asked and nothing is applied. The composition's witness refuses the same request again on its own.
  if (cliMode(context).mode !== 'interactive') throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: 'policyPermissionModes' } });
  const preview = await handler(root, scopeId, { ...call, apply: false });
  if (preview.status !== 'preview' || (input.expect !== undefined && input.expect !== preview.revision)) {
    return show(preview.status === 'preview' ? { ...preview, status: 'conflict', reason: 'revision-changed' } : preview);
  }
  const ttlMs = (await loadConfig(root, { ...(context.env ? { env: context.env } : {}), heal: false })).approvals.sessionTtlMs;
  const who = whoText(preview);
  const answer = await askCliCard({ title: t('cli.init.policyModes.cardTitle', { who, scope: terminalSafeText(scopeId) }, locale), body: modeLines(preview, locale),
    options: [{ id: 'apply', label: t('cli.init.policyModes.cardApply', {}, locale), key: 'y' }, { id: 'no', label: t('cli.init.policyModes.cardNo', {}, locale), key: 'n' }] },
  { locale, ...(context.env ? { env: context.env } : {}), signal: AbortSignal.timeout(ttlMs) });
  if (answer !== 'apply') return show({ ...preview, status: 'cancelled' });
  show(await handler(root, scopeId, { ...call, apply: true, expect: preview.revision! }));
}

const whoText = (view: PolicyModesView) => terminalSafeText(view.principal ? `${view.principal.issuer}/${view.principal.subject}` : '-');
function modeLines(view: PolicyModesView, locale: Locale): string[] {
  const state = (effect: string) => effect === 'allow' ? t('cli.init.policyModes.state.allow', {}, locale)
    : effect === 'require-approval' ? t('cli.init.policyModes.state.require-approval', {}, locale) : t('cli.init.policyModes.state.deny', {}, locale);
  const change = (managed: string) => managed === 'added' ? t('cli.init.policyModes.change.added', {}, locale) : managed === 'removed' ? t('cli.init.policyModes.change.removed', {}, locale)
    : managed === 'held' ? t('cli.init.policyModes.change.held', {}, locale) : managed === 'conflict' ? t('cli.init.policyModes.change.conflict', {}, locale)
      : t('cli.init.policyModes.change.none', {}, locale);
  return [...(view.modes ?? []).map(item => t('cli.init.policyModes.mode', { mode: item.mode, before: state(item.before), after: state(item.after), change: change(item.managed) }, locale)),
    ...(view.modes ?? []).filter(item => item.others.length).map(item => t('cli.init.policyModes.others', { mode: item.mode, ids: terminalSafeText(item.others.join(', ')) }, locale)),
    t('cli.init.policyModes.hardFloor', {}, locale)];
}
/** The result in the person's words: what happened, the exact next command, each mode's effective state, the rules that still allow a mode. */
/** alpha.56.1: the hand-built refusal repeats the mode the person typed (`--apply [--expect <rev>]` stays, never turned into `--preview`). */
export const typedMode = (apply: boolean, expect?: string): string => (apply ? `--apply${expect === undefined ? '' : ` --expect ${terminalSafeText(expect)}`}` : '--preview');
export function policyModesText(view: PolicyModesView, scope: string, modes: string, locale: Locale, typed = '--preview'): string {
  const named = view.person ? `${view.person.issuer}/${view.person.subject}` : '';
  const people = (view.people ?? []).map(item => `${item.issuer}/${item.subject}`).join(', ') || '-';
  const blocked = (view.modes ?? []).find(item => item.wanted && item.after !== 'allow');
  const params = { scope: terminalSafeText(scope), modes: terminalSafeText(modes), revision: terminalSafeText(view.revision ?? '-'), person: view.person ? ` --person ${terminalSafeText(named)}` : '',
    who: whoText(view), people: terminalSafeText(people), typed, mode: blocked?.mode ?? '-', rule: terminalSafeText(blocked?.blockedBy ?? '-') };
  const head = view.status === 'preview' ? t('cli.init.policyModes.preview', params, locale)
    : view.status === 'applied' ? t('cli.init.policyModes.applied', params, locale)
    : view.status === 'current' ? t('cli.init.policyModes.current', params, locale)
    : view.status === 'cancelled' ? t('cli.init.policyModes.cancelled', params, locale)
    : view.status === 'conflict' ? t('cli.init.policyModes.conflict', params, locale)
    : view.reason === 'rule-conflict' ? t('cli.init.policyModes.ruleConflict', params, locale)
    : view.status === 'refused' ? t('cli.init.policyModes.refused', params, locale)
    : view.reason === 'not-owner' ? t('cli.init.policyModes.notOwner', params, locale)
    : view.reason === 'not-first-run' ? t('cli.init.policyModes.handBuilt', params, locale)
    : view.reason === 'not-this-person' ? t('cli.init.policyModes.notThisPerson', { ...params, person: terminalSafeText(named || whoText(view)) }, locale)
    : view.reason === 'person-not-named' ? t('cli.init.policyModes.personNotNamed', { ...params, person: terminalSafeText(named) }, locale)
    : t('cli.init.policyModes.invalid', params, locale);
  const conflicts = (view.conflicts ?? []).length ? [t('cli.init.policyUpgrade.conflicts', { ids: terminalSafeText(view.conflicts!.join(', ')) }, locale)] : [];
  const opened = view.status === 'applied' && (view.modes ?? []).some(item => item.after === 'allow') ? [t('cli.init.policyModes.next', {}, locale)] : [];
  return [head, ...opened, ...((view.modes ?? []).length && view.status !== 'cancelled' ? modeLines(view, locale) : []), ...conflicts].join('\n');
}
