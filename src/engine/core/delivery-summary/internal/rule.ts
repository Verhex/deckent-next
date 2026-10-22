import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import ruleAsset from '../../../../../assets/delivery-summary/autonomy-1.json' with { type: 'json' };
import { DELIVERY_RISK_DATA, type DeliveryRiskData } from './projector.js';
import { deliveryModelVerdictSchema, deliverySummaryOperationSchema, deliveryVerificationPhaseSchema, type DeliverySummary } from './contract.js';

/**
 * Rule `autonomy@1` (OTONOM-TESLIM D1-lite shadow, owner Q1 2026-10-23). Thresholds and the eligible model verdicts are versioned rule DATA
 * (asset), never code. The result is advice for a shadow record only: it never delivers, adopts, blocks or changes a consent card.
 */
export const autonomyRuleDataSchema = z.object({ schemaVersion: z.literal(1), rule: z.object({ id: identitySchema, version: z.number().int().positive().safe() }).strict().readonly(),
  operations: z.array(deliverySummaryOperationSchema).readonly(), riskClasses: z.array(z.enum(['small', 'other'])).readonly(),
  acceptanceVerdicts: z.array(z.enum(['accepted', 'accepted-unverified'])).readonly(), verificationPhases: z.array(deliveryVerificationPhaseSchema).readonly(),
  modelVerdicts: z.array(deliveryModelVerdictSchema).readonly(), maxSizeBucket: identitySchema, maxOutOfScope: z.number().int().nonnegative().safe(),
  requireDeclaredScope: z.boolean() }).strict().readonly();
export type AutonomyRuleData = z.infer<typeof autonomyRuleDataSchema>;
export const AUTONOMY_RULE: AutonomyRuleData = autonomyRuleDataSchema.parse(ruleAsset);

/** Generic facts the rule reads (no git or vendor term): any adapter's summary yields them. `null` = evidence absent; `withheld` = not readable. */
export type AutonomyFacts = Readonly<{
  operation: DeliverySummary['operation']; targetProtected: boolean | null; acceptanceVerdict: DeliverySummary['acceptance']['verdict'];
  verificationPhase: z.infer<typeof deliveryVerificationPhaseSchema> | 'withheld' | null;
  modelVerdict: z.infer<typeof deliveryModelVerdictSchema> | 'withheld' | null;
  riskClass: DeliverySummary['risk']['class']; sizeBucket: string | null;
  scope: 'in-scope' | 'out-of-scope' | 'unscoped' | 'withheld' | null; outOfScopeCount: number | null;
}>;
export const AUTONOMY_HOLD_REASONS = ['operation-not-eligible', 'target-protected', 'target-unknown', 'acceptance-not-eligible', 'verification-missing',
  'verification-not-accepted', 'model-verdict-missing', 'model-verdict-not-eligible', 'risk-class-not-eligible', 'size-unknown', 'size-over-bound',
  'scope-undeclared', 'out-of-scope-changes', 'evidence-withheld'] as const;
export type AutonomyHoldReason = typeof AUTONOMY_HOLD_REASONS[number];
export type AutonomyEvaluation = Readonly<{ rule: Readonly<{ id: string; version: number; digest: string }>; verdict: 'would-deliver' | 'would-hold';
  reasons: readonly AutonomyHoldReason[] }>;

/** The rule facts of one summary, so the shadow record and the card evaluate the same envelope. */
export function autonomyFacts(summary: DeliverySummary): AutonomyFacts {
  const { verification } = summary.tests, change = summary.change;
  return Object.freeze({ operation: summary.operation, targetProtected: summary.target.state === 'available' ? summary.target.protected : null,
    acceptanceVerdict: summary.acceptance.verdict, verificationPhase: verification.state === 'available' ? verification.phase : verification.state === 'withheld' ? 'withheld' : null,
    modelVerdict: summary.model.state === 'available' ? summary.model.verdict : summary.model.state === 'withheld' ? 'withheld' : null,
    riskClass: summary.risk.class, sizeBucket: summary.risk.sizeBucket,
    scope: change.state === 'available' ? change.scope : change.state === 'withheld' ? 'withheld' : null,
    outOfScopeCount: change.state === 'available' ? change.outOfScopeCount : null });
}
/** Sorted-key JSON: digests over it do not depend on property order. */
export const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);
/** Digest of the exact rule and risk data an evaluation used: a shadow record binds it, so a later data change is visible. */
export function autonomyRuleDigest(rule: AutonomyRuleData = AUTONOMY_RULE, risk: DeliveryRiskData = DELIVERY_RISK_DATA): string {
  return createHash('sha256').update(canonical({ rule, risk })).digest('hex');
}

/** Pure, deterministic: every unmet condition is a typed reason; `would-deliver` only when none remains. Withheld evidence always holds. */
export function evaluateAutonomy(facts: AutonomyFacts, rule: AutonomyRuleData = AUTONOMY_RULE, risk: DeliveryRiskData = DELIVERY_RISK_DATA): AutonomyEvaluation {
  const reasons: AutonomyHoldReason[] = [], hold = (reason: AutonomyHoldReason) => { if (!reasons.includes(reason)) reasons.push(reason); };
  if (!rule.operations.includes(facts.operation)) hold('operation-not-eligible');
  if (facts.targetProtected === true) hold('target-protected'); else if (facts.targetProtected === null) hold('target-unknown');
  if (!(rule.acceptanceVerdicts as readonly string[]).includes(facts.acceptanceVerdict)) hold('acceptance-not-eligible');
  if (facts.verificationPhase === 'withheld') hold('evidence-withheld');
  else if (facts.verificationPhase === null) hold('verification-missing');
  else if (!rule.verificationPhases.includes(facts.verificationPhase)) hold('verification-not-accepted');
  if (facts.modelVerdict === 'withheld') hold('evidence-withheld');
  else if (facts.modelVerdict === null) hold('model-verdict-missing');
  else if (!rule.modelVerdicts.includes(facts.modelVerdict)) hold('model-verdict-not-eligible');
  if (!rule.riskClasses.includes(facts.riskClass)) hold('risk-class-not-eligible');
  const order = [...risk.sizeBuckets.map(row => row.id), risk.overflowBucket], bound = order.indexOf(rule.maxSizeBucket), size = facts.sizeBucket === null ? -1 : order.indexOf(facts.sizeBucket);
  if (size < 0) hold('size-unknown'); else if (bound < 0 || size > bound) hold('size-over-bound');
  if (facts.scope === 'withheld') hold('evidence-withheld');
  else if (facts.scope === null) hold('size-unknown');
  else if (facts.scope === 'unscoped' && rule.requireDeclaredScope) hold('scope-undeclared');
  if ((facts.outOfScopeCount ?? 0) > rule.maxOutOfScope) hold('out-of-scope-changes');
  return Object.freeze({ rule: Object.freeze({ id: rule.rule.id, version: rule.rule.version, digest: autonomyRuleDigest(rule, risk) }),
    verdict: reasons.length ? 'would-hold' : 'would-deliver', reasons: Object.freeze(reasons) });
}
