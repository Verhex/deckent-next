import { DELIVERY_SUMMARY_ACTIONS, deliverySummarySchema, type DeliverySummary } from '#engine/index.js';

/** One readable DeliverySummary v1 (TESLIM-KARTI-OZET) for surface tests; `patch` replaces whole sections. */
export const SUMMARY_IDENTITY = Object.freeze({ scopeId: 's', runId: 'run-1', layoutRevision: 'layout-1', taskId: 'task-1', attemptId: 'attempt-1', generation: 1 });
export function deliverySummaryFixture(patch: Partial<DeliverySummary> = {}): DeliverySummary {
  const evidence = { evaluator: { id: 'process-exit', version: 1 }, kind: 'exit-code', independent: false } as const;
  return deliverySummarySchema.parse({ schemaVersion: 1, operation: 'adopt', subject: SUMMARY_IDENTITY, target: { state: 'available', id: 'refs/heads/integration', protected: false },
    title: { source: 'work-input', text: 'Login banner fix' }, outcome: { state: 'available', claim: true, summary: 'Banner fixed.', truncated: false },
    acceptance: { verdict: 'accepted', criteriaCount: 2, evidence: [evidence] },
    tests: { worker: { state: 'available', claim: true, passed: 2, failed: 0, notRun: 0, unknown: 0 },
      verification: { state: 'available', runId: 'queue-verify-1', phase: 'accepted', evidence: [evidence] } },
    model: { state: 'available', requested: { channelId: 'channel', modelId: 'model-x' }, verdict: 'verified' },
    risk: { class: 'small', workClass: 'small', protectedTarget: false, sizeBucket: 'tiny', flags: ['evidence-not-independent'] },
    actions: DELIVERY_SUMMARY_ACTIONS.adopt,
    change: { state: 'available', adapter: 'workspace-patch', files: 2, added: 10, removed: 2, topPaths: ['src/a.ts', 'src/b.ts'], topPathsOmitted: 0, scope: 'in-scope', outOfScope: [], outOfScopeCount: 0 },
    ...patch });
}
