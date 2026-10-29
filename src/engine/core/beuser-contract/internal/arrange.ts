import { z } from 'zod';
import { identitySchema as id } from '#domain/index.js';
import asset from '../../../../../assets/beuser/arrange.json' with { type: 'json' };

const bound = z.number().int().positive().safe();
const ref = z.object({ id, version: bound }).strict().readonly();
const sameRef = (a: { readonly id: string; readonly version: number }, b: typeof a) => a.id === b.id && a.version === b.version;
/** Exact product CLI tuple with structured output: no shell, prompt, free text or control characters. */
const cliStep = z.object({ kind: z.literal('cli'), id, version: bound, args: z.array(z.string().regex(/^[^\p{Cc}\p{Cs}]+$/u)).min(1).readonly(), timeoutMs: bound,
  readback: z.object({ key: z.literal('installation'), expected: z.enum(['installed', 'absent']) }).strict().readonly() }).strict();
/** Steps are `kind`-discriminated so another adapter (an ERP fixture through the general effect contract) adds a kind, not a Core path. */
const stepSchema = z.discriminatedUnion('kind', [cliStep]).refine(step => step.kind !== 'cli' || step.args.includes('--json'));
/** Versioned catalog data. A state either names its steps or stays typed unknown; a missing state is never inferred. */
export const beuserArrangeRegistrySchema = z.object({ schemaVersion: z.literal(1), revision: id, steps: z.array(stepSchema).readonly(),
  states: z.array(z.union([z.object({ id, steps: z.array(ref).min(1).readonly() }).strict(),
    z.object({ id, unknown: z.enum(['witness-required', 'realm-external', 'driver-limit', 'no-producer', 'enterprise-only']) }).strict()])).readonly(),
}).strict().refine(v => v.steps.every((step, index) => v.steps.findIndex(other => sameRef(step, other)) === index)
  && new Set(v.states.map(state => state.id)).size === v.states.length
  && v.states.every(state => !('steps' in state) || state.steps.every(step => v.steps.some(row => sameRef(row, step))))).readonly();
export const BEUSER_ARRANGE_REGISTRY = beuserArrangeRegistrySchema.parse(asset);
export type BeuserArrangeStep = typeof BEUSER_ARRANGE_REGISTRY.steps[number];
/** Profile v3 start state: catalog references only, pinned to the installed catalog revision. An empty list arranges nothing. */
export const beuserStartStateSchema = z.object({ schemaVersion: z.literal(1), catalogRevision: z.literal(BEUSER_ARRANGE_REGISTRY.revision),
  steps: z.array(ref).readonly() }).strict().refine(v => v.steps.every(step => BEUSER_ARRANGE_REGISTRY.steps.some(row => sameRef(row, step)))).readonly();
export function beuserArrangeSteps(startState: z.infer<typeof beuserStartStateSchema> | undefined): readonly BeuserArrangeStep[] {
  return (startState?.steps ?? []).map(step => BEUSER_ARRANGE_REGISTRY.steps.find(row => sameRef(row, step))!);
}
