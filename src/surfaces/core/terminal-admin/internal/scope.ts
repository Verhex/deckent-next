import { basename } from 'node:path';
import { loadConfig, shortId, t } from '#platform/index.js';
import type { InfoChip, InfoRow, InfoView } from '#surfaces/core/terminal-window/index.js';
import { attempt } from './failure.js';
import type { TerminalAdminCall } from './context.js';

type Attempt<T> = Readonly<{ value: T }> | Readonly<{ note: string }>;
type ModeView = Readonly<{ mode: string; askEdits: boolean; revision: number | string; supported: boolean; fullAccess: boolean }>;
/** What `/scope` reads on every call; a part that could not be read is a note that names it, never a guessed value. */
async function readScopeFacts(call: TerminalAdminCall): Promise<Readonly<{ company: Attempt<string>; mode: Attempt<ModeView>;
  access: Attempt<Readonly<{ binding: string; kinds: readonly string[] }> | null> }>> {
  const { root, scopeId, options, locale, context } = call;
  const company = await attempt(t('terminal.admin.scope.partCompany', {}, locale), locale, async () => (await loadConfig(root, options)).company.id);
  const mode = await attempt(t('terminal.admin.scope.partMode', {}, locale), locale, context.inspectPermissionMode
    ? () => context.inspectPermissionMode!(root, { schemaVersion: 1, scopeId }, options) : null);
  const access = await attempt(t('terminal.admin.scope.partAccess', {}, locale), locale, context.inspectSurfaceAccess ? () => context.inspectSurfaceAccess!(root, scopeId, options) : null);
  return { company, mode: mode as Attempt<ModeView>, access };
}
/** T2 integration: the mode reads as the status row's stop word, so "careful" (standart with the ask-for-edits preference) is its own word. */
function stopWord(view: Readonly<{ mode: string; askEdits: boolean }>, locale: TerminalAdminCall['locale']): string {
  return view.mode === 'standart' && view.askEdits ? t('terminal.mode.stop.ask-edits', {}, locale)
    : view.mode === 'full-auto' ? t('terminal.mode.stop.full-auto', {}, locale) : view.mode === 'full-access' ? t('terminal.mode.stop.full-access', {}, locale)
      : view.mode === 'standart' ? t('terminal.mode.stop.standart', {}, locale) : view.mode;
}
function kindWords(kinds: readonly string[], locale: TerminalAdminCall['locale']): string {
  const word = (kind: string) => kind === 'run' ? t('terminal.admin.scope.kindRun', {}, locale) : kind === 'worker' ? t('terminal.admin.scope.kindWorker', {}, locale)
    : kind === 'approval' ? t('terminal.admin.scope.kindApproval', {}, locale) : kind;
  return kinds.map(word).join(', ') || t('terminal.value.none', {}, locale);
}

/**
 * `/scope`: who acts where on one line (you, project, company, mode, rule version, short identities), the surface access in words, then the details
 * with the full identities and the full permission-mode record. Read fresh on every call; a part that could not be read is named, not guessed.
 */
export async function scopeLines(call: TerminalAdminCall, identity: Readonly<{ installationId: string; projectId: string }>, args: string, principalName: string | null,
  sessionFullAccess = false): Promise<readonly string[]> {
  const { root, scopeId, locale } = call;
  if (args.trim()) return [t('terminal.admin.scope.usage', {}, locale)];
  const { company, mode, access } = await readScopeFacts(call);
  const flag = (value: boolean) => value ? t('terminal.value.yes', {}, locale) : t('terminal.value.no', {}, locale);
  const summary = [
    ...(principalName ? [t('terminal.admin.scope.you', { name: principalName }, locale)] : []),
    t('terminal.admin.scope.projectNamed', { name: basename(root) || root, id: shortId(identity.projectId) }, locale),
    ...('value' in company ? [t('terminal.admin.scope.company', { id: company.value === 'default' ? t('terminal.admin.scope.companyDefault', {}, locale) : company.value }, locale)] : []),
    // Astra 2431 P2: the mode this session runs in — full access held by the session reads as such, with the stored mode the next launch takes.
    // A stored full-access start mode without the session holding it runs as standart (the decision's own reading).
    ...('value' in mode ? [sessionFullAccess ? t('terminal.admin.scope.modeSession', { mode: t('terminal.mode.stop.full-access', {}, locale), stored: stopWord(mode.value, locale) }, locale)
      : mode.value.mode === 'full-access' ? t('terminal.admin.scope.modeStored', { mode: t('terminal.mode.stop.standart', {}, locale), stored: stopWord(mode.value, locale) }, locale)
        : t('terminal.admin.scope.modeShort', { mode: stopWord(mode.value, locale) }, locale), t('terminal.admin.scope.rule', { revision: mode.value.revision }, locale)] : []),
  ].join(' · ');
  const accessLine = 'note' in access ? access.note : access.value
    ? t('terminal.admin.scope.access', { kinds: kindWords(access.value.kinds, locale) }, locale)
    : t('terminal.admin.scope.accessNone', {}, locale);
  return [summary, t('terminal.admin.scope.scope', { scope: scopeId }, locale), accessLine,
    ...('note' in company ? [company.note] : []), ...('note' in mode ? [mode.note] : []),
    t('terminal.admin.scope.details', {}, locale),
    ...[t('terminal.admin.scope.installation', { id: identity.installationId }, locale), t('terminal.admin.scope.project', { id: identity.projectId }, locale),
      ...('value' in mode ? [t('terminal.admin.scope.mode', { mode: mode.value.mode, revision: mode.value.revision, supported: flag(mode.value.supported), fullAccess: flag(mode.value.fullAccess) }, locale)] : [])]
      .map(line => `  ${line}`)];
}

