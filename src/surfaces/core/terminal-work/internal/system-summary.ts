import { WORK_LEDGER_SCHEMA_VERSION, type WorkLedgerEntry } from '#surfaces/core/terminal-ledger/index.js';

/** Temporary SW-2 system-line seam; the lead unifies it with SW-1 at integration. */
export function systemSummaryLine(text: string): WorkLedgerEntry {
  return Object.freeze({ schemaVersion: WORK_LEDGER_SCHEMA_VERSION, kind: 'notice', id: 'system-summary', level: 'info', text: text.replace(/\s+/gu, ' ').trim() });
}
