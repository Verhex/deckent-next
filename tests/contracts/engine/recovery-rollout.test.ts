import { expect, it } from 'vitest';
import { RECOVERY_ROLLOUT, recoveryRolloutView, type RecoveryRolloutRecords } from '#domain/index.js';

// alpha.56 G4 (R-DESIGN §2 G4; owner Q-A2/Q-A4/Q-A5): the recovery rollout view over sealed-record fixtures. Expected thresholds are the design's
// §11 numbers (≥ 20 shadow cases per rule since its last false positive; ≥ 10 blind-reviewed model decisions at ≥ 900‰), never recomputed from the code.
const RULES = [{ id: 'container-gone', version: 1 }, { id: 'launcher-dead-orphan', version: 1 }, { id: 'launcher-dead-gone', version: 1 }, { id: 'crash-loop', version: 1 }];
const detections = (ruleId: string, from: number, count: number, ruleVersion = 1) =>
  Array.from({ length: count }, (_, n) => ({ caseId: `${ruleId}-${from + n}`, ruleId, ruleVersion, sequence: from + n }));
const empty: RecoveryRolloutRecords = { rules: RULES, detections: [], decisions: [], verdicts: [], contradicted: [], complete: true };

it('per rule@version: cases since the last false positive (a verdict or an accepted-report contradiction resets), other versions and unlisted rules ignored', () => {
  expect(RECOVERY_ROLLOUT).toMatchObject({ rules: ['container-gone', 'launcher-dead-orphan', 'launcher-dead-gone'], detection: { minSample: 20 }, decision: { minSample: 10, minPerMille: 900 } });
  const gone = [...detections('container-gone', 1, 25), ...detections('container-gone', 100, 5, 2)];
  const orphan = detections('launcher-dead-orphan', 200, 30), dead = detections('launcher-dead-gone', 300, 19);
  const view = recoveryRolloutView({ ...empty, detections: [...gone, ...orphan, ...dead, ...detections('crash-loop', 400, 40)],
    verdicts: [{ caseId: 'launcher-dead-orphan-212', decisionEventId: 'x', detection: 'not-lost', choice: null }], contradicted: ['container-gone-3'] });
  expect(view.rules.map(row => [row.ruleId, row.cases, row.sinceFalsePositive, row.falsePositives, row.met])).toEqual([
    ['container-gone', 25, 22, 1, true], ['launcher-dead-orphan', 30, 17, 1, false], ['launcher-dead-gone', 19, 19, 0, false]]);
  // A scan bound hit is unmet, whatever the counts say.
  expect(recoveryRolloutView({ ...empty, detections: gone, complete: false }).rules[0]).toMatchObject({ cases: 25, met: false });
});

it('decision agreement: only lost verdicts on a model decision count, per mille floored; undecided cases are counts only (blind)', () => {
  const decisions = Array.from({ length: 12 }, (_, n) => ({ caseId: `c${n}`, eventId: `recovery-decision:shadow:c${n}`, action: n % 2 ? 'escalate-human' as const : 'continue-new-attempt' as const }));
  const verdict = (n: number, agree = true) => ({ caseId: `c${n}`, decisionEventId: `recovery-decision:shadow:c${n}`, detection: 'lost' as const,
    choice: agree ? decisions[n]!.action : decisions[n]!.action === 'escalate-human' ? 'continue-new-attempt' as const : 'escalate-human' as const });
  const nine = Array.from({ length: 9 }, (_, n) => verdict(n));
  expect(recoveryRolloutView({ ...empty, decisions, verdicts: nine }).decisions).toEqual({ decided: 9, agreements: 9, perMille: 1000, waiting: 3, met: false });
  const ten = [...nine, verdict(9, false)];
  expect(recoveryRolloutView({ ...empty, decisions, verdicts: ten }).decisions).toEqual({ decided: 10, agreements: 9, perMille: 900, waiting: 2, met: true });
  const notLost = [...ten, { caseId: 'c10', decisionEventId: 'recovery-decision:shadow:c10', detection: 'not-lost' as const, choice: null }];
  expect(recoveryRolloutView({ ...empty, decisions, verdicts: [...ten.slice(0, 8), verdict(8, false), verdict(9, false), ...notLost.slice(10)] }).decisions)
    .toEqual({ decided: 10, agreements: 8, perMille: 800, waiting: 1, met: false });
  expect(JSON.stringify(recoveryRolloutView({ ...empty, decisions }))).not.toMatch(/continue-new-attempt|escalate-human/u);
});
