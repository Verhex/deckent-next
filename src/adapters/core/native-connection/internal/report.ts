import { workerReportLimits, type WorkerFinalReportResult } from '#domain/index.js';
import { validateFinalReport as validateBridgeReport } from './worker.js';

type NativeReportResult = Omit<Extract<WorkerFinalReportResult, { status: 'reported' }>, 'schemaVersion' | 'kind'>
  | Omit<Extract<WorkerFinalReportResult, { status: 'unavailable' }>, 'schemaVersion' | 'kind'>;
/** Host test/API entry uses the same limits that the gateway injects into the standalone bootstrap. */
export function validateFinalReport(value: unknown, secrets: readonly string[]): NativeReportResult {
  return validateBridgeReport(value, secrets, workerReportLimits);
}
