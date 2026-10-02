import { z } from 'zod';
/** Required runtime capability settings; install/config composition supplies policy values. */
export const DOCKER_EXECUTION_SETTINGS = z.object({
  executable: z.string().min(1), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  memoryBytes: z.number().int().positive().safe(), pids: z.number().int().positive(), cpus: z.number().positive().finite(),
  logMaxSizeKiB: z.number().int().positive().safe(), logMaxFiles: z.number().int().positive().safe(),
  tmpBytes: z.number().int().positive().safe(), deadlineMs: z.number().int().positive().max(2_147_483_647),
  controlTimeoutMs: z.number().int().positive().max(2_147_483_647), outputBytes: z.number().int().positive().safe(),
}).strict();
/** outputBytes bounds one Git listing/blob read; the default fits repositories with tens of thousands of tracked paths. */
export const GIT_EXECUTION_SETTINGS = z.object({ gitExecutable: z.string().min(1),
  timeoutMs: z.number().int().positive().max(2_147_483_647), outputBytes: z.number().int().positive().safe().default(4_194_304) }).strict();
/** Branches an operator allows `integration-adopt` to move. Empty (default) refuses every adoption; a listed branch must
 * exist and must not be checked out in any worktree when adopted. Business policy data, not a grant: policy still applies. */
/** Same bounds as a domain identity (task kinds, evaluator ids): trimmed, no control characters, at most 256 code units. */
const configIdentity = z.string().min(1).max(256).refine(value => value.trim() === value && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
/** B06-2c: what counts as verification of an adopted commit. `kind` is the task kind whose Run verifies; `required` refuses adoption
 * without one; `criteria` is the bar each such Run's acceptance must meet (per evaluator: never accepting more than these parameters). */
export const ADOPTION_VERIFICATION_REQUIREMENT = z.object({ kind: configIdentity, required: z.boolean(),
  criteria: z.array(z.object({ evaluator: z.object({ id: configIdentity, version: z.number().int().positive().safe() }).strict(),
    parameters: z.record(z.string(), z.unknown()) }).strict()).min(1).max(16) }).strict();
export const ADOPTION_TARGET_SETTINGS = z.object({ targets: z.array(z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/)).max(64).default([]),
  verification: ADOPTION_VERIFICATION_REQUIREMENT.nullable().default(null) }).strict();
/** WORK-TARGETS (owner 2026-09-30 K1 = W2): the named repositories Deckent's coding work runs against, instead of the project root.
 * Absent = today's behavior (the project root and its checkout HEAD). Slice 1 supports exactly one Git target; the list shape and the
 * versioned `schemaVersion` keep the contract ready for more. Non-Git business systems are not work targets (C11 effect port).
 * `baseRef` names the base branch: Runs start from its tip and delivery/integration preconditions compare against it, never the
 * target checkout's HEAD. Unknown keys stay refused (strict), so an older build fails closed instead of targeting the project root. */
const WORK_TARGET = { id: configIdentity, kind: z.literal('git'), path: z.string().min(1).max(4096),
  baseRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/) };
/** v1 is released (pushed 21110d09, run live) and stays exactly as it was; v2 adds K6 (owner 2026-09-30 A) `scope`: classification of
 * patches landing here; absent = warn (classified, never refused); enforce = typed refusal before the integration/delivery write for
 * out-of-scope or undeclared scope. An older build refuses v2 (fails closed). */
export const WORK_TARGET_SETTINGS = z.discriminatedUnion('schemaVersion', [
  z.object({ schemaVersion: z.literal(1), targets: z.array(z.object({ ...WORK_TARGET, scope: z.undefined().optional() }).strict()).min(1).max(1) }).strict(),
  z.object({ schemaVersion: z.literal(2), targets: z.array(z.object({ ...WORK_TARGET,
    scope: z.object({ mode: z.enum(['warn', 'enforce']) }).strict().optional() }).strict()).min(1).max(1) }).strict()]);
/** EXEC-RELEASE (owner 2026-10-01 D8 A): when Deckent reclaims an attempt's stopped container and Git clone. `after-retained-patch`
 * releases only once the attempt's verified patch is retained (patch preparation, then the bounded service-start sweep); `keep` never
 * releases. `sweepLimit` bounds release attempts per scope at each service start. Versioned; unknown keys stay refused. */
export const EXECUTION_RETENTION_SETTINGS = z.object({ schemaVersion: z.literal(1),
  release: z.enum(['after-retained-patch', 'keep']).default('after-retained-patch'),
  sweepLimit: z.number().int().positive().max(10_000).default(16) }).strict();
export const ARTIFACT_STORAGE_LIMITS = z.object({ maxBytes: z.number().int().positive().safe() }).strict();
/** A1/A3: shared parked Run/task deadline policy. 24 hours is a conservative, lead-adjustable default,
 * not a measured optimum. Explicit version and strict keys make unsupported policy fail closed. */
export const RUN_PARKING_SETTINGS = z.object({ schemaVersion: z.literal(1),
  timeoutMs: z.number().int().positive().safe().default(86_400_000) }).strict();
