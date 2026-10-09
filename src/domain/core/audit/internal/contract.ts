import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** The MCP registry scopes (the adapter's own list; the audit contract stays dependency-free). */
const MCP_REGISTRY_SCOPES = ['managed', 'local', 'project', 'user'] as const;
/** Versioned audit event contract (general Core audit port, first slice — owner 2026-09-27 q4/q5). */
export const AUDIT_EVENT_SCHEMA_VERSION = 1;
export const AUDIT_SHELL_HEAD_MAX_CHARS = 200;
/** FA-TRACKED-WARN: the most workspace-relative paths one `tracked-files-changed` list names (its count is always the full number). */
export const AUDIT_TRACKED_PATHS_MAX = 50;
/** Who the decision was made for: exact issuer and subject; a persona is never part of the record. */
export const auditPrincipalSchema = z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly();
/**
 * What the event summarizes — never the raw command or file content (design note §4): an edit names its workspace-relative
 * path; a shell call keeps the first `AUDIT_SHELL_HEAD_MAX_CHARS` characters (the approval subject's head) and the argument digest;
 * an MCP call its `mcp:<server>/<tool>` name and the argument digest (additive members, schema version 1 unchanged).
 */
export const auditSummarySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edit'), path: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('shell'), head: z.string().min(1).max(AUDIT_SHELL_HEAD_MAX_CHARS), argsDigest: digest }).strict(),
  /** An MCP tool call (MCP-CLIENT): the tool as the owner names it (`mcp:<server>/<tool>`) and the argument digest, never the arguments. */
  z.object({ kind: z.literal('mcp'), tool: z.string().min(1).max(AUDIT_SHELL_HEAD_MAX_CHARS), argsDigest: digest }).strict(),
  /** A `fetch_url` call (MODES-3, full access): the host it names and the argument digest, never the URL (a query may carry secrets). */
  z.object({ kind: z.literal('fetch'), host: z.string().min(1).max(253), argsDigest: digest }).strict(),
]);
/**
 * The person's terminal permission modes (domain policy catalog; the audit contract keeps its own copy to stay dependency-free). Sealed
 * records keep the names they were written with: `ask`/`auto-edit` (bindings v2) stay readable next to `standart`/`full-access` (MODES-3).
 */
const connectStep = z.enum(['written', 'present', 'skipped']);
const permissionMode = z.enum(['ask', 'auto-edit', 'full-auto', 'standart', 'full-access']);
/** An agent tool call's position in its turn (the same identity every call event carries). */
const callRef = z.object({ turnId: identitySchema, round: counterSchema.positive(), index: counterSchema, callId: identitySchema }).strict();
const toolRef = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/), version: counterSchema.positive() }).strict();
/**
 * A silent decision produced by the terminal permission mode (slice 4): the mode relaxed a cell the company policy marked
 * mode-eligible, turning `require-approval` into `allow` for exactly this tool call. Other subject kinds join this union as
 * further Core decisions gain an audit record; a SIEM adapter reads them all through the same port.
 */
