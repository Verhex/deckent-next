import { persistedEmail, persistedInteger } from '#platform/core/validate/index.js';
import { z } from 'zod';
import quotaDefaults from './quota-policy.json' with { type: 'json' };
import stallDefaults from './stall-policy.json' with { type: 'json' };
import scanAdmission from './secret-gate-admission.json' with { type: 'json' };
import executionDefaults from './execution-defaults.json' with { type: 'json' };
/** Runtime capability settings. The machine-specific values (`executable`, `imageId`, `gitExecutable`) stay required; the limits default to
 * execution-defaults.json (I-S6, 2026-10-19: the per-worker limits the live installation and the README first-job path used on 2026-10-13).
 * They are operator-adjustable starting values for one worker, not measured optima or product ceilings; set any of them to override. */
const docker = executionDefaults.docker;
export const DOCKER_EXECUTION_SETTINGS = z.strictObject({
  executable: z.string().min(1), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  memoryBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(docker.memoryBytes), pids: persistedInteger().positive().prefault(docker.pids),
  cpus: z.number().positive().finite().prefault(docker.cpus),
  logMaxSizeKiB: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(docker.logMaxSizeKiB), logMaxFiles: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(docker.logMaxFiles),
  tmpBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(docker.tmpBytes), deadlineMs: persistedInteger().positive().max(2_147_483_647).prefault(docker.deadlineMs),
  controlTimeoutMs: persistedInteger().positive().max(2_147_483_647).prefault(docker.controlTimeoutMs), outputBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(docker.outputBytes),
});
/** outputBytes bounds one Git listing/blob read; the default fits repositories with tens of thousands of tracked paths. */
export const GIT_EXECUTION_SETTINGS = z.strictObject({ gitExecutable: z.string().min(1),
  timeoutMs: persistedInteger().positive().max(2_147_483_647).prefault(executionDefaults.git.timeoutMs), outputBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(4_194_304),
  deliveryIdentity: z.strictObject({ authorName: z.string().trim().min(1).max(256).refine(value => ![...value].some(char => char === '<' || char === '>' || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)).describe('config.field.execution.git.deliveryIdentity.authorName'), authorEmail: persistedEmail().max(256).describe('config.field.execution.git.deliveryIdentity.authorEmail') }).optional(), });
/** Branches an operator allows `integration-adopt` to move. Empty (default) refuses every adoption; a listed branch must
 * exist and must not be checked out in any worktree when adopted. Business policy data, not a grant: policy still applies. */
/** Same bounds as a domain identity (task kinds, evaluator ids): trimmed, no control characters, at most 256 code units. */
const configIdentity = z.string().min(1).max(256).refine(value => value.trim() === value && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
/** B06-2c: what counts as verification of an adopted commit. `kind` is the task kind whose Run verifies; `required` refuses adoption
 * without one; `criteria` is the bar each such Run's acceptance must meet (per evaluator: never accepting more than these parameters). */
export const ADOPTION_VERIFICATION_REQUIREMENT = z.strictObject({ kind: configIdentity, required: z.boolean(),
  criteria: z.array(z.strictObject({ evaluator: z.strictObject({ id: configIdentity, version: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }),
    parameters: z.record(z.string(), z.unknown().optional()) })).min(1).max(16) });
export const ADOPTION_TARGET_SETTINGS = z.strictObject({ targets: z.array(z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/)).max(64).prefault([]).describe('config.field.execution.adoption.targets'),
  protectedTargets: z.array(z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/)).max(64).prefault([]).describe('config.field.execution.adoption.protectedTargets'),
  verification: ADOPTION_VERIFICATION_REQUIREMENT.nullable().prefault(null) });
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
  z.strictObject({ schemaVersion: z.literal(1), targets: z.array(z.strictObject({ ...WORK_TARGET, scope: z.undefined().optional() })).min(1).max(1) }),
  z.strictObject({ schemaVersion: z.literal(2), targets: z.array(z.strictObject({ ...WORK_TARGET,
    scope: z.strictObject({ mode: z.enum(['warn', 'enforce']) }).optional() })).min(1).max(1) })]).describe('config.field.execution.workTargets');
/** EXEC-RELEASE (owner 2026-10-01 D8 A): when Deckent reclaims an attempt's stopped container and Git clone. `after-retained-patch`
 * releases only once the attempt's verified patch is retained (patch preparation, then the bounded service-start sweep); `keep` never
 * releases. `sweepLimit` bounds release attempts per scope at each service start. Versioned; unknown keys stay refused. */
export const EXECUTION_RETENTION_SETTINGS = z.strictObject({ schemaVersion: z.literal(1),
  release: z.enum(['after-retained-patch', 'keep']).prefault('after-retained-patch'),
  sweepLimit: persistedInteger().positive().max(10_000).prefault(16) });
