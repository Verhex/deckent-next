import { sameAttemptIdentity, readWorkerFinalReport, summarizeWorkerEvents, workerEventSchema } from '#domain/index.js';
import { redactSensitive, terminalSafeText } from '#platform/index.js';
import { parseRetainedOutputEnvelope, summarizeMonitorEvent, workspacePatchSchema, type MonitorWorkerContent } from '#engine/index.js';
import type { FileArtifactStore } from '#adapters/core/file-artifacts/index.js';
import type { MonitorAttemptFiles } from './reader.js';

/** H1 bounds are display limits, not worker or product capacity ceilings. All reads follow the caller's read-output gate. */
import limits from './display-limits.json' with { type: 'json' };
const { maxArtifactBytes: MAX_BYTES, maxExcerpts: MAX_EXCERPTS, maxFiles: MAX_FILES } = limits;
const scrub = (text: string) => redactSensitive(terminalSafeText(text));

export const emptyWorkerContent = (state: 'missing' | 'denied' | 'unavailable'): MonitorWorkerContent => ({
  transcript: { state, excerpt: [], truncated: false }, patch: { state, files: [], fileCount: null, truncated: false, baseCommit: null }, finalReport: null,
});
/** Only a retained, identity-bound artifact proves a patch/result. Sealed worker reports remain claims, independent of evaluation. */
export async function readMonitorWorkerContent(artifacts: ReturnType<typeof FileArtifactStore.reader>, files: MonitorAttemptFiles): Promise<MonitorWorkerContent> {
  const result: { -readonly [K in keyof MonitorWorkerContent]: MonitorWorkerContent[K] } = { ...emptyWorkerContent('missing') };
  if (files.events) {
    try {
      if (files.events.byteLength > MAX_BYTES) throw new Error();
      const events = new TextDecoder('utf-8', { fatal: true }).decode(await artifacts.read(files.identity.scopeId, files.events))
        .split('\n').filter(Boolean).map(line => workerEventSchema.parse(JSON.parse(line)));
      result.transcript = { state: 'sealed', excerpt: events.slice(-MAX_EXCERPTS).map(event => { const item = summarizeMonitorEvent(event); return { ...item, summary: scrub(item.summary) }; }), truncated: events.length > MAX_EXCERPTS };
      const usage = summarizeWorkerEvents(events);
      result.usage = { ...usage, filesTouched: usage.filesTouched.map(scrub), model: usage.model === null ? null : scrub(usage.model),
        models: usage.models?.map(scrub) ?? null, costBasis: usage.costBasis === null ? null : scrub(usage.costBasis),
        quota: usage.quota.map(value => ({ ...value, window: scrub(value.window) })), modelVerification: usage.modelVerification ? { ...usage.modelVerification, unexpected: usage.modelVerification.unexpected.map(scrub) } : null }; result.usageEvidence = 'sealed';
      result.tokenUsageRecorded = usage.tokenUsageRecorded === true;
    } catch { result.transcript = { state: 'unavailable', excerpt: [], truncated: false }; result.usageEvidence = 'unavailable'; result.tokenUsageRecorded = false; }
  }
  if (files.patch) {
    try {
      if (files.patch.byteLength > MAX_BYTES) throw new Error();
      const patch = workspacePatchSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await artifacts.read(files.identity.scopeId, files.patch))));
      if (!sameAttemptIdentity(patch.identity, files.identity)) throw new Error();
      result.patch = { state: 'recorded', files: patch.changes.slice(0, MAX_FILES).map(change => scrub(change.path)), fileCount: patch.changes.length,
        truncated: patch.changes.length > MAX_FILES, baseCommit: patch.baseCommit };
    } catch { result.patch = { state: 'unavailable', files: [], fileCount: null, truncated: false, baseCommit: null }; }
  }
  if (files.output) {
    try {
      if (files.output.byteLength > MAX_BYTES) throw new Error();
      const output = parseRetainedOutputEnvelope(await artifacts.read(files.identity.scopeId, files.output), files.identity);
      const report = readWorkerFinalReport(output.stdout);
      result.finalReport = report.status === 'reported' ? { ...report, report: { ...report.report, summary: scrub(report.report.summary),
        changedFiles: report.report.changedFiles.map(scrub), checks: report.report.checks.map(check => ({ ...check, command: scrub(check.command) })), openIssues: report.report.openIssues.map(scrub) } } : report;
    } catch { result.finalReport = { schemaVersion: 1, kind: 'native-worker-report', status: 'unavailable', reason: 'invalid' }; }
  }
  return result;
}