/** `/scope` as a window (SW-1): the same fresh facts in sections; identities are the muted tail of a human label, never the label. */
export async function scopeView(call: TerminalAdminCall, identity: Readonly<{ installationId: string; projectId: string }>, principalName: string | null,
  sessionFullAccess = false): Promise<InfoView> {
  const { root, scopeId, locale } = call;
  const { company, mode, access } = await readScopeFacts(call);
  const notRead: InfoChip = { state: 'fail', text: t('terminal.info.chip.notRead', {}, locale) }, oneLine = (text: string) => text.replace(/\s*\n\s*/gu, ' ');
  const flag = (value: boolean): InfoChip => value ? { state: 'ok', text: t('terminal.value.yes', {}, locale) } : { state: 'neutral', text: t('terminal.value.no', {}, locale) };
  const project = basename(root) || root;
  const modeText = 'value' in mode ? sessionFullAccess ? t('terminal.info.scope.modeSession', { mode: t('terminal.mode.stop.full-access', {}, locale), stored: stopWord(mode.value, locale) }, locale)
    : mode.value.mode === 'full-access' ? t('terminal.info.scope.modeStored', { mode: t('terminal.mode.stop.standart', {}, locale), stored: stopWord(mode.value, locale) }, locale)
      : stopWord(mode.value, locale) : null;
  const modeShort = 'value' in mode ? sessionFullAccess ? t('terminal.mode.stop.full-access', {}, locale) : mode.value.mode === 'full-access' ? t('terminal.mode.stop.standart', {}, locale) : stopWord(mode.value, locale)
    : t('terminal.info.chip.notRead', {}, locale);
  const rules: InfoRow[] = 'value' in mode ? [{ key: t('terminal.info.scope.key.mode', {}, locale), value: modeText!, ...(sessionFullAccess || mode.value.mode === 'full-access' ? { chip: { state: 'warn' as const, text: t('terminal.mode.stop.full-access', {}, locale) } } : {}) },
    { key: t('terminal.info.scope.key.rule', {}, locale), value: String(mode.value.revision) }, { key: t('terminal.info.scope.key.modes', {}, locale), value: '', chip: flag(mode.value.supported) },
    { key: t('terminal.info.scope.key.fullAccess', {}, locale), value: '', chip: flag(mode.value.fullAccess) }] : [{ key: t('terminal.info.scope.key.mode', {}, locale), value: oneLine(mode.note), chip: notRead }];
  const accessRow: InfoRow = 'note' in access ? { key: t('terminal.info.scope.key.access', {}, locale), value: oneLine(access.note), chip: notRead }
    : access.value ? { key: t('terminal.info.scope.key.access', {}, locale), value: kindWords(access.value.kinds, locale) }
      : { key: t('terminal.info.scope.key.access', {}, locale), value: t('terminal.info.scope.accessNone', {}, locale), chip: { state: 'warn', text: t('terminal.info.chip.check', {}, locale) } };
  return { model: { title: t('terminal.info.scope.title', {}, locale), chips: [{ state: 'info', text: project }, { state: 'info', text: modeShort }],
    summary: t('terminal.info.scope.summary', { project, mode: modeShort }, locale),
    sections: [
      { title: t('terminal.info.scope.section.who', {}, locale), rows: [...(principalName ? [{ key: t('terminal.info.scope.key.you', {}, locale), value: principalName }] : []),
        { key: t('terminal.info.scope.key.project', {}, locale), value: project }, { key: t('terminal.info.scope.key.scope', {}, locale), value: scopeId },
        'value' in company ? { key: t('terminal.info.scope.key.company', {}, locale), value: company.value === 'default' ? t('terminal.admin.scope.companyDefault', {}, locale) : company.value }
          : { key: t('terminal.info.scope.key.company', {}, locale), value: oneLine(company.note), chip: notRead }] },
      { title: t('terminal.info.scope.section.rules', {}, locale), rows: rules },
      { title: t('terminal.info.scope.section.access', {}, locale), rows: [accessRow] },
      { title: t('terminal.info.scope.section.identities', {}, locale), rows: [{ key: t('terminal.info.scope.key.installation', {}, locale), value: t('terminal.info.scope.installationValue', {}, locale), id: identity.installationId },
        { key: t('terminal.info.scope.key.projectId', {}, locale), value: t('terminal.info.scope.projectIdValue', {}, locale), id: identity.projectId }] },
    ] } };
}
