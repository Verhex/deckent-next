import { sameAttemptIdentity, readWorkerFinalReport, summarizeWorkerEvents, workerEventSchema } from '#domain/index.js';
import { redactSensitive, terminalSafeText } from '#platform/index.js';
import { parseRetainedOutputEnvelope, summarizeMonitorEvent, workspacePatchSchema, type MonitorWorkerContent } from '#engine/index.js';
import type { FileArtifactStore } from '#adapters/core/file-artifacts/index.js';
import type { MonitorAttemptFiles } from './reader.js';

/** H1 bounds are display limits, not worker or product capacity ceilings. All reads follow the caller's read-output gate. */
import limits from './display-limits.json' with { type: 'json' };
const { maxArtifactBytes: MAX_BYTES, maxExcerpts: MAX_EXCERPTS, maxFiles: MAX_FILES } = limits;
const scrub = (text: string) => redactSensitive(terminalSafeText(text));
type ArtifactContent = Partial<MonitorWorkerContent>;
const cache = new Map<string, ArtifactContent>();
/** Only successful, already-scrubbed projections are retained. Copies isolate callers without re-reading or re-parsing artifact bytes. */
async function readArtifact(files: MonitorAttemptFiles, namespace: string, kind: 'events' | 'patch' | 'output', read: () => Promise<ArtifactContent>): Promise<ArtifactContent> {
  const receipt = files[kind]!, id = files.identity;
  const key = files.finished && files.sealed && !files.open ? JSON.stringify([namespace, kind,
    id.scopeId, id.runId, id.taskId, id.attemptId, id.layoutRevision, id.generation,
    receipt.schemaVersion, receipt.scopeId, receipt.digest, receipt.byteLength]) : undefined;
  const known = key === undefined ? undefined : cache.get(key);
  if (known && key !== undefined) {
    cache.delete(key); cache.set(key, known); // Promote this artifact to the LRU tail.
    return structuredClone(known);
  }
  const content = await read();
  if (key !== undefined && content.transcript?.state !== 'unavailable' && content.patch?.state !== 'unavailable' && content.finalReport?.status !== 'unavailable') {
    cache.delete(key);
    if (cache.size >= limits.maxCachedArtifacts) cache.delete(cache.keys().next().value!);
    cache.set(key, structuredClone(content));
  }
  return content;
}

export const emptyWorkerContent = (state: 'missing' | 'denied' | 'unavailable'): MonitorWorkerContent => ({
  transcript: { state, excerpt: [], truncated: false }, patch: { state, files: [], fileCount: null, truncated: false, baseCommit: null }, finalReport: null,
});
/** Only a retained, identity-bound artifact proves a patch/result. The caller gates every read, including hits, through read-output.
 * Production namespaces identify the installation's artifact root and read budget. Sealed reports remain claims, not evaluation. */
export async function readMonitorWorkerContent(artifacts: ReturnType<typeof FileArtifactStore.reader>, files: MonitorAttemptFiles, namespace = ''): Promise<MonitorWorkerContent> {
  const result: { -readonly [K in keyof MonitorWorkerContent]: MonitorWorkerContent[K] } = { ...emptyWorkerContent('missing') };
  const eventsReceipt = files.events, patchReceipt = files.patch, outputReceipt = files.output;
  if (eventsReceipt) {
    try {
      Object.assign(result, await readArtifact(files, namespace, 'events', async () => {
        if (eventsReceipt.byteLength > MAX_BYTES) throw new Error();
        const events = new TextDecoder('utf-8', { fatal: true }).decode(await artifacts.read(files.identity.scopeId, eventsReceipt))
          .split('\n').filter(Boolean).map(line => workerEventSchema.parse(JSON.parse(line)));
        const transcript = { state: 'sealed' as const, excerpt: events.slice(-MAX_EXCERPTS).map(event => { const item = summarizeMonitorEvent(event); return { ...item, summary: scrub(item.summary) }; }), truncated: events.length > MAX_EXCERPTS };
        const usage = summarizeWorkerEvents(events);
        return { transcript, usage: { ...usage, filesTouched: usage.filesTouched.map(scrub), model: usage.model === null ? null : scrub(usage.model),
          models: usage.models?.map(scrub) ?? null, costBasis: usage.costBasis === null ? null : scrub(usage.costBasis),
          quota: usage.quota.map(value => ({ ...value, window: scrub(value.window) })), modelVerification: usage.modelVerification ? { ...usage.modelVerification, unexpected: usage.modelVerification.unexpected.map(scrub) } : null }, usageEvidence: 'sealed',
          tokenUsageRecorded: usage.tokenUsageRecorded === true };
      }));
    } catch { result.transcript = { state: 'unavailable', excerpt: [], truncated: false }; result.usageEvidence = 'unavailable'; result.tokenUsageRecorded = false; }
  }
  if (patchReceipt) {
    try {
      Object.assign(result, await readArtifact(files, namespace, 'patch', async () => {
        if (patchReceipt.byteLength > MAX_BYTES) throw new Error();
        const patch = workspacePatchSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await artifacts.read(files.identity.scopeId, patchReceipt))));
        if (!sameAttemptIdentity(patch.identity, files.identity)) throw new Error();
        return { patch: { state: 'recorded', files: patch.changes.slice(0, MAX_FILES).map(change => scrub(change.path)), fileCount: patch.changes.length,
          truncated: patch.changes.length > MAX_FILES, baseCommit: patch.baseCommit } };
      }));
    } catch { result.patch = { state: 'unavailable', files: [], fileCount: null, truncated: false, baseCommit: null }; }
  }
  if (outputReceipt) {
    try {
      Object.assign(result, await readArtifact(files, namespace, 'output', async () => {
        if (outputReceipt.byteLength > MAX_BYTES) throw new Error();
        const output = parseRetainedOutputEnvelope(await artifacts.read(files.identity.scopeId, outputReceipt), files.identity);
        const report = readWorkerFinalReport(output.stdout);
        return { finalReport: report.status === 'reported' ? { ...report, report: { ...report.report, summary: scrub(report.report.summary),
          changedFiles: report.report.changedFiles.map(scrub), checks: report.report.checks.map(check => ({ ...check, command: scrub(check.command), ...(check.checkId === undefined ? {} : { checkId: scrub(check.checkId) }) })), openIssues: report.report.openIssues.map(scrub) } } : report };
      }));
    } catch { result.finalReport = { schemaVersion: 1, kind: 'native-worker-report', status: 'unavailable', reason: 'invalid' }; }
  }
  return result;
}
