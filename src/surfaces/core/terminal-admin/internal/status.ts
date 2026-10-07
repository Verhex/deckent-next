import { basename } from 'node:path';
import { PACKAGE_VERSION, t } from '#platform/index.js';
import type { InfoChip, InfoRow, InfoSection, InfoView } from '#surfaces/core/terminal-window/index.js';
import { queryFailureText } from './failure.js';
import { readCurrentModel } from './current-model.js';
import type { TerminalAdminCall } from './context.js';

type ServiceFacts = Readonly<{ instanceId: string; processId?: number | undefined; build?: Readonly<{ sourceCommit: string | null }> | undefined }>;
/** What `/status` reads on every call: the host report, the runtime service (or the line that names why it was not read) and the model. */
type StatusFacts = Readonly<{ body: string; state: 'open' | 'running' | 'unread'; service: Readonly<{ value: ServiceFacts }> | Readonly<{ note: string }>;
  model: Readonly<{ value: Awaited<ReturnType<typeof readCurrentModel>> }> | null }>;

async function readStatusFacts(call: TerminalAdminCall, report: () => Promise<string>): Promise<StatusFacts> {
  const { root, options, locale, context } = call;
  const body = await report();
  let state: StatusFacts['state'] = 'open', service: StatusFacts['service'];
  if (!context.describeRuntimeService) service = { note: t('terminal.admin.partUnavailable', { part: t('terminal.admin.status.partService', {}, locale) }, locale) };
  else {
    try { service = { value: await context.describeRuntimeService(root, options) }; state = 'running'; }
    catch (error) {
      state = 'unread';
      service = { note: t('terminal.admin.partFailed', { part: t('terminal.admin.status.partService', {}, locale), reason: queryFailureText(error, locale) }, locale) };
    }
  }
  let model: StatusFacts['model'];
  try { model = { value: await readCurrentModel(call) }; } catch { model = null; }
  return { body, state, service, model };
}

function stateWords(state: StatusFacts['state'], locale: TerminalAdminCall['locale']): string {
  return state === 'running' ? t('terminal.admin.status.running', {}, locale) : state === 'open' ? t('terminal.admin.status.open', {}, locale)
    : t('terminal.admin.status.serviceUnread', {}, locale);
}

/**
 * `/status`: one human sentence (is Deckent running, which version, which model), then the details: the host's status report re-read now (`report`)
 * and the runtime service as it answers now (instance, pid, build). A failed read is named, never replaced by an earlier value or the opening line.
 */
export async function statusLines(call: TerminalAdminCall, report: () => Promise<string>): Promise<readonly string[]> {
  const { locale } = call, facts = await readStatusFacts(call, report);
  const service = 'note' in facts.service ? facts.service.note : t('terminal.admin.status.service', { instance: facts.service.value.instanceId, pid: facts.service.value.processId ?? '-',
    build: facts.service.value.build?.sourceCommit?.slice(0, 12) ?? t('terminal.value.unknown', {}, locale) }, locale);
  const model = !facts.model ? t('terminal.admin.status.modelUnread', {}, locale) : facts.model.value ? t('terminal.admin.status.model', { model: facts.model.value.short }, locale)
    : t('terminal.admin.status.noModel', {}, locale);
  return [[stateWords(facts.state, locale), t('terminal.admin.status.version', { version: PACKAGE_VERSION }, locale), model].join(' · '),
    t('terminal.admin.status.details', {}, locale), ...[...facts.body.split('\n'), service].map(line => `  ${line}`)];
}

/** `/status` as a window (SW-1): the same fresh facts as typed rows — human words first, identities muted and shortened by the window. */
export async function statusView(call: TerminalAdminCall, report: () => Promise<string>, identity: Readonly<{ installationId: string; projectId: string }>): Promise<InfoView> {
  const { locale, root, scopeId } = call, facts = await readStatusFacts(call, report);
  const stateChip: InfoChip = facts.state === 'running' ? { state: 'ok', text: t('terminal.info.status.chip.running', {}, locale) }
    : facts.state === 'open' ? { state: 'neutral', text: t('terminal.info.status.chip.open', {}, locale) } : { state: 'fail', text: t('terminal.info.chip.notRead', {}, locale) };
  const model = facts.model?.value;
  const modelRow: InfoRow = !facts.model ? { key: t('terminal.info.status.key.model', {}, locale), value: t('terminal.admin.status.modelUnread', {}, locale), chip: { state: 'fail', text: t('terminal.info.chip.notRead', {}, locale) } }
    : !model ? { key: t('terminal.info.status.key.model', {}, locale), value: t('terminal.admin.status.noModel', {}, locale), chip: { state: 'warn', text: t('terminal.info.chip.check', {}, locale) } }
      : { key: t('terminal.info.status.key.model', {}, locale), value: model.short, chip: model.status === 'ready' ? { state: 'ok', text: t('terminal.info.status.chip.ready', {}, locale) }
        : { state: 'warn', text: t('terminal.info.status.chip.notDeclared', {}, locale) } };
  const service = facts.service;
  const serviceSection: InfoSection = 'note' in service ? { title: t('terminal.info.status.section.service', {}, locale), chip: stateChip, notes: [service.note] }
    : { title: t('terminal.info.status.section.service', {}, locale), chip: stateChip, rows: [
      { key: t('terminal.info.status.key.instance', {}, locale), value: t('terminal.info.status.instanceValue', {}, locale), id: service.value.instanceId },
      { key: t('terminal.info.status.key.process', {}, locale), value: service.value.processId === undefined ? t('terminal.value.unknown', {}, locale) : t('terminal.info.status.processValue', { pid: service.value.processId }, locale) },
      { key: t('terminal.info.status.key.build', {}, locale), value: service.value.build?.sourceCommit ? t('terminal.info.status.buildValue', {}, locale) : t('terminal.value.unknown', {}, locale),
        ...(service.value.build?.sourceCommit ? { id: service.value.build.sourceCommit } : {}) }] };
  const stateText = stateWords(facts.state, locale);
  return { model: { title: t('terminal.info.status.title', {}, locale), chips: [stateChip, { state: 'info', text: PACKAGE_VERSION }],
    summary: t('terminal.info.status.summary', { state: stateText, version: PACKAGE_VERSION }, locale),
    sections: [
      { title: 'Deckent', rows: [{ key: t('terminal.info.status.key.state', {}, locale), value: stateText }, { key: t('terminal.info.status.key.version', {}, locale), value: PACKAGE_VERSION }, modelRow] },
      { title: t('terminal.info.status.section.where', {}, locale), rows: [{ key: t('terminal.info.status.key.project', {}, locale), value: basename(root) || root, id: identity.projectId },
        { key: t('terminal.info.status.key.scope', {}, locale), value: scopeId }, { key: t('terminal.info.status.key.installation', {}, locale), value: t('terminal.info.status.installationValue', {}, locale), id: identity.installationId }] },
      serviceSection,
      { title: t('terminal.info.status.section.details', {}, locale), items: facts.body.split('\n').filter(line => line.trim()).map(text => ({ text, muted: true })) },
    ] } };
}
