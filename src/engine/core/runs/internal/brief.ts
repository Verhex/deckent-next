import { z } from 'zod';
import { readWorkerModelPin, workerModelPinSchema, workerFinalReportResultSchema, type RunSnapshot, type WorkerFinalReportResult } from '#domain/index.js';
import { redactSensitive, terminalSafeText } from '#platform/index.js';
const text = z.string();
const safe = (value: string) => redactSensitive(terminalSafeText(value));
const profileSchema = z.object({ id: text, version: z.number().int().positive() }).strict().readonly();
const contextRefSchema = z.object({ id: text, version: z.number().int().positive(), sha256: text.regex(/^[a-f0-9]{64}$/) }).strict().readonly();
/** Human read projections only. No prompt parsing, live catalog lookup, inferred business purpose or transition authority. */
export const taskBriefSchema = z.object({ schemaVersion: z.literal(1), task: text.nullable(), scopePaths: z.array(text).readonly().nullable(),
  acceptance: text.nullable(), criteria: z.array(z.object({ id: text, description: text, evaluator: profileSchema }).strict().readonly()).readonly(),
  profile: profileSchema.nullable(), model: workerModelPinSchema.nullable(), effort: text.nullable(), contextRefs: z.array(contextRefSchema).readonly(),
}).strict().readonly();
export type TaskBrief = z.infer<typeof taskBriefSchema>;
export const briefEvaluationSchema = z.object({ verdict: z.enum(['accepted', 'accepted-unverified', 'rejected', 'unknown', 'pending']).nullable(),
  reason: z.literal('no-change-produced').optional() }).strict().readonly();
const deliveryReceiptSchema = z.object({ state: z.enum(['integrating', 'integrated', 'delivering', 'delivered', 'adopting', 'adopted', 'rolling-back', 'rolled-back']),
  commit: text.nullable(), commandId: text.nullable().optional(), targetRef: text.nullable().optional(),
}).strict().readonly();
export const briefDeliverySchema = deliveryReceiptSchema.unwrap().extend({ receipts: z.array(deliveryReceiptSchema).readonly().optional() }).strict().readonly();
/** Failed tests of a failed verification attempt, read from its retained output under the read-output decision: the true count and the first names only. */
export const briefFailedTestsSchema = z.object({ count: z.number().int().nonnegative(), names: z.array(text).readonly(), truncated: z.boolean() }).strict().readonly();
/** What a terminal accepted Run still owes its delivery when no integration/delivery/adoption receipt exists: no patch needed, a patch that was never prepared, or a prepared patch awaiting delivery. */
export const briefDeliveryOutlookSchema = z.enum(['none', 'patch-not-prepared', 'awaiting-delivery']);
export const resultBriefSchema = z.object({ schemaVersion: z.literal(1), attemptId: text.nullable(), claimLabel: z.literal('CLAIM'),
  report: workerFinalReportResultSchema.nullable(), evaluation: briefEvaluationSchema,
  /** This receipt belongs to the Run; it does not prove this individual worker patch landed. */
  runDelivery: briefDeliverySchema.nullable(), openIssues: z.array(text).readonly().nullable(),
  failedTests: briefFailedTestsSchema.optional(), deliveryOutlook: briefDeliveryOutlookSchema.optional(),
}).strict().readonly();
export type ResultBrief = z.infer<typeof resultBriefSchema>;
export function projectTaskBrief(run: RunSnapshot, taskId: string): TaskBrief {
  const definition = run.graph.tasks.find(task => task.id === taskId)!;
  const input = definition.workInput, profile = run.execution.tasks.find(task => task.taskId === taskId)?.profile;
  const parameters = profile?.parameters as { nativeSubscription?: { promptDelivery?: { schemaVersion?: number; segments?: unknown[] } } } | undefined;
  const delivery = parameters?.nativeSubscription?.promptDelivery;
  const refs = delivery?.schemaVersion === 1 && Array.isArray(delivery.segments) ? delivery.segments.flatMap(segment => {
    const part = z.object({ kind: z.literal('context'), ...contextRefSchema.unwrap().shape }).passthrough().safeParse(segment);
    return part.success ? [{ id: safe(part.data.id), version: part.data.version, sha256: part.data.sha256 }] : [];
  }) : [];
  const pin = profile ? readWorkerModelPin(profile.parameters)?.pin : null;
  const model = pin ?? input?.model ?? null;
  return taskBriefSchema.parse({ schemaVersion: 1, task: input ? safe(input.task) : null, scopePaths: input?.scope.paths.map(safe) ?? null,
    acceptance: input ? safe(input.acceptance) : null, criteria: run.graph.criterionDefinitions.filter(item => definition.acceptanceCriteria.includes(item.id))
      .map(item => ({ id: safe(item.id), description: safe(item.description), evaluator: { id: safe(item.evaluator.id), version: item.evaluator.version } })),
    profile: profile ? { id: safe(profile.id), version: profile.version } : null,
    model: model ? { channelId: safe(model.channelId), modelId: safe(model.modelId), auxiliaryModelIds: model.auxiliaryModelIds.map(safe) } : null,
    effort: input?.effort ?? null, contextRefs: refs });
}
export function projectResultBrief(attemptId: string | null, evaluation: ResultBrief['evaluation'], report: WorkerFinalReportResult | null = null,
  runDelivery: ResultBrief['runDelivery'] = null, extra: Pick<ResultBrief, 'failedTests' | 'deliveryOutlook'> = {}): ResultBrief {
  // Revalidate and redact all claim leaves, including optional handoff/shared notes. Sealing never promotes these to acceptance.
  const scrub = (value: unknown): unknown => typeof value === 'string' ? safe(value) : Array.isArray(value) ? value.map(scrub)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, leaf]) => [key, scrub(leaf)])) : value;
  const claim = report ? workerFinalReportResultSchema.parse(scrub(report)) : null;
  return resultBriefSchema.parse({ schemaVersion: 1, attemptId, claimLabel: 'CLAIM', report: claim, evaluation,
    runDelivery: runDelivery ? scrub(runDelivery) : null, openIssues: claim?.status === 'reported' ? claim.report.openIssues : null,
    ...(extra.failedTests ? { failedTests: scrub(extra.failedTests) } : {}), ...(extra.deliveryOutlook ? { deliveryOutlook: extra.deliveryOutlook } : {}) });
}
