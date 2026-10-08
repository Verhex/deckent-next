import { SYSTEM_SUMMARY_ENTRY_ID, systemSummaryText } from '#surfaces/core/terminal-window/index.js';
import { WORK_LEDGER_SCHEMA_VERSION, type WorkLedgerEntry } from '#surfaces/core/terminal-ledger/index.js';

/**
 * SLASH-WINDOWS (owner 2026-10-08): the scrollback entry of the ONE system summary line a closed slash window leaves. Every slash surface
 * (information, job, session and mode windows) builds it here; `LedgerEntryRow` renders it through `SystemSummaryLine`, never as the assistant.
 * It lives in terminal-work (not terminal-window) because the entry is a work-ledger record and terminal-window does not depend on terminal-ledger.
 */
export function systemSummaryEntry(text: string, level: 'info' | 'warning' | 'error' = 'info'): WorkLedgerEntry {
  return Object.freeze({ schemaVersion: WORK_LEDGER_SCHEMA_VERSION, kind: 'notice' as const, id: SYSTEM_SUMMARY_ENTRY_ID, level, text: systemSummaryText(text) });
}
