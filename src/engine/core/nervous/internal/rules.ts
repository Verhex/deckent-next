import { z } from 'zod';
import { NERVOUS_RULE_STATUSES, identitySchema, recoveryActionSchema } from '#domain/index.js';
import { AUDIT_PAGE_MAX } from '#engine/core/audit/index.js';
import seed from './rules.json' with { type: 'json' };
/** The versioned Core seed (S6R-2): every threshold is provisional data until measured in shadow on a real installation (K-F S8); an overlay is a later slice. */
export const NERVOUS_RULES_SEED: unknown = seed;
export class NervousError extends Error {
  constructor(readonly code: 'NERVOUS_RULES_UNREADABLE' | 'NERVOUS_SIGNAL_INVALID' | 'NERVOUS_ACTION_REFUSED') { super(code); this.name = 'NervousError'; }
}
const positive = z.number().int().positive().safe();
const base = { version: positive, status: z.enum(NERVOUS_RULE_STATUSES), action: recoveryActionSchema };
/** The rule kinds this evaluator implements; the registry must name each exactly once (a missing rule is never a silent pass). */
const ruleSchema = z.discriminatedUnion('id', [
  z.object({ id: z.literal('container-gone'), ...base, consecutiveAbsent: positive, minAbsentMs: positive }).strict(),
  z.object({ id: z.literal('launcher-dead-orphan'), ...base }).strict(),
  z.object({ id: z.literal('launcher-dead-gone'), ...base }).strict(),
  z.object({ id: z.literal('daemon-unavailable'), ...base, graceMs: positive }).strict(),
  z.object({ id: z.literal('daemon-unavailable-escalate'), ...base, afterMs: positive }).strict(),
  z.object({ id: z.literal('crash-loop'), ...base }).strict(),
  z.object({ id: z.literal('policy-refusal-flood'), ...base }).strict(),
]);
export type NervousRule = z.infer<typeof ruleSchema>;
type RuleId = NervousRule['id'];
const RULE_IDS: readonly RuleId[] = ruleSchema.options.map(option => option.shape.id.value);
const registrySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema,
  tracking: z.object({ maxAttempts: positive, feedPageSize: positive.max(AUDIT_PAGE_MAX), maxApplications: positive }).strict(),
  rules: z.array(ruleSchema).max(RULE_IDS.length) }).strict();
export type NervousRules = Readonly<{ revision: string; tracking: Readonly<{ maxAttempts: number; feedPageSize: number; maxApplications: number }>; rules: readonly NervousRule[];
  rule<K extends RuleId>(id: K): Extract<NervousRule, { id: K }> }>;
/** Parses the registry; any defect (shape, a missing or doubled rule, an action outside the K-B list, escalation before grace) is NERVOUS_RULES_UNREADABLE. */
export function loadNervousRules(input: unknown): NervousRules {
  const parsed = registrySchema.safeParse(input);
  if (!parsed.success) throw new NervousError('NERVOUS_RULES_UNREADABLE');
  const byId = new Map(parsed.data.rules.map(entry => [entry.id, entry] as const));
  if (byId.size !== parsed.data.rules.length || RULE_IDS.some(id => !byId.has(id))) throw new NervousError('NERVOUS_RULES_UNREADABLE');
  const rule = <K extends RuleId>(id: K) => byId.get(id) as Extract<NervousRule, { id: K }>;
  if (rule('daemon-unavailable-escalate').afterMs <= rule('daemon-unavailable').graceMs) throw new NervousError('NERVOUS_RULES_UNREADABLE');
  return Object.freeze({ revision: parsed.data.revision, tracking: Object.freeze({ ...parsed.data.tracking }), rules: Object.freeze([...parsed.data.rules]), rule });
}