const governedAuditSubjectSchema = z.discriminatedUnion('kind', [
  /** Config document write intent, recorded before atomic publication; digests only, no authored values. `approvalId` (T3 L2, lead
   * 2026-10-07): the config-change approval this write consumed — present only then, so every other config write keeps its earlier shape. */
  z.object({ kind: z.literal('config-change'), action: z.enum(['set', 'unset']), layer: z.enum(['project', 'global']),
    keyPath: identitySchema, commandId: identitySchema, beforeDigest: digest.nullable(), afterDigest: digest, approvalId: identitySchema.optional() }).strict(),
  z.object({ kind: z.literal('run-lifecycle'), action: z.enum(['close', 'resume', 'accept', 'reject']),
    runId: identitySchema, commandId: identitySchema, taskId: identitySchema.nullable(), revision: counterSchema,
    evidence: z.literal('model-unverified').nullable() }).strict(),
  z.object({kind:z.literal('decision-port'),action:z.enum(['ask','record','outcome']),phase:z.enum(['admitted','observed']),
    decisionId:identitySchema,caseDigest:digest,adviceDigest:digest.nullable(),selectedOption:identitySchema.nullable()}).strict(),
  /** `person` null (MODES-3): the default `standart`, which no bindings entry names. */
  z.object({ kind: z.literal('permission-mode'), mode: z.enum(['auto-edit', 'full-auto', 'standart']), cell: z.enum(['edit-non-floor', 'shell-modify', 'mcp-call']),
    tool: toolRef, call: callRef, grants: z.object({ company: identitySchema, person: identitySchema.nullable() }).strict(),
    decision: z.object({ previous: z.literal('require-approval'), next: z.literal('allow') }).strict(),
    summary: auditSummarySchema }).strict(),
  /**
   * A person's request to set their own terminal permission mode (slice 4c): the authorization decision on `permission-mode`/`set`
   * and, when allowed, the bindings revision it writes (`after` null: nothing was written — refused or already that mode). Recorded
   * before the bindings file is replaced; no record, no change.
   */
  /**
   * An MCP trust change (MCP-CLIENT, owner 2026-09-28): the owner trusted, declined, reset, revoked or reconnected one server definition of a
   * registry scope. The definition and the pinned tool list are digests; the command and its values are never recorded. Recorded before the
   * trust record is written; no event, no change.
   */
  z.object({ kind: z.literal('mcp-trust'), action: z.enum(['trust', 'decline', 'reset', 'revoke', 'reconnect']), scope: z.enum(MCP_REGISTRY_SCOPES),
    server: z.string().regex(/^(?=.{1,32}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), definitionDigest: digest, toolsDigest: digest.nullable() }).strict(),
  /**
   * A change of one stored secret (SECRET-K1): set or delete, the secret's name (the `$DECK:NAME` grammar) and the backend that holds it
   * (`<namespace>.secret-store.<name>@<version>`), recorded before the store is written — no event, no change. The value, its digest or
   * length are never part of the record (a digest of a low-entropy secret would be guessable). SECRET-WRITE: every decision on the
   * `secret`/`set|delete` policy cell is recorded with its effect and rule (a refusal too, then nothing is written); amended in place — the kind
   * was never produced before (unreleased, no producer in SECRET-K1).
   */
  z.object({ kind: z.literal('secret-change'), action: z.enum(['set', 'delete']), name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/),
    backend: z.string().max(128).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.secret-store\.[a-z][a-z0-9-]*@[1-9][0-9]{0,5}$/),
    decision: z.object({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }).strict() }).strict(),
  /**
   * SECRET-STORE-SWITCH (owner 2026-10-08, union extension only): the decision on the `secret`/`switch` cell to move every secret from the
   * selected store to another registered one and select it — recorded before anything moves (a refusal too). `entries` is how many names
   * move (never a name list or value); `downgrade` marks a move toward a weaker store, made only with an explicit confirmation.
   */
  /**
   * T4-B `models.connect`: one connection of a model to a scope — the registry kind, the exact reference, the secret NAME the profile reads (never
   * a value) and what each governed step did (each step also wrote its own record: config change, catalog receipt, activation receipt).
   */
  z.object({ kind: z.literal('model-connect'), commandId: identitySchema, connection: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    reference: z.object({ providerId: identitySchema, providerVersion: counterSchema, modelId: identitySchema, modelVersion: counterSchema }).strict(),
    credentialRef: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/).nullable(),
    steps: z.object({ catalog: connectStep, declaration: connectStep, profile: connectStep, activation: connectStep, carried: counterSchema }).strict(),
    notCarried: z.array(z.object({ providerId: identitySchema, providerVersion: counterSchema, modelId: identitySchema, modelVersion: counterSchema }).strict()).max(1024) }).strict(),
  z.object({ kind: z.literal('backup-operation'), operationId: identitySchema, action: z.enum(['create', 'verify', 'restore']),
    installationId: identitySchema, setPathDigest: digest, targetPathDigest: digest.nullable(), ledgerDigest: digest.nullable(),
    phase: z.enum(['intent', 'succeeded', 'refused', 'failed', 'uncertain']), code: identitySchema.nullable(),
    decision: z.object({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }).strict() }).strict(),
  z.object({ kind: z.literal('secret-store-switch'),
    from: z.string().max(128).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.secret-store\.[a-z][a-z0-9-]*@[1-9][0-9]{0,5}$/),
    to: z.string().max(128).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.secret-store\.[a-z][a-z0-9-]*@[1-9][0-9]{0,5}$/),
    entries: z.number().int().nonnegative().safe(), downgrade: z.boolean(),
    decision: z.object({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }).strict() }).strict(),
  z.object({ kind: z.literal('permission-mode-change'), requested: permissionMode, previous: permissionMode,
    decision: z.object({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }).strict(),
    bindingsRevision: z.object({ before: identitySchema, after: identitySchema.nullable() }).strict(),
    /** MODES-3: the person's "ask for edits too" preference requested and before (absent on records written before it existed). */
    askEdits: z.object({ requested: z.boolean(), previous: z.boolean() }).strict().optional() }).strict(),
  /**
   * Full access switched on for one terminal session (FA-SESSION, owner 2026-10-07): the decision on the person's `permission-mode`/`set`
   * `full-access` grant, the stored mode the session leaves untouched (the next launch starts in it) and the bindings revision read. Nothing is
   * written; an allowed switch is recorded before the service answers (no record, no switch), a refusal when possible. Every turn of that session
   * is admitted and recorded again as `full-access-turn`.
   */
  z.object({ kind: z.literal('permission-mode-session'), requested: z.literal('full-access'), stored: permissionMode, sessionId: identitySchema.nullable(),
    decision: z.object({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }).strict(),
    bindingsRevision: identitySchema }).strict(),
  /**
   * A turn launched in full access (MODES-3, owner 2026-09-29): the decision on the person's `permission-mode`/`set` `full-access` grant at the
   * turn's admission. An allowed turn is recorded before its first round (no record, no turn); a refusal is recorded when possible.
   */
  z.object({ kind: z.literal('full-access-turn'), turnId: identitySchema, sessionId: identitySchema.nullable(),
    decision: z.object({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }).strict() }).strict(),
  /**
   * One effect call of a full-access turn (edit, shell, fetch, MCP), recorded before the effect whether or not anything was lowered: the cell,
   * the policy decision before the floor raise, whether the floor raised it, the company rule ids a mode lowered (null: none) and the grant
   * rule that allowed full access. The effect gate admits only this decision again.
   */
  z.object({ kind: z.literal('full-access-call'), cell: z.enum(['edit', 'edit-floor', 'edit-self-source', 'shell-read-none', 'shell-read-low', 'shell-narrow-mutating', 'shell-destructive',
    'shell-always-ask', 'shell-other-modify', 'fetch-listed', 'fetch-unlisted', 'mcp-call']), policy: z.enum(['allow', 'require-approval']), raised: z.boolean(),
  company: identitySchema.nullable(), grant: identitySchema, tool: toolRef, call: callRef, summary: auditSummarySchema }).strict(),
  /**
   * What a full-access shell call measurably did to the project's git-tracked files (FA-TRACKED-WARN, owner 2026-09-30 option A: warn and
   * audit, never block): recorded after the effect, next to that call's `full-access-call` event (same call reference), only when it
   * deleted or overwrote at least one tracked file. Each list keeps its full count and at most `AUDIT_TRACKED_PATHS_MAX` project-relative
   * paths (edit summaries name paths the same way); the file content is never part of it.
   */
  z.object({ kind: z.literal('tracked-files-changed'), tool: toolRef, call: callRef, summary: auditSummarySchema,
    deleted: z.object({ count: counterSchema, paths: z.array(z.string().min(1).max(4096)).max(AUDIT_TRACKED_PATHS_MAX) }).strict(),
    overwritten: z.object({ count: counterSchema, paths: z.array(z.string().min(1).max(4096)).max(AUDIT_TRACKED_PATHS_MAX) }).strict() }).strict(),
  /**
   * An applied governed authority change (POLICY-ADMIN P3, `policy.administer@1`): the command and the approval it consumed, who decided
   * it (the delegation bound is that person's authority, I3), the effective revision before and after, the change's size and the digest
   * of its canonical input — never the grants themselves (the revision archive keeps the documents). Recorded before any file changes.
   */
  z.object({ kind: z.literal('authority-change'), operation: z.object({ id: identitySchema, version: counterSchema.positive() }).strict(),
    commandId: identitySchema, approvalId: identitySchema, decider: auditPrincipalSchema, inputDigest: digest,
    revision: z.object({ before: identitySchema, after: identitySchema }).strict(),
    counts: z.object({ grantsAdded: counterSchema, grantsRemoved: counterSchema, bindingsAdded: counterSchema, bindingsRemoved: counterSchema }).strict() }).strict(),
  /**
   * A refused authority change (POLICY-HARDEN P3-R): where it stopped (`decide` = an approval surface that may not decide authority
   * approvals, `submit` = before any intent, `settle` = a claimed intent refused terminally at the effect), the stable refusal code and the
   * command; `approvalId`/`decider` are null while none exists. Nothing of the change itself is recorded.
   */
  z.object({ kind: z.literal('authority-refusal'), stage: z.enum(['decide', 'submit', 'settle']), code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    operation: z.object({ id: identitySchema, version: counterSchema.positive() }).strict(), commandId: identitySchema.nullable(), approvalId: identitySchema.nullable(),
    decider: auditPrincipalSchema.nullable() }).strict(),
  /**
   * A standing approval (PERSISTENT-APPROVALS G6, owner 2026-09-28) at work. `remembered`: the person answered "this session" on an approval
   * card — recorded before the memory holds it (no record, no memory). `used`: a later call the standing approval lowered from an owner
   * approval to a run, recorded before the effect (no record, nothing runs). `source: grant` is the person's own persisted grant (its
   * creation is the `authority-change` event); the pattern itself is named by its digest and the call's own summary, never the raw text.
   */
  z.object({ kind: z.literal('standing-approval'), phase: z.enum(['remembered', 'used']), source: z.enum(['session', 'grant']), grantId: identitySchema.nullable(),
    cell: z.enum(['edit', 'edit-self-source', 'shell-read-low', 'shell-narrow-mutating']), keyDigest: digest, approvalId: identitySchema.nullable(),
    tool: toolRef, call: callRef,
    summary: auditSummarySchema }).strict(),
  /**
   * A typed execution pool hold change (K5, owner 2026-09-30 option A): `hold` stops new task reservations of the installation-wide pool,
   * `resume` restarts them; running work is never touched. Every decision on the `pool`/`hold|resume` cell is recorded — a refusal too
   * (`state` null, nothing written); an allowed change commits in the same ledger transaction as the hold row (no record, no change).
   * `state.previous === state.next` is an idempotent no-op (already held / already open). The operator's reason stays in the hold record.
   */
  z.object({ kind: z.literal('pool-capacity'), poolId: identitySchema, commandId: identitySchema,
    decision: z.object({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }).strict(),
    capacity: z.object({ previous: z.object({ executionSlots: counterSchema, inFlightSlots: counterSchema }).strict(),
      next: z.object({ executionSlots: counterSchema.positive(), inFlightSlots: counterSchema.positive() }).strict() }).strict().nullable() }).strict(),
  z.object({ kind: z.literal('pool-hold'), action: z.enum(['hold', 'resume']), poolId: identitySchema, commandId: identitySchema,
    decision: z.object({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }).strict(),
    state: z.object({ previous: z.enum(['open', 'held']), next: z.enum(['open', 'held']) }).strict().nullable() }).strict(),
  /**
   * A model-bound field carried hidden, bidi or tag Unicode (MODEL-INGRESS). Digests only: the raw field frame, the text the model
   * was shown, and the decoder output. The decoded payload itself is never stored and never enters the model.
   */
  z.object({ kind: z.literal('model-ingress'), fieldDigest: digest, projectedDigest: digest, decodedDigest: digest.nullable(),
    codePoints: counterSchema, disposition: z.enum(['note', 'quarantine']) }).strict(),
]);
/** Installer authority is OS file ownership, not a policy.administer approval. Existing governed events retain their strict shape. */
export const auditSubjectSchema = z.union([governedAuditSubjectSchema,
  z.object({ kind: z.literal('authority-change'), installer: z.object({ basis: z.enum(['first-run', 'named-person']),
    template: z.object({ id: identitySchema, version: counterSchema.positive() }).strict(), person: auditPrincipalSchema }).strict(),
    commandId: identitySchema, inputDigest: digest, revision: z.object({ before: identitySchema, after: identitySchema }).strict(),
    counts: z.object({ grantsAdded: counterSchema, grantsRemoved: counterSchema, bindingsAdded: counterSchema, bindingsRemoved: counterSchema }).strict() }).strict(),
]);
export const auditEventSchema = z.object({ schemaVersion: z.literal(AUDIT_EVENT_SCHEMA_VERSION), eventId: identitySchema, scopeId: identitySchema,
  principal: auditPrincipalSchema, policyRevision: identitySchema, atMs: counterSchema, subject: auditSubjectSchema }).strict().readonly();
/** The durable, sealed form: the event, its scope-local sequence and the key that sealed both (the approval MAC line). */
export const auditRecordSchema = z.object({ event: auditEventSchema, sequence: counterSchema.positive(), keyId: identitySchema, mac: digest }).strict().readonly();
/** Summary counters (owner q5: decisions that were silent already are counted, not recorded): mutable totals, not evidence. */
export const auditCounterSchema = z.object({ scopeId: identitySchema, counter: identitySchema, count: counterSchema, updatedAtMs: counterSchema }).strict().readonly();
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditSubject = z.infer<typeof auditSubjectSchema>;
export type AuditRecord = z.infer<typeof auditRecordSchema>;
export type AuditCounter = z.infer<typeof auditCounterSchema>;
export class AuditError extends Error {
  constructor(readonly code: 'AUDIT_INVALID' | 'AUDIT_INTEGRITY' | 'AUDIT_CONFLICT' | 'AUDIT_UNAVAILABLE') { super(code); this.name = 'AuditError'; }
}
