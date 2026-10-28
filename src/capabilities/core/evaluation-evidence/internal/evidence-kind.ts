import registry from './evidence-kinds.json' with { type: 'json' };
/** What an installed evaluator's verdict rests on (law 1): the evidence kind and whether it checks content independently of the worker. */
export type EvaluatorEvidenceKind = 'exit-code' | 'operation-record' | 'harness-readback' | 'unknown';
export type EvaluatorEvidence = Readonly<{ kind: EvaluatorEvidenceKind; independent: boolean | null }>;
const KINDS: Readonly<Record<string, Readonly<{ evidence: string; independent: boolean }>>> = registry.evaluators;
/** One registry for every surface and the delivery summary; an evaluator it does not list (an extension's) is `unknown`, independence unknown. */
export function evaluatorEvidence(evaluator: Readonly<{ id: string }>): EvaluatorEvidence {
  const entry = Object.hasOwn(KINDS, evaluator.id) ? KINDS[evaluator.id]! : undefined;
  if (!entry || (entry.evidence !== 'exit-code' && entry.evidence !== 'operation-record' && entry.evidence !== 'harness-readback')) return Object.freeze({ kind: 'unknown', independent: null });
  return Object.freeze({ kind: entry.evidence, independent: entry.independent });
}