/** S6 (owner 2026-10-14): the pre-dispatch secret gate over the tree a worker receives. The deny paths and the content rules are not
 * configurable here (the Core credential floor and the redaction table's `gate` rows). Two small, explicit acknowledgements, empty by default:
 * `allowPatternPaths` lifts content-pattern hits under these workspace-relative globs (test fixtures); `acknowledgedDenyPaths` lifts the
 * deny-path rule for these exact paths (a committed `.npmrc` holding only settings) while their content is still scanned. Neither lifts a
 * configured secret value. The bounds fail closed with `WORKER_TREE_SCAN_INCOMPLETE`. Versioned; unknown keys stay refused. */
export const EXECUTION_SECRET_GATE_SETTINGS = z.strictObject({ schemaVersion: z.literal(1),
  allowPatternPaths: z.array(z.string().min(1).max(512).refine(value => !value.startsWith('/') && !value.split('/').includes('..'))).max(64).prefault([]),
  acknowledgedDenyPaths: z.array(z.string().min(1).max(512).refine(value => !value.startsWith('/') && !/[*?[\]]/u.test(value) && !value.split('/').some(part => part === '..' || part === '.' || part === ''))).max(64).prefault([]),
  maxFiles: persistedInteger().positive().max(10_000_000).prefault(200_000), maxFileBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(16_777_216),
  maxTotalBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(1_073_741_824), timeoutMs: persistedInteger().positive().max(2_147_483_647).prefault(120_000),
  // R2 (owner/lead D3a 2026-10-18): scans admitted at once per process (each deadline starts once admitted), the bounded wait for a slot, and the
  // load-dependent `time` refusals one Attempt retries (`WORKER_TREE_SCAN_DEFERRED`) before the next one is final.
  maxConcurrentScans: persistedInteger().positive().max(1024).prefault(scanAdmission.maxConcurrentScans),
  admissionTimeoutMs: persistedInteger().positive().max(2_147_483_647).prefault(scanAdmission.admissionTimeoutMs),
  maxTimeRefusals: persistedInteger().nonnegative().max(100).prefault(scanAdmission.maxTimeRefusals) });
/** DECKENT-MD-WORKERS (owner Q3 2026-10-23): the project's worker instruction source, read at Run admission into one digest-bound prompt part.
 * Absent = `worker-md` (.deckent/worker-instructions.md, which the human terminal never reads) when it exists, else none. CLAUDE.md is never a
 * source. An older build refuses the key (fails closed). */
export const WORKER_INSTRUCTION_SETTINGS = z.strictObject({ schemaVersion: z.literal(1), source: z.enum(['worker-md', 'agents-md', 'none']).optional() });
export const ARTIFACT_STORAGE_LIMITS = z.strictObject({ maxBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) });
/** A1/A3: shared parked Run/task deadline policy. 24 hours is a conservative, lead-adjustable default,
 * not a measured optimum. Explicit version and strict keys make unsupported policy fail closed. */
export const RUN_PARKING_SETTINGS = z.strictObject({ schemaVersion: z.literal(1),
  timeoutMs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(86_400_000) });

export const QUOTA_RECOVERY_SETTINGS = z.strictObject({ schemaVersion: z.literal(1), maxResumes: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(quotaDefaults.maxResumes).describe('config.field.runRuntime.quotaRecovery.maxResumes'),
  maxWaitMs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(quotaDefaults.maxWaitMs).describe('config.field.runRuntime.quotaRecovery.maxWaitMs'),
  /** S9: how often a person may choose to keep waiting after the ask; the ask itself never ends the Run. */
  maxRewaits: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(quotaDefaults.maxRewaits).describe('config.field.runRuntime.quotaRecovery.maxRewaits') });
/** R3 (owner D4a): installation silence policy for watchable workers (frozen per task at admission; a work class may override warn/stop),
 * at most `maxRetries` automatic re-runs of a stalled Attempt after `backoffMs`. Warn must come before stop. */
export const STALL_RECOVERY_SETTINGS = z.strictObject({ schemaVersion: z.literal(1), warnAfterMs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(stallDefaults.warnAfterMs).describe('config.field.runRuntime.stallRecovery.warnAfterMs'),
  stopAfterMs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(stallDefaults.stopAfterMs).describe('config.field.runRuntime.stallRecovery.stopAfterMs'), maxRetries: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(stallDefaults.maxRetries).describe('config.field.runRuntime.stallRecovery.maxRetries'),
  backoffMs: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(stallDefaults.backoffMs).describe('config.field.runRuntime.stallRecovery.backoffMs') }).refine(value => value.warnAfterMs < value.stopAfterMs, { path: ['warnAfterMs'], message: 'WORKER_INACTIVITY_POLICY_INVALID' });
