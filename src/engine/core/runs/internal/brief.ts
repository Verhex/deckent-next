import { persistedInteger, readWorkerModelPin, workerModelPinSchema, workerFinalReportResultSchema, TASK_NOT_ACCEPTED_REASONS, type RunSnapshot, type WorkerFinalReportResult } from '#domain/index.js';
import { redactSensitive, terminalSafeText } from '#platform/index.js';
import { z } from 'zod';

const text = z.string();
const safe = (value: string) => redactSensitive(terminalSafeText(value));
const profileSchema = z.strictObject({ id: text, version: persistedInteger().positive() }).readonly();
const contextRefSchema = z.strictObject({ id: text, version: persistedInteger().positive(), sha256: text.regex(/^[a-f0-9]{64}$/) }).readonly();
/** Human read projections only. No prompt parsing, live catalog lookup, inferred business purpose or transition authority. */
/** `title`: the Brain-authored work-input title (M1, ≤240 bytes), present only when the task carries one; the strip and windows prefer it. */
export const taskBriefSchema = z.strictObject({ schemaVersion: z.literal(1), task: text.nullable(), title: text.optional(), scopePaths: z.array(text).readonly().nullable(),
  acceptance: text.nullable(), criteria: z.array(z.strictObject({ id: text, description: text, evaluator: profileSchema }).readonly()).readonly(),
  profile: profileSchema.nullable(), model: workerModelPinSchema.nullable(), effort: text.nullable(), contextRefs: z.array(contextRefSchema).readonly(),
}).readonly();
export type TaskBrief = z.infer<typeof taskBriefSchema>;
export const briefEvaluationSchema = z.strictObject({ verdict: z.enum(['accepted', 'accepted-unverified', 'rejected', 'unknown', 'pending']).nullable(),
  reason: z.enum(TASK_NOT_ACCEPTED_REASONS).optional() }).readonly();
const deliveryReceiptFields = { state: z.enum(['integrating', 'integrated', 'delivering', 'delivered', 'adopting', 'adopted', 'rolling-back', 'rolled-back']),
  commit: text.nullable(), commandId: text.nullable().optional(), targetRef: text.nullable().optional() };
const deliveryModes = { schemaVersion: z.literal(2), application: z.enum(['working-tree', 'reference-only']) }; // Alpha.64 writes v2 when the Run's retained source proves its mode.
const deliveryReceipts = [z.strictObject(deliveryReceiptFields), z.strictObject({ ...deliveryReceiptFields, ...deliveryModes })] as const;
const history = { receipts: z.array(z.union(deliveryReceipts).readonly()).readonly().optional() };
export const briefDeliverySchema = z.union([deliveryReceipts[0].extend(history), deliveryReceipts[1].extend(history)]).readonly();
/** Failed tests of a failed verification attempt, read from its retained output under the read-output decision: the true count and the first names only. */
export const briefFailedTestsSchema = z.strictObject({ count: persistedInteger().nonnegative(), names: z.array(text).readonly(), truncated: z.boolean() }).readonly();
/** What a terminal accepted Run still owes its delivery when no integration/delivery/adoption receipt exists: no patch needed, a patch that was never prepared, or a prepared patch awaiting delivery. */
export const briefDeliveryOutlookSchema = z.enum(['none', 'patch-not-prepared', 'awaiting-delivery']);
export const resultBriefSchema = z.strictObject({ schemaVersion: z.literal(1), attemptId: text.nullable(), claimLabel: z.literal('CLAIM'),
  report: workerFinalReportResultSchema.nullable(), evaluation: briefEvaluationSchema,
  /** This receipt belongs to the Run; it does not prove this individual worker patch landed. */
  runDelivery: briefDeliverySchema.nullable(), openIssues: z.array(text).readonly().nullable(),
  failedTests: briefFailedTestsSchema.optional(), deliveryOutlook: briefDeliveryOutlookSchema.optional(),
  /** BeUser M-33 (additive; the outlook keeps its wire values): a person set this awaiting patch aside, or the set-aside records could not be read (typed code). */
  setAside: z.literal(true).optional(), dismissalUnread: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u).optional(),
}).readonly();
export type ResultBrief = z.infer<typeof resultBriefSchema>;
export function projectTaskBrief(run: RunSnapshot, taskId: string): TaskBrief {
  const definition = run.graph.tasks.find(task => task.id === taskId)!, input = definition.workInput, profile = run.execution.tasks.find(task => task.taskId === taskId)?.profile;
  const delivery = (profile?.parameters as { nativeSubscription?: { promptDelivery?: { schemaVersion?: number; segments?: unknown[] } } } | undefined)?.nativeSubscription?.promptDelivery;
  const refs = delivery?.schemaVersion === 1 && Array.isArray(delivery.segments) ? delivery.segments.flatMap(segment => {
    const part = z.looseObject({ kind: z.literal('context'), ...contextRefSchema.unwrap().shape }).safeParse(segment);
    return part.success ? [{ id: safe(part.data.id), version: part.data.version, sha256: part.data.sha256 }] : [];
  }) : [];
  const pin = profile ? readWorkerModelPin(profile.parameters)?.pin : null;
  const model = pin ?? input?.model ?? null;
  return taskBriefSchema.parse({ schemaVersion: 1, task: input ? safe(input.task) : null, ...(input?.title ? { title: safe(input.title) } : {}), scopePaths: input?.scope.paths.map(safe) ?? null,
    acceptance: input ? safe(input.acceptance) : null, criteria: run.graph.criterionDefinitions.filter(item => definition.acceptanceCriteria.includes(item.id))
      .map(item => ({ id: safe(item.id), description: safe(item.description), evaluator: { id: safe(item.evaluator.id), version: item.evaluator.version } })),
    profile: profile ? { id: safe(profile.id), version: profile.version } : null,
    model: model ? { channelId: safe(model.channelId), modelId: safe(model.modelId), auxiliaryModelIds: model.auxiliaryModelIds.map(safe) } : null,
    effort: input?.effort ?? null, contextRefs: refs });
}
export function projectResultBrief(attemptId: string | null, evaluation: ResultBrief['evaluation'], report: WorkerFinalReportResult | null = null,
  runDelivery: ResultBrief['runDelivery'] = null, extra: Pick<ResultBrief, 'failedTests' | 'deliveryOutlook' | 'setAside' | 'dismissalUnread'> = {}): ResultBrief {
  // Revalidate and redact all claim leaves, including optional handoff/shared notes. Sealing never promotes these to acceptance.
  const scrub = (value: unknown): unknown => typeof value === 'string' ? safe(value) : Array.isArray(value) ? value.map(scrub)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, leaf]) => [key, scrub(leaf)])) : value;
  const claim = report ? workerFinalReportResultSchema.parse(scrub(report)) : null;
  return resultBriefSchema.parse({ schemaVersion: 1, attemptId, claimLabel: 'CLAIM', report: claim, evaluation,
    runDelivery: runDelivery ? scrub(runDelivery) : null, openIssues: claim?.status === 'reported' ? claim.report.openIssues : null,
    ...extra, ...(extra.failedTests ? { failedTests: scrub(extra.failedTests) } : {}) });
}
