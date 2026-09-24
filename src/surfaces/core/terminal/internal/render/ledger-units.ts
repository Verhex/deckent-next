import { WORK_LEDGER_SCHEMA_VERSION, type WorkLedgerEntry } from '../work-ledger.js';
import type { AssistantStreamStep, AssistantUnit } from './assistant-stream.js';

/** Finished assistant units as append-only ledger rows (kind `chat`, so the Desktop bridge keeps excluding them). */
export function assistantLedgerEntries(units: readonly AssistantUnit[]): WorkLedgerEntry[] {
  return units.map(unit => Object.freeze({ schemaVersion: WORK_LEDGER_SCHEMA_VERSION, kind: 'chat' as const, id: 'chat', role: 'assistant' as const,
    text: 'markdown' in unit ? unit.markdown : '', assistant: unit }));
}

/** Everything one streaming step finished, footer last: what the workline appends to `Static` for that delta. */
export function streamStepEntries(step: AssistantStreamStep): WorkLedgerEntry[] {
  return assistantLedgerEntries(step.footer ? [...step.staticUnits, step.footer] : step.staticUnits);
}
