import { persistedInteger, identitySchema as id } from '#domain/index.js';
import { z } from 'zod';
import asset from '../../../../../assets/beuser/arrange.json' with { type: 'json' };

const bound = persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), text = /^[^\p{Cc}\p{Cs}]+$/u;
const ref = z.strictObject({ id, version: bound }).readonly();
const sameRef = (a: { readonly id: string; readonly version: number }, b: typeof a) => a.id === b.id && a.version === b.version;
const segments = (parts: readonly string[]) => parts.every(part => part && part !== '.' && part !== '..');
/** Effects stay inside the realm work target: a relative path without empty, `.` or `..` segments. The wrapper re-checks the resolved path. */
const realmPath = z.string().regex(text).refine(path => !path.startsWith('/') && segments(path.split('/')));
const mode = z.string().regex(/^0[0-7]{3}$/u);
const observedPath = z.string().regex(text).refine(path => path.startsWith('/') && segments(path.split('/').slice(1)));
/** A read-only observation of the admitted target; the engine compares it with `expected` (every named field must match). */
const readback = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('installation'), root: realmPath.optional(), expected: z.enum(['installed', 'absent']) }),
  z.strictObject({ kind: z.literal('path'), path: observedPath, expected: z.strictObject({ state: z.enum(['absent', 'file', 'directory', 'socket']),
    mode: mode.optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional() }) }),
  z.strictObject({ kind: z.literal('git'), path: realmPath, expected: z.enum(['tracked', 'untracked']) }),
  z.strictObject({ kind: z.literal('runtime-socket'), expected: z.literal('absent') }),
  z.strictObject({ kind: z.literal('install-method'), expected: z.literal('unproven') }),
]).readonly();
const common = { id, version: bound, readback };
/** Exact product CLI tuple with structured output: no shell, prompt, free text or control characters. */
const cliStep = z.strictObject({ kind: z.literal('cli'), ...common, cwd: realmPath.optional(), args: z.array(z.string().regex(text)).min(1).readonly(), timeoutMs: bound });
/** Fixture file inside the realm: written when `content` is given, then set to `mode`; never through a symlink or outside the work target. */
const fileStep = z.strictObject({ kind: z.literal('file'), ...common, path: realmPath, mode, content: z.string().max(4096).optional(),
  timeoutMs: bound });
/** Git fixture: a fixed subcommand set. The wrapper owns identity and config, so no option may redirect the repository, config or helpers. */
const gitArg = z.string().regex(text).refine(arg => !/^(-c|-C|--(git-dir|work-tree|exec-path|config-env|namespace|upload-pack|receive-pack|template|separate-git-dir))(=|$)/u.test(arg));
const gitStep = z.strictObject({ kind: z.literal('git'), ...common, cwd: realmPath.optional(),
  args: z.array(gitArg).min(1).refine(args => ['init', 'add', 'commit'].includes(args[0]!)).readonly(), timeoutMs: bound });
/** No effect: the state already holds in an admitted realm and is proven by its readback alone. */
const checkStep = z.strictObject({ kind: z.literal('check'), ...common });
/** Steps are `kind`-discriminated so another adapter (an ERP fixture through the general effect contract) adds a kind, not a Core path. */
const stepSchema = z.discriminatedUnion('kind', [cliStep, fileStep, gitStep, checkStep]).refine(step => step.kind !== 'cli' || step.args.includes('--json'));
/** Why a catalogued state is never arranged: typed unknown, never RED and never a witness bypass. */
export const BEUSER_UNREACHABLE_REASONS = ['witness-required', 'realm-external', 'driver-limit', 'no-producer', 'enterprise-only'] as const;
const stateSchema = z.union([z.strictObject({ id, steps: z.array(ref).min(1).readonly() }),
  z.strictObject({ id, unknown: z.enum(BEUSER_UNREACHABLE_REASONS) }),
  // Established by the persona's own action during the walk, not before it.
  z.strictObject({ id, establishedBy: z.literal('persona') }),
  // A fact of the installed profile (persona language or accessibility), checked when the profile is read; no realm step.
  z.strictObject({ id, profile: z.strictObject({ language: id.optional(), accessibility: id.optional() }).refine(v => v.language || v.accessibility) })]);
/** Versioned catalog data. A state either names its steps or carries its typed reason; a missing state is never inferred. */
export const beuserArrangeRegistrySchema = z.strictObject({ schemaVersion: z.literal(1), revision: id, steps: z.array(stepSchema).readonly(),
  states: z.array(stateSchema).readonly(),
}).refine(v => v.steps.every((step, index) => v.steps.findIndex(other => sameRef(step, other)) === index)
  && new Set(v.states.map(state => state.id)).size === v.states.length
  && v.states.every(state => !('steps' in state) || state.steps.every(step => v.steps.some(row => sameRef(row, step))))).readonly();
export const BEUSER_ARRANGE_REGISTRY = beuserArrangeRegistrySchema.parse(asset);
export type BeuserArrangeStep = typeof BEUSER_ARRANGE_REGISTRY.steps[number];
export interface BeuserUnarrangedState { readonly state: string; readonly reason: typeof BEUSER_UNREACHABLE_REASONS[number] | 'persona' }
const catalogued = (state: string) => BEUSER_ARRANGE_REGISTRY.states.find(row => row.id === state);
/** Profile v3 start state: the branch's catalogued state ids, pinned to the installed catalog revision. An empty list arranges nothing. */
export const beuserStartStateSchema = z.strictObject({ schemaVersion: z.literal(2), catalogRevision: z.literal(BEUSER_ARRANGE_REGISTRY.revision),
  states: z.array(id).readonly() }).refine(v => v.states.every(state => catalogued(state)) && new Set(v.states).size === v.states.length).readonly();
type StartState = z.infer<typeof beuserStartStateSchema> | undefined;
/** Pure plan: each step once, in branch order, and every state the harness does not arrange, with its typed reason. */
export function beuserArrangePlan(startState: StartState): { readonly steps: readonly BeuserArrangeStep[]; readonly unarranged: readonly BeuserUnarrangedState[] } {
  const states = (startState?.states ?? []).map(state => catalogued(state)!);
  const refs = states.flatMap(state => 'steps' in state ? state.steps : []).filter((step, index, all) => all.findIndex(other => sameRef(step, other)) === index);
  return { steps: refs.map(step => BEUSER_ARRANGE_REGISTRY.steps.find(row => sameRef(row, step))!),
    unarranged: states.flatMap((state): BeuserUnarrangedState[] => 'unknown' in state ? [{ state: state.id, reason: state.unknown }]
      : 'establishedBy' in state ? [{ state: state.id, reason: state.establishedBy }] : []) };
}
/** Profile-fact states hold only for a matching persona; a mismatch is an invalid profile, not a realm state. */
export function beuserStartStateFits(startState: StartState, persona: { readonly language: string; readonly accessibility: readonly string[] }): boolean {
  return (startState?.states ?? []).every(state => { const row = catalogued(state);
    return !row || !('profile' in row) || (!row.profile.language || row.profile.language === persona.language)
      && (!row.profile.accessibility || persona.accessibility.includes(row.profile.accessibility)); });
}
