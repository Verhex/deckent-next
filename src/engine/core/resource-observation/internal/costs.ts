import { sameAttemptIdentity, deriveAcceptanceView, readWorkerModelPin, summarizeWorkerEvents, summarizeWorkCosts, workCostSchema,
  type RunSnapshot, type AttemptIdentity, type VerifiedPrincipal, type DeckentMetrics, type WorkerEvent, type WorkerEventSummary, type WorkCost } from '#domain/index.js';
import type { ResourceView } from './contract.js';
import { recommendRunWorkCosts } from './recommendations.js';
export interface WorkCostDispatch { readonly request: { readonly identity: AttemptIdentity };
  readonly terminal: { readonly container?: { readonly startedAt: string | null; readonly finishedAt: string | null } | undefined } | null }
export interface WorkCostEvidence {
  readonly comparison?: { readonly registry: unknown; readonly policy: import('#domain/index.js').CostRecommendationPolicy };
  readComparisons?(run: RunSnapshot): Promise<readonly import('#domain/index.js').CostComparisonTrial[]>;
  readResources(identity: AttemptIdentity): Promise<ResourceView>;
  readDispatch(identity: AttemptIdentity): Promise<WorkCostDispatch | null>;
  readMetrics?(run: RunSnapshot): Promise<readonly DeckentMetrics[]>;
  readEvents?(identity: AttemptIdentity): Promise<readonly WorkerEvent[] | null>;
  now(): number;
}
/** Canonical Run/evaluation and exact dispatch join. No worker-reported money is promoted to a measured API charge. */
export function projectAttemptWorkCost(run: RunSnapshot, identity: AttemptIdentity, resources: ResourceView,
  dispatch: WorkCostDispatch | null, metric: DeckentMetrics | undefined, evaluation: unknown, usage: WorkerEventSummary | null): WorkCost {
  if (!run.bindings.some(binding => sameAttemptIdentity(binding.identity, identity)) || (dispatch && !sameAttemptIdentity(dispatch.request.identity, identity))) throw new Error('WORK_COST_IDENTITY');
  const selected = run.execution.tasks.find(row => row.taskId === identity.taskId)!, profile = selected.profile;
  const pin = readWorkerModelPin(profile.parameters);
  const start = dispatch?.terminal?.container?.startedAt, end = dispatch?.terminal?.container?.finishedAt;
  const wallMs = start && end && Date.parse(end) > Date.parse(start) ? Date.parse(end) - Date.parse(start) : null;
  const matchingMetric = metric?.identity.scopeId === identity.scopeId && metric.identity.runId === identity.runId
    && metric.identity.taskId === identity.taskId && metric.identity.attemptId === identity.attemptId ? metric : undefined;
  const subscription = profile.parameters['nativeSubscription'] !== undefined;
  return workCostSchema.parse({ schemaVersion: 1, identity, profile: { id: profile.id, version: profile.version },
    model: pin ? { channelId: pin.pin.channelId, modelId: pin.pin.modelId, evidence: 'requested' } : null,
    effort: pin?.reasoningEffort?.level ?? null, acceptance: deriveAcceptanceView(run, identity.taskId, evaluation),
    axes: { cpuSeconds: resources.cpuSeconds, sampledPeakBytes: resources.sampledPeakBytes, kernelPeakBytes: resources.latest?.kernelPeakBytes ?? null,
      wallMs, apiMoney: matchingMetric?.cost ?? null,
      subscription: subscription ? { calls: null, durationMs: usage?.durationMs ?? null, limit: null } : null,
      localModel: null, humanInterventions: null },
    quality: { reworkCount: null,
      rollbackCount: null, interventionCount: null, followup: 'unknown' }, coverage: 'partial', sampleCount: resources.sampleCount, gapCount: resources.gapCount });
}
/** Uses the same per-attempt authority for values and aggregates; never reads denied worker evidence. */
export async function inspectRunWorkCosts(run: RunSnapshot, evaluations: readonly Readonly<{ identity: { taskId: string } }>[], principal: VerifiedPrincipal,
  evidence: WorkCostEvidence, authorize: (identity: AttemptIdentity, principal: VerifiedPrincipal) => Promise<void>) {
  const attempts: WorkCost[] = []; let withheld = 0;
  const permitted: AttemptIdentity[] = [];
  for (const binding of run.bindings) {
    try { await authorize(binding.identity, principal); permitted.push(binding.identity); } catch { withheld++; }
  }
  // Metric rows contain output-derived values too. Read only when every bound producer is permitted.
  const metrics = withheld ? [] : await evidence.readMetrics?.(run).catch(() => []) ?? [];
  for (const identity of permitted) {
    try {
      const events = await evidence.readEvents?.(identity).catch(() => null) ?? null;
      attempts.push(projectAttemptWorkCost(run, identity, await evidence.readResources(identity), await evidence.readDispatch(identity),
        metrics.find(row => row.identity.attemptId === identity.attemptId && row.outcome.kind === 'task'),
        evaluations.find(row => row.identity.taskId === identity.taskId), events ? summarizeWorkerEvents(events) : null));
    } catch { withheld++; }
  }
  const report = summarizeWorkCosts({ scopeId: run.identity.scopeId, runId: run.identity.runId, runRevision: run.revision, observedAtMs: evidence.now(), attempts, withheld });
  if (!evidence.comparison) return report;
  const trials = withheld ? [] : await evidence.readComparisons?.(run).catch(() => []) ?? [];
  return recommendRunWorkCosts(report, evidence.comparison.registry, evidence.comparison.policy, trials);
}
