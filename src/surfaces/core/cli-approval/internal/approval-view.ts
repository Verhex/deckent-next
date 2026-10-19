import { HARD_FLOOR_CARD_CELLS, approvalDecisionClass, approvalFacts, approvalRecordSchema, approvalSubject, type ApprovalRecord } from '#domain/index.js';
import { t, terminalSafeText, type Locale } from '#platform/index.js';
import { displayId, formatAgo, formatClock, formatDuration, orderPendingFirst, renderCliTable, safeCell, type CliTableStyle } from '#surfaces/core/cli-human/index.js';
import registry from './approval.json' with { type: 'json' };

/** Bounds of the person's approval list (C-APPROVE registry): pages scanned, rows shown. */
export const APPROVAL_LIST = Object.freeze({ ...registry.list });
const FLOOR_CELLS: readonly string[] = HARD_FLOOR_CARD_CELLS;
/** Who decided, in the terminal's words (the sealed decider class; a legacy record says it is unknown). */
const deciderText = (decider: string | null, locale: Locale) => decider === 'human-tty' ? t('approval.decider.human-tty', {}, locale) : decider === 'ai-policy'
  ? t('approval.decider.ai-policy', {}, locale) : decider === 'system' ? t('approval.decider.system', {}, locale) : t('approval.decider.unknown', {}, locale);

/** Whether the request is waiting for someone now (pending and not past its expiry on the host clock). */
export const isPending = (record: ApprovalRecord, nowMs: number) => record.status === 'pending' && record.request.expiresAt > nowMs;
/** A legacy request (no facts), a hard-floor tool cell (the domain's one list) or an authority effect: the card offers only once / no, never "always". */
export function onHardFloor(record: ApprovalRecord): boolean {
  const risk = approvalFacts(record.request)?.risk;
  return approvalFacts(record.request) === null || risk?.source === 'cell' && FLOOR_CELLS.includes(risk.cell) || risk?.source === 'effect-class' && risk.authority;
}
/** Records the service returned, in the order a person reads them: waiting first, then newest to oldest. Unparseable rows are dropped by the caller's schema. */
export function readableApprovals(page: unknown, nowMs: number): readonly ApprovalRecord[] {
  const rows = Array.isArray(page) ? page.flatMap(row => { const parsed = approvalRecordSchema.safeParse(row); return parsed.success ? [parsed.data] : []; }) : [];
  return orderPendingFirst(rows, { pending: record => isPending(record, nowMs), time: record => record.request.createdAt });
}

/** What was asked, in words: the subject kind and its target (display copies only; the summary is the producer's own text). */
export function approvalWhat(record: ApprovalRecord, locale: Locale): string {
  const subject = approvalSubject(record.request), safe = (value: string) => terminalSafeText(value);
  switch (subject.kind) {
    case 'task': return t('cli.approval.what.task', { run: safe(subject.runId), task: safe(subject.taskId) }, locale);
    case 'run-create': return t('cli.approval.what.runCreate', { run: safe(subject.runId) }, locale);
    case 'operation': return t('cli.approval.what.operation', { operation: `${safe(subject.operation.id)}@${subject.operation.version}`, target: safe(subject.target.id) }, locale);
    case 'config-change': return subject.action === 'set' ? t('cli.approval.what.configSet', { key: safe(subject.keyPath), layer: subject.layer }, locale)
      : t('cli.approval.what.configUnset', { key: safe(subject.keyPath), layer: subject.layer }, locale);
    default: return t('cli.approval.what.tool', { tool: safe(subject.tool), target: safe(subject.resource) }, locale);
  }
}
const actor = (record: ApprovalRecord) => terminalSafeText(`${record.request.requester.issuer}/${record.request.requester.subject}`);
/** The state column: time left while waiting, the decision and how long ago, or expired. */
export function approvalState(record: ApprovalRecord, nowMs: number, locale: Locale): string {
  if (isPending(record, nowMs)) return t('cli.approval.state.pending', { left: formatDuration(record.request.expiresAt - nowMs, locale) }, locale);
  if (record.status === 'pending' || record.status === 'expired') return t('cli.approval.state.expired', {}, locale);
  const decision = record.decision!;
  const ago = formatAgo(decision.decidedAt, nowMs, locale);
  return decision.decision === 'allow' ? t('cli.approval.state.allowed', { ago }, locale) : t('cli.approval.state.denied', { ago }, locale);
}

/** The pipe/TTY table: short id · state · what · summary · requester. Waiting rows first; the caller says how many were not shown. */
export function approvalTable(records: readonly ApprovalRecord[], nowMs: number, locale: Locale, style: CliTableStyle): string {
  const ids = records.map(record => record.request.approvalId);
  return renderCliTable([{ header: t('cli.approval.column.id', {}, locale) }, { header: t('cli.approval.column.state', {}, locale) },
    { header: t('cli.approval.column.what', {}, locale), shrink: true }, { header: t('cli.approval.column.summary', {}, locale), shrink: true },
    { header: t('cli.approval.column.requester', {}, locale), shrink: true }],
  records.map(record => [displayId(record.request.approvalId, ids), approvalState(record, nowMs, locale), approvalWhat(record, locale), record.request.summary, actor(record)]), style);
}

/** One record as readable lines (inspect, decide and renew results, and the TTY card body): never a hash or a raw id beyond the approval's own. */
export function approvalLines(record: ApprovalRecord, nowMs: number, locale: Locale, verbose = false): readonly string[] {
  const facts = approvalFacts(record.request), unset = t('cli.approval.notDeclared', {}, locale);
  const risk = facts?.risk ? (facts.risk.source === 'cell' ? facts.risk.cell : `${facts.risk.effectClass}${facts.risk.authority ? ' · authority' : ''}`) : unset;
  const undo = facts?.reversibility ? (facts.reversibility.kind === 'compensation' ? `${facts.reversibility.operation.id}@${facts.reversibility.operation.version}` : facts.reversibility.kind) : unset;
  const decision = record.decision, decider = decision ? approvalDecisionClass(decision) : null;
  return Object.freeze([
    t('cli.approval.line.head', { id: terminalSafeText(record.request.approvalId), state: approvalState(record, nowMs, locale) }, locale),
    t('cli.approval.line.what', { what: approvalWhat(record, locale) }, locale),
    t('cli.approval.line.summary', { summary: safeCell(record.request.summary) }, locale),
    t('cli.approval.line.requester', { requester: actor(record), scope: terminalSafeText(record.request.scopeId), at: formatClock(record.request.createdAt, locale) }, locale),
    t('cli.approval.line.risk', { risk: terminalSafeText(risk), undo: terminalSafeText(undo) }, locale),
    ...(onHardFloor(record) ? [t('cli.approval.line.floor', {}, locale)] : []),
    ...(decision ? [t('cli.approval.line.decision', { decision: decision.decision === 'allow' ? t('cli.approval.decision.allow', {}, locale) : t('cli.approval.decision.deny', {}, locale),
      decider: deciderText(decider, locale), at: formatClock(decision.decidedAt, locale), reason: safeCell(decision.reason) }, locale)] : []),
    ...(verbose ? [t('cli.approval.line.verbose', { revision: record.revision, digest: record.request.actionDigest, policy: terminalSafeText(record.request.policyRevision) }, locale)] : []),
  ]);
}
