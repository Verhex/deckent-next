import { workerReportLimits, type WorkerFinalReportResult } from '#domain/index.js';
import { createFinalReportJsonSchema, dropTransportNulls, validateFinalReport as validateBridgeReport } from './worker.js';

type NativeReportResult = Omit<Extract<WorkerFinalReportResult, { status: 'reported' }>, 'schemaVersion' | 'kind'>
  | Omit<Extract<WorkerFinalReportResult, { status: 'unavailable' }>, 'schemaVersion' | 'kind'>;
/** Host test/API entry uses the same limits that the gateway injects into the standalone bootstrap. */
export function validateFinalReport(value: unknown, secrets: readonly string[]): NativeReportResult {
  return validateBridgeReport(value, secrets, workerReportLimits);
}
/** U9-7: the strict report schema the native `schema-file` channel hands the CLI, for a host-side client (the SIWC relay's `turn/start`). */
export const finalReportJsonSchema = () => createFinalReportJsonSchema(workerReportLimits, true);
/** U9-7: a strict-schema final answer text read as the native Codex reader reads it (transport nulls dropped, then the same validation). */
export function readFinalReportText(text: string | null, secrets: readonly string[]): NativeReportResult {
  if (text === null) return { status: 'unavailable', reason: 'missing' };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { status: 'unavailable', reason: 'invalid' }; }
  dropTransportNulls(value);
  return validateFinalReport(value, secrets);
}
