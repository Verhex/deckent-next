import { z } from 'zod';
import { counterSchema, identitySchema, rolloutCriterionMet } from '#domain/core/primitives/index.js';
import seed from '../../../../../assets/recovery/rollout.json' with { type: 'json' };

const positive = counterSchema.positive(), criterion = (extra: z.ZodRawShape) => z.object({ id: identitySchema, minSample: counterSchema, ...extra }).strict().readonly();
/**
 * alpha.56 G4 (owner Q-A2/Q-A4/Q-A5; S6R-DESIGN §11): the recovery rollout registry, versioned Core data (`assets/recovery/rollout.json`,
 * provisional until measured). `rules`: the Nervous rules a person may promote in this release (the lost-worker rules); `detection`: per
 * rule@version, the shadow cases since its last false positive; `decision`: the model-decided cases a person reviewed blind and how many agreed
 * (per mille); `scan`: the newest sealed records read per source (a bound hit leaves every criterion unmet) and the cases one review page lists. Meeting them is evidence only.
 */
export const recoveryRolloutRegistrySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema, status: z.enum(['provisional', 'measured']),
  rules: z.array(identitySchema).min(1).max(32).readonly(), scan: z.object({ detections: positive, decisions: positive, verdicts: positive, reviewPage: positive.max(100) }).strict().readonly(),
  detection: criterion({}), decision: criterion({ minPerMille: z.number().int().min(0).max(1000) }) }).strict().readonly();
export type RecoveryRolloutRegistry = z.infer<typeof recoveryRolloutRegistrySchema>;
export const RECOVERY_ROLLOUT: RecoveryRolloutRegistry = Object.freeze(recoveryRolloutRegistrySchema.parse(seed));
/** The sealed records one scope's view is measured from (engine reader): targeted detections, model-decided seals, blind verdicts and the cases
 * whose worker later had its report accepted (a lost worker cannot deliver, so that detection was a false positive). */
export type RecoveryRolloutRecords = Readonly<{
  rules: readonly Readonly<{ id: string; version: number }>[];
  detections: readonly Readonly<{ caseId: string; ruleId: string; ruleVersion: number; sequence: number }>[];
  decisions: readonly Readonly<{ caseId: string; eventId: string; action: 'continue-new-attempt' | 'escalate-human' }>[];
  verdicts: readonly Readonly<{ caseId: string; decisionEventId: string; detection: 'lost' | 'not-lost'; choice: 'continue-new-attempt' | 'escalate-human' | null }>[];
  contradicted: readonly string[]; complete: boolean }>;
export type RecoveryRolloutRuleView = Readonly<{ id: string; version: number; shadowCases: number; sinceFalsePositive: number; falsePositives: number; met: boolean }>;
/** Counts only (blind, owner Q-A5): a model's choice of an unreviewed case is never part of the view, so no surface can show it. */
export type RecoveryRolloutView = Readonly<{ registry: Readonly<{ revision: string; status: 'provisional' | 'measured' }>; complete: boolean;
  rules: readonly RecoveryRolloutRuleView[]; decisions: Readonly<{ decided: number; agreements: number; perMille: number | null; waiting: number; met: boolean }> }>;

/** Pure: the rollout view of one scope's sealed records against the registry (only the registry's rules, at their current version). */
export function recoveryRolloutView(records: RecoveryRolloutRecords, registry: RecoveryRolloutRegistry = RECOVERY_ROLLOUT): RecoveryRolloutView {
  const verdicts = new Map(records.verdicts.map(row => [row.caseId, row] as const)), contradicted = new Set(records.contradicted);
  const falsePositive = (caseId: string) => contradicted.has(caseId) || verdicts.get(caseId)?.detection === 'not-lost';
  const rules = registry.rules.flatMap(id => records.rules.filter(rule => rule.id === id)).map(rule => {
    const cases = records.detections.filter(row => row.ruleId === rule.id && row.ruleVersion === rule.version), wrong = cases.filter(row => falsePositive(row.caseId));
    const reset = Math.max(0, ...wrong.map(row => row.sequence)), since = cases.filter(row => row.sequence > reset).length;
    return Object.freeze({ id: rule.id, version: rule.version, shadowCases: cases.length, sinceFalsePositive: since, falsePositives: wrong.length,
      met: records.complete && rolloutCriterionMet(registry.detection, { count: 0, sample: since, of: null }) });
  });
  const decisions = new Map(records.decisions.map(row => [row.eventId, row] as const));
  const reviewed = records.verdicts.flatMap(row => { const decision = decisions.get(row.decisionEventId);
    return row.detection === 'lost' && decision?.caseId === row.caseId ? [row.choice === decision.action] : []; });
  const agreements = reviewed.filter(Boolean).length, waiting = new Set(records.decisions.filter(row => !verdicts.has(row.caseId)).map(row => row.caseId)).size;
  return Object.freeze({ registry: Object.freeze({ revision: registry.revision, status: registry.status }), complete: records.complete, rules: Object.freeze(rules),
    decisions: Object.freeze({ decided: reviewed.length, agreements, perMille: reviewed.length ? Math.floor(agreements * 1000 / reviewed.length) : null, waiting,
      met: records.complete && rolloutCriterionMet(registry.decision, { count: agreements, sample: reviewed.length, of: null }) }) });
}
