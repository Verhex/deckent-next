import { notice, type WorkLedgerEntry } from '#surfaces/core/terminal-ledger/index.js';

/**
 * SLASH-WINDOWS (owner 2026-10-08): the one framed, labelled system line a closed slash window may leave in the scrollback.
 * PLACEHOLDER (lane SW-3): lane SW-1 builds the shared `SystemSummaryLine`; until the lead swaps this helper at integration it is an
 * info notice, so every call site is already the single place a slash command writes to the chat stream.
 */
export function systemSummaryLine(text: string): WorkLedgerEntry {
  return notice('info', text);
}
