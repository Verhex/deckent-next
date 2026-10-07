import { WORK_LEDGER_SCHEMA_VERSION, type WorkLedgerNoticeEntry } from '#surfaces/core/terminal-ledger/index.js';
/** Display strings only; approval identity/revision/capability and authority DTOs remain in their original closure. */
export type ApprovalRowPresentation = Readonly<{ kind: 'approval-row'; rowNumber: number; summary: string; displayId: string; displayRun: string; displayTask: string; itemTemplate: string; durationText: string }>;
export type ApprovalDecisionNoticePresentation = ApprovalRowPresentation | Readonly<{ kind: 'approval-not-found'; ref: string; notFoundTemplate: string }>;
const presentations = new WeakMap<WorkLedgerNoticeEntry, ApprovalDecisionNoticePresentation>();
function attach(level: 'info' | 'error', fallbackText: string, raw: ApprovalDecisionNoticePresentation): WorkLedgerNoticeEntry {
  // Public shape stays v1 and contains catalog text only. Losing identity through JSON/spread is a safe placeholder.
  const entry: WorkLedgerNoticeEntry = Object.freeze({ schemaVersion: WORK_LEDGER_SCHEMA_VERSION, kind: 'notice', id: 'notice', level, text: fallbackText });
  presentations.set(entry, Object.freeze({ ...raw })); return entry;
}
/** Internal terminal factories copy only complete presentation fields, never an executable operation or capability. */
export function makeApprovalRowNotice(raw: Omit<ApprovalRowPresentation, 'kind'>, fallbackText: string): WorkLedgerNoticeEntry {
  return attach('info', fallbackText, { kind: 'approval-row', rowNumber: raw.rowNumber, summary: raw.summary,
    displayId: raw.displayId, displayRun: raw.displayRun, displayTask: raw.displayTask, itemTemplate: raw.itemTemplate, durationText: raw.durationText });
}
export function makeApprovalNotFoundNotice(ref: string, notFoundTemplate: string, fallbackText: string): WorkLedgerNoticeEntry { return attach('error', fallbackText, { kind: 'approval-not-found', ref, notFoundTemplate }); }
/** Internal identity lookup; deliberately absent from public barrels, JSON and persistence contracts. */
export function readApprovalDecisionNotice(entry: WorkLedgerNoticeEntry): ApprovalDecisionNoticePresentation | null { return presentations.get(entry) ?? null; }
