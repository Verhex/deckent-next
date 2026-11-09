import { persistedString, persistedInteger, persistedUuid, identitySchema, counterSchema } from '#domain/core/primitives/index.js';
import { z } from 'zod';
import { authorityDecisionSubjectSchema } from './authority-decision.js';
import limits from './limits.json' with { type: 'json' };
/** S4B-3 memory evaluation record modes (the memory domain owns their meaning). */
const MEMORY_EVALUATION_RECORD_MODES = Object.freeze(['shadow', 'live'] as const);
/** S4B-5: the context modes that read and seal (`off` reads nothing, so it is never recorded). */
const MEMORY_CONTEXT_RECORD_MODES = Object.freeze(['shadow', 'on'] as const);
/** S6R-5: the recovery decision modes that seal (the recovery domain's frozen Run modes; `off` decides nothing, so it is never recorded). */
const RECOVERY_DECISION_RECORD_MODES = Object.freeze(['shadow', 'live'] as const);
/** S6R-6 / alpha.56 G1: what a decision seal stands on besides its own call — a live adoption of a shadow decision, or a would-stop shadow input. */
const RECOVERY_DECISION_BASES = Object.freeze(['shadow', 'would-stop'] as const);
const digest = z.string().regex(/^[a-f0-9]{64}$/), signedRef = z.strictObject({ keyId: digest, signatureDigest: digest }).optional();
/** The MCP registry scopes (the adapter's own list; the audit contract stays dependency-free). */
const MCP_REGISTRY_SCOPES = ['managed', 'local', 'project', 'user'] as const;
/** S5b: the safety hold sources (Nervous pause, Auditor park) a Run hold and its audit name; the Run contract reuses this one list. */
export const runSafetyHoldSourceSchema = z.enum(['nervous', 'auditor']);
/**
 * S6 Nervous K-B standing list (owner 2026-10-11 K-B, updated 2026-10-23 anchor s6r-kayip-calisan-2026-10-23): the only actions a Nervous proposal
 * may name. Versioned code, never registry data; none opens an Attempt, resumes a Run or releases a slot (release is a broker gate step).
 */
export const RECOVERY_ACTIONS = Object.freeze(['fence-attempt', 'hold-run', 'stop-orphan', 'restart-component', 'alert-brain', 'hand-to-human'] as const);
export const recoveryActionSchema = z.enum(RECOVERY_ACTIONS);
/** A Nervous rule's measurement state: `provisional` thresholds are unmeasured (shadow only); only a `live` rule may execute (S6R-3). */
export const NERVOUS_RULE_STATUSES = Object.freeze(['provisional', 'live'] as const);
/** S6R-2: what Nervous saw of a worker (`control-failed`: the daemon did not answer) and of its launcher (`dead`: another instance whose process is gone). */
export const NERVOUS_ACTIVITY_STATES = Object.freeze(['missing', 'created', 'running', 'paused', 'exited', 'unknown', 'control-failed'] as const);
export const NERVOUS_LAUNCHER_BASES = Object.freeze(['same-process', 'alive', 'dead', 'none', 'unreadable'] as const);
/** Versioned audit event contract (general Core audit port, first slice — owner 2026-09-27 q4/q5). */
export const AUDIT_EVENT_SCHEMA_VERSION = 1;
export const AUDIT_SHELL_HEAD_MAX_CHARS = 200;
/** FA-TRACKED-WARN: the most workspace-relative paths one `tracked-files-changed` list names (its count is always the full number). */
export const AUDIT_TRACKED_PATHS_MAX = 50;
/** Crash-loop breaker: the phases of one dispatch preparation, in order (before workspace acquisition → secret gate → handoff → supervisor/claim). */
/** S5 D1 (owner Q5 2026-10-17): the most refused / silently allowed calls one `policy-turn` record names (each count is always the full number). */
export const AUDIT_POLICY_TURN_LIMITS = Object.freeze({ refusedMax: limits.policyTurnRefusedMax, allowedMax: limits.policyTurnAllowedMax });
/** S4B-5: the most memory entries one `memory-context` event names (the memory registry's `context.maxEntries` stays at or below it). */
export const AUDIT_MEMORY_CONTEXT_ENTRIES_MAX = limits.memoryContextEntriesMax;
export const DISPATCH_PREPARATION_PHASES = Object.freeze(['prepare', 'workspace', 'secret-gate', 'handoff', 'dispatch'] as const);
/** S6R-2: the typed signal summary a `recovery-detection` seals (counts and states only, never a log line, path or worker output). */
export const recoveryEvidenceSchema = z.strictObject({ get activity() { return z.enum(NERVOUS_ACTIVITY_STATES).nullable(); }, get launcher() { return z.enum(NERVOUS_LAUNCHER_BASES).nullable(); },
  get launcherPhase() { return z.enum(DISPATCH_PREPARATION_PHASES).nullable(); }, absentObservations: counterSchema, get absentForMs() { return counterSchema.nullable(); },
  get unavailableForMs() { return counterSchema.nullable(); }, get containerRecorded() { return z.boolean().nullable(); }, get workerRecorded() { return z.boolean().nullable(); },
  get source() { return z.strictObject({ kind: z.enum(['dispatch-preparation-aborted', 'policy-turn', 'beuser-target-refusal']), eventId: identitySchema, sequence: counterSchema.positive() }).nullable(); } });
/** Who the decision was made for: exact issuer and subject; a persona is never part of the record. */
export const auditPrincipalSchema = z.strictObject({ issuer: identitySchema, subject: identitySchema }).readonly();
/**
 * What the event summarizes — never the raw command or file content (design note §4): an edit names its workspace-relative
 * path; a shell call keeps the first `AUDIT_SHELL_HEAD_MAX_CHARS` characters (the approval subject's head) and the argument digest;
 * an MCP call its `mcp:<server>/<tool>` name and the argument digest (additive members, schema version 1 unchanged).
 */
export const auditSummarySchema = z.discriminatedUnion('kind', [
  z.strictObject({ get kind() { return z.literal('edit'); }, get path() { return persistedString(z.string().min(1).max(4096)); } }),
  z.strictObject({ get kind() { return z.literal('shell'); }, get head() { return persistedString(z.string().min(1).max(AUDIT_SHELL_HEAD_MAX_CHARS)); }, argsDigest: digest }),
  /** An MCP tool call (MCP-CLIENT): the tool as the owner names it (`mcp:<server>/<tool>`) and the argument digest, never the arguments. */
  z.strictObject({ get kind() { return z.literal('mcp'); }, get tool() { return persistedString(z.string().min(1).max(AUDIT_SHELL_HEAD_MAX_CHARS)); }, argsDigest: digest }),
  /** A `fetch_url` call (MODES-3, full access): the host it names and the argument digest, never the URL (a query may carry secrets). */
  z.strictObject({ get kind() { return z.literal('fetch'); }, get host() { return persistedString(z.string().min(1).max(253)); }, argsDigest: digest }),
]);
/**
 * The person's terminal permission modes (domain policy catalog; the audit contract keeps its own copy to stay dependency-free). Sealed
 * records keep the names they were written with: `ask`/`auto-edit` (bindings v2) stay readable next to `standart`/`full-access` (MODES-3).
 */
const connectStep = z.enum(['written', 'present', 'skipped']);
const permissionMode = z.enum(['ask', 'auto-edit', 'full-auto', 'standart', 'full-access']);
/** An agent tool call's position in its turn (the same identity every call event carries). */
const callRef = z.strictObject({ turnId: identitySchema, get round() { return counterSchema.positive(); }, index: counterSchema, callId: identitySchema });
const toolRef = z.strictObject({ get name() { return z.string().regex(/^[a-z][a-z0-9_]{1,63}$/); }, get version() { return counterSchema.positive(); } });
/** The agent tool call cells (engine policy catalog; the audit contract keeps its own copy to stay dependency-free). */
const agentToolCell = z.enum(['read', 'edit', 'edit-floor', 'edit-self-source', 'edit-authority', 'shell-read-none', 'shell-read-low', 'shell-narrow-mutating',
  'shell-destructive', 'shell-always-ask', 'shell-other-modify', 'fetch-listed', 'fetch-unlisted', 'mcp-call', 'mcp-floor']);
/** One call position without its turn (the `policy-turn` record names the turn once). */
const turnCallRef = z.strictObject({ get round() { return counterSchema.positive(); }, index: counterSchema, callId: identitySchema });
/**
 * A silent decision produced by the terminal permission mode (slice 4): the mode relaxed a cell the company policy marked
 * mode-eligible, turning `require-approval` into `allow` for exactly this tool call. Other subject kinds join this union as
 * further Core decisions gain an audit record; a SIEM adapter reads them all through the same port.
 */
const governedAuditSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ get kind() { return z.literal('target-batch-decision'); }, batchDigest: digest, get operation() { return z.enum(['publish', 'adopt', 'rollback']); }, get answer() { return z.enum(['allow', 'decline']); }, get peerPid() { return counterSchema.positive(); }, witnessDigest: digest }),
  z.strictObject({ get kind() { return z.literal('target-queue'); }, commandId: identitySchema, targetKey: digest, get ordinal() { return counterSchema.positive(); },
    revision: counterSchema, state: identitySchema, payloadDigest: digest, recordDigest: digest, get reason() { return z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).optional(); } }),
  /** Additive v1 subject: selected distribution manifests before assurance activation; secrets never enter the inventory. */
  z.strictObject({ get kind() { return z.literal('approval-assurance-registration'); }, get schemaVersion() { return z.literal(1); }, get producers() { return z.array(z.strictObject({
    schemaVersion: z.literal(1), id: identitySchema, version: counterSchema.positive(), level: identitySchema,
    rank: counterSchema.positive(), active: z.boolean() })).max(128); } }),
  /** Config document write intent, recorded before atomic publication; digests only, no authored values. `approvalId` (T3 L2, lead
   * 2026-10-07): the config-change approval this write consumed — present only then, so every other config write keeps its earlier shape. */
  z.strictObject({ get kind() { return z.literal('config-change'); }, get action() { return z.enum(['set', 'unset']); }, get layer() { return z.enum(['project', 'global']); },
    keyPath: identitySchema, commandId: identitySchema, get beforeDigest() { return digest.nullable(); }, afterDigest: digest, get approvalId() { return identitySchema.optional(); } }),
  // S6R-4: `continue-lost-task` — the recovery principal returned a lost Attempt's task to pending under the owner's standing grant (`decisionRuleId`).
  z.strictObject({ get kind() { return z.literal('run-lifecycle'); }, get action() { return z.enum(['close', 'resume', 'hold', 'answer', 'accept', 'reject', 'park-progression', 'release-worker-custody', 'continue-lost-task', 'quota-answer']); },
    get inputDigest() { return digest.optional(); }, get deciderClass() { return z.enum(['human-tty', 'ai-policy', 'system']).optional(); },
    get decisionRuleId() { return identitySchema.optional(); }, get approvalId() { return identitySchema.optional(); },
    // S5b: present only for a safety hold and its resume, so every operator event keeps its earlier shape.
    get holdSource() { return runSafetyHoldSourceSchema.optional(); },
    runId: identitySchema, commandId: identitySchema, get taskId() { return identitySchema.nullable(); }, revision: counterSchema,
    get evidence() { return z.literal('model-unverified').nullable(); } }),
  z.strictObject({get kind() { return z.literal('decision-port'); },get action() { return z.enum(['ask','record','outcome']); },get phase() { return z.enum(['admitted','observed']); },
    decisionId:identitySchema,caseDigest:digest,get adviceDigest() { return digest.nullable(); },get selectedOption() { return identitySchema.nullable(); }}),
  /**
   * S5 D1 (AUDITOR-MODEL, owner Q5 2026-10-17; changes q5 in this scope): one sealed record per agent turn of every policy decision on its tool
   * calls that is not already its own event. `refused`: each deny and require-approval — at the policy question before planning (`policy`,
   * no cell yet), on the planned cell (`cell`) or again at the effect (`effect`). `allowed`: each call that ran on a plain allow (no mode,
   * standing approval or full access, which keep their own events). Tool identity, position, cell and argument digest only — never arguments,
   * paths or output. Each list keeps its full count and at most its `AUDIT_POLICY_TURN_LIMITS` entries; `ceiling` marks refusals past the bound.
   */
  z.strictObject({ get kind() { return z.literal('policy-turn'); }, turnId: identitySchema, get ceiling() { return z.boolean(); },
    get refused() { return z.strictObject({ count: counterSchema, calls: z.array(z.strictObject({ tool: toolRef, call: turnCallRef, cell: agentToolCell.nullable(), decision: z.enum(['deny', 'require-approval']),
      stage: z.enum(['policy', 'cell', 'effect']), argsDigest: digest, revision: identitySchema })).max(AUDIT_POLICY_TURN_LIMITS.refusedMax) }); },
    get allowed() { return z.strictObject({ count: counterSchema, calls: z.array(z.strictObject({ tool: toolRef, call: turnCallRef, cell: agentToolCell, argsDigest: digest,
      revision: identitySchema })).max(AUDIT_POLICY_TURN_LIMITS.allowedMax) }); } }),
  /** S4 memory journal v1: one transition of one entry (content and notes are never recorded, only their digest and the verification basis). */
  z.strictObject({ get kind() { return z.literal('memory-journal'); }, get action() { return z.union([z.literal('propose'), z.literal('verify'), z.literal('retire')]); }, entryId: identitySchema, commandId: identitySchema,
    get revision() { return counterSchema.positive(); }, get state() { return z.enum(['candidate', 'verified', 'retired']); }, contentDigest: digest,
    get basis() { return z.enum(['human-review', 'independent-evaluation']).nullable(); } }),
  /** S4B-3 (§9): one sealed evaluation record (shadow or live) and one contest it opened; digests and ids only, never candidate text. */
  z.strictObject({ get kind() { return z.literal('memory-evaluation'); }, recordId: identitySchema, entryId: identitySchema, get revision() { return counterSchema.positive(); }, get mode() { return z.enum(MEMORY_EVALUATION_RECORD_MODES); },
    get verdict() { return z.enum(['pass', 'fail', 'unknown']); }, recordDigest: digest, subjectDigest: digest }),
  z.strictObject({ get kind() { return z.literal('memory-contest'); }, contestId: identitySchema, entryId: identitySchema, candidateEntryId: identitySchema, recordId: identitySchema }),
  /** S4B-4 (§6.6, §9): one purge of one entry (keyed content digest only; `replay`: re-applied from the purge journal after a restore) and one
   * person's resolution of a contest. Ids and digests only, never content. */
  z.strictObject({ get kind() { return z.literal('memory-purge'); }, purgeId: identitySchema, entryId: identitySchema, contentDigest: digest, revisions: counterSchema,
    invocations: counterSchema, get replay() { return z.boolean(); } }),
  z.strictObject({ get kind() { return z.literal('memory-contest-resolution'); }, contestId: identitySchema, entryId: identitySchema, get decision() { return z.enum(['retire-contested', 'retire-candidate', 'dismiss']); },
    get retiredEntryId() { return identitySchema.nullable(); } }),
  /** S4B-5 (§7.1, §9): the memory part frozen into one task's worker prompt at Run admission (`shadow`: computed and sealed, never sent;
   * `delivered` false also when the prompt budget had no room). Keyed digests and ids only, never entry text; `withheld` counts entries the
   * admitting principal may not read. */
  z.strictObject({ get kind() { return z.literal('memory-context'); }, runId: identitySchema, taskId: identitySchema, get mode() { return z.enum(MEMORY_CONTEXT_RECORD_MODES); }, get delivered() { return z.boolean(); },
    get entries() { return z.array(z.strictObject({ entryId: identitySchema, revision: counterSchema.positive(), contentDigest: digest, basis: z.enum(['human-review', 'independent-evaluation']) }))
      .min(1).max(AUDIT_MEMORY_CONTEXT_ENTRIES_MAX); }, partDigest: digest, withheld: counterSchema, /** S4B-7: whether the part fit the prompt (sealed in both modes). */ get fit() { return z.boolean().optional(); } }),
  /** S4B-6 (§7.2, §9): the memory block of one Brain planning request, sealed before the first prompt leaves the machine (`shadow`: computed,
   * never sent). `runId` is the Brain's Run id, `contextDigest` the planning context digest the stored proposal's contribution carries: the event
   * of a plan that was then refused stays (the effect may have happened) and is recognised by a digest no stored proposal names. Keyed digests
   * and ids only, never entry text; `omitted` counts entries the bounds left out, `withheld` those from work the person may not read. */
  z.strictObject({ get kind() { return z.literal('brain-memory-context'); }, runId: identitySchema, commandId: identitySchema, get mode() { return z.enum(MEMORY_CONTEXT_RECORD_MODES); }, get delivered() { return z.boolean(); },
    get entries() { return z.array(z.strictObject({ entryId: identitySchema, revision: counterSchema.positive(), contentDigest: digest, basis: z.enum(['human-review', 'independent-evaluation']) }))
      .min(1).max(AUDIT_MEMORY_CONTEXT_ENTRIES_MAX); }, memoryDigest: digest, contextDigest: digest, omitted: counterSchema, withheld: counterSchema }),
  /** S7 agent/skill catalog: one definition or import of one row (persona and skill text are never recorded, only their digests). */
  z.strictObject({ get kind() { return z.literal('agent-catalog'); }, get item() { return z.enum(['agent', 'skill']); }, get action() { return z.enum(['define', 'import']); }, id: identitySchema, commandId: identitySchema,
    get revision() { return counterSchema.positive(); }, contentDigest: digest, get skillSetDigest() { return digest.nullable(); },
    /** S8-5: an AI/system write — the action key and the digest of the signature verified in the commit transaction. */
    signed: signedRef }),
  /** S8-3/S8-4: one standing change of one agent revision for one WorkClass (a person's card, a signed AI command, the aggregator's rule narrowing). */
  z.strictObject({ get kind() { return z.literal('agent-standing'); }, get action() { return z.enum(['promote', 'demote', 'restore', 'retire', 'narrow']); }, agentId: identitySchema, get revision() { return counterSchema.positive(); },
    workClass: identitySchema, from: identitySchema, to: identitySchema, get standingRevision() { return counterSchema.positive(); }, get suggestionId() { return digest.nullable(); }, commandId: identitySchema, signed: signedRef }),
  /** S8-3: one catalog suggestion written or moved: refs, digests and counts only, never persona, skill, lesson or draft text (N28). */
  z.strictObject({ get kind() { return z.literal('catalog-suggestion'); }, get action() { return z.enum(['suggest', 'supersede', 'decide', 'dismiss']); }, suggestionId: digest, suggestionKind: identitySchema, keyDigest: digest,
    inputDigest: digest, ruleId: identitySchema, get ruleVersion() { return counterSchema.positive(); }, get state() { return z.enum(['open', 'decided', 'dismissed', 'superseded']); }, signed: signedRef }),
  /** S8-5: a person's signer-key change (or the startup re-revocation from the append-only log); public facts only, never key material. */
  z.strictObject({ get kind() { return z.literal('skill-signer'); }, get action() { return z.enum(['enrol', 'add', 'revoke']); }, keyId: digest, get purpose() { return z.enum(['action', 'import', 'publish', 'hub']); },
    get custody() { return z.enum(['host', 'external']); }, commandId: identitySchema, get revision() { return counterSchema.positive(); }, get basis() { return z.enum(['person-card', 'revocation-log']); } }),
  /** `person` null (MODES-3): the default `standart`, which no bindings entry names. */
  z.strictObject({ get kind() { return z.literal('permission-mode'); }, get mode() { return z.enum(['auto-edit', 'full-auto', 'standart']); }, get cell() { return z.enum(['edit-non-floor', 'shell-modify', 'shell-read', 'mcp-call']); }, // R9 `shell-read`: a Run worker's read-only shell
    tool: toolRef, call: callRef, get grants() { return z.strictObject({ company: identitySchema, person: identitySchema.nullable() }); },
    get decision() { return z.strictObject({ previous: z.literal('require-approval'), next: z.literal('allow') }); },
    summary: auditSummarySchema }),
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
  z.strictObject({ get kind() { return z.literal('mcp-trust'); }, get action() { return z.enum(['trust', 'decline', 'reset', 'revoke', 'reconnect']); }, get scope() { return z.enum(MCP_REGISTRY_SCOPES); },
    get server() { return z.string().regex(/^(?=.{1,32}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/); }, definitionDigest: digest, get toolsDigest() { return digest.nullable(); } }),
  /**
   * A change of one stored secret (SECRET-K1): set or delete, the secret's name (the `$DECK:NAME` grammar) and the backend that holds it
   * (`<namespace>.secret-store.<name>@<version>`), recorded before the store is written — no event, no change. The value, its digest or
   * length are never part of the record (a digest of a low-entropy secret would be guessable). SECRET-WRITE: every decision on the
   * `secret`/`set|delete` policy cell is recorded with its effect and rule (a refusal too, then nothing is written); amended in place — the kind
   * was never produced before (unreleased, no producer in SECRET-K1).
   */
  z.strictObject({ get kind() { return z.literal('secret-change'); }, get action() { return z.enum(['set', 'delete']); }, get name() { return z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/); },
    get backend() { return persistedString(z.string().max(128)).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.secret-store\.[a-z][a-z0-9-]*@[1-9][0-9]{0,5}$/); },
    get decision() { return z.strictObject({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }); } }),
  /**
   * SECRET-STORE-SWITCH (owner 2026-10-08, union extension only): the decision on the `secret`/`switch` cell to move every secret from the
   * selected store to another registered one and select it — recorded before anything moves (a refusal too). `entries` is how many names
   * move (never a name list or value); `downgrade` marks a move toward a weaker store, made only with an explicit confirmation.
   */
  /**
   * T4-B `models.connect`: one connection of a model to a scope — the registry kind, the exact reference, the secret NAME the profile reads (never
   * a value) and what each governed step did (each step also wrote its own record: config change, catalog receipt, activation receipt).
   */
  z.strictObject({ get kind() { return z.literal('subscription-api-continuation'); }, get schemaVersion() { return z.literal(1); }, actor: auditPrincipalSchema, sourceInvocationId: identitySchema,
    get connectionId() { return persistedUuid(); }, profileDigest: digest, get reference() { return z.strictObject({ providerId: identitySchema, providerVersion: counterSchema,
      modelId: identitySchema, modelVersion: counterSchema }); }, commandId: identitySchema, get phase() { return z.literal('intent'); } }),
  z.strictObject({ get kind() { return z.literal('model-connect'); }, commandId: identitySchema, get connection() { return z.string().regex(/^[a-z][a-z0-9-]{0,31}$/); },
    get reference() { return z.strictObject({ providerId: identitySchema, providerVersion: counterSchema, modelId: identitySchema, modelVersion: counterSchema }); },
    get credentialRef() { return z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/).nullable(); },
    get steps() { return z.strictObject({ catalog: connectStep, declaration: connectStep, profile: connectStep, activation: connectStep, carried: counterSchema }); },
    get notCarried() { return z.array(z.strictObject({ providerId: identitySchema, providerVersion: counterSchema, modelId: identitySchema, modelVersion: counterSchema })).max(1024); } }),
  z.strictObject({ get kind() { return z.literal('backup-operation'); }, operationId: identitySchema, get action() { return z.enum(['create', 'verify', 'restore']); },
    installationId: identitySchema, setPathDigest: digest, get targetPathDigest() { return digest.nullable(); }, get ledgerDigest() { return digest.nullable(); },
    get phase() { return z.enum(['intent', 'succeeded', 'refused', 'failed', 'uncertain']); }, get code() { return identitySchema.nullable(); },
    get decision() { return z.strictObject({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }); } }),
  /** I-D2 (INIT-D2 cond. 4): the person's approved host install of one execution environment: intent before the first sudo step, then its end
   * (the stopping step's number and exit code, the version the package manager resolved). Never a command line, password or path. */
  z.strictObject({ get kind() { return z.literal('execution-environment-install'); }, operationId: identitySchema, environment: identitySchema,
    get source() { return z.strictObject({ distribution: identitySchema, codename: identitySchema, fingerprint: z.string().regex(/^[0-9A-F]{40}$/) }).nullable(); },
    get phase() { return z.enum(['intent', 'succeeded', 'refused', 'failed', 'uncertain']); }, get step() { return counterSchema.nullable(); }, get exitCode() { return persistedInteger().nullable(); },
    get version() { return z.string().regex(/^[0-9A-Za-z.+:~_-]{1,64}$/).nullable(); }, get decision() { return z.strictObject({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }); } }),
  z.strictObject({ get kind() { return z.literal('secret-store-switch'); },
    get from() { return persistedString(z.string().max(128)).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.secret-store\.[a-z][a-z0-9-]*@[1-9][0-9]{0,5}$/); },
    get to() { return persistedString(z.string().max(128)).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.secret-store\.[a-z][a-z0-9-]*@[1-9][0-9]{0,5}$/); },
    get entries() { return persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER); }, get downgrade() { return z.boolean(); },
    get decision() { return z.strictObject({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }); } }),
  z.strictObject({ get kind() { return z.literal('permission-mode-change'); }, requested: permissionMode, previous: permissionMode,
    get decision() { return z.strictObject({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }); },
    get bindingsRevision() { return z.strictObject({ before: identitySchema, after: identitySchema.nullable() }); },
    /** MODES-3: the person's "ask for edits too" preference requested and before (absent on records written before it existed). */
    get askEdits() { return z.strictObject({ requested: z.boolean(), previous: z.boolean() }).optional(); }, get policyDigestBefore() { return digest.optional(); }, get policyDigest() { return digest.optional(); } }),
  /**
   * Full access switched on for one terminal session (FA-SESSION, owner 2026-10-07): the decision on the person's `permission-mode`/`set`
   * `full-access` grant, the stored mode the session leaves untouched (the next launch starts in it) and the bindings revision read. Nothing is
   * written; an allowed switch is recorded before the service answers (no record, no switch), a refusal when possible. Every turn of that session
   * is admitted and recorded again as `full-access-turn`.
   */
  z.strictObject({ get kind() { return z.literal('permission-mode-session'); }, get requested() { return z.literal('full-access'); }, stored: permissionMode, get sessionId() { return identitySchema.nullable(); },
    get decision() { return z.strictObject({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }); },
    bindingsRevision: identitySchema }),
  /**
   * A turn launched in full access (MODES-3, owner 2026-09-29): the decision on the person's `permission-mode`/`set` `full-access` grant at the
   * turn's admission. An allowed turn is recorded before its first round (no record, no turn); a refusal is recorded when possible.
   */
  z.strictObject({ get kind() { return z.literal('full-access-turn'); }, turnId: identitySchema, get sessionId() { return identitySchema.nullable(); },
    get decision() { return z.strictObject({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }); } }),
  /**
   * One effect call of a full-access turn (edit, shell, fetch, MCP), recorded before the effect whether or not anything was lowered: the cell,
   * the policy decision before the floor raise, whether the floor raised it, the company rule ids a mode lowered (null: none) and the grant
   * rule that allowed full access. The effect gate admits only this decision again.
   */
  z.strictObject({ get kind() { return z.literal('full-access-call'); }, get cell() { return z.enum(['edit', 'edit-floor', 'edit-self-source', 'shell-read-none', 'shell-read-low', 'shell-narrow-mutating', 'shell-destructive',
    'shell-always-ask', 'shell-other-modify', 'fetch-listed', 'fetch-unlisted', 'mcp-call']); }, get policy() { return z.enum(['allow', 'require-approval']); }, get raised() { return z.boolean(); },
  get company() { return identitySchema.nullable(); }, grant: identitySchema, tool: toolRef, call: callRef, summary: auditSummarySchema }),
  /**
   * What a full-access shell call measurably did to the project's git-tracked files (FA-TRACKED-WARN, owner 2026-09-30 option A: warn and
   * audit, never block): recorded after the effect, next to that call's `full-access-call` event (same call reference), only when it
   * deleted or overwrote at least one tracked file. Each list keeps its full count and at most `AUDIT_TRACKED_PATHS_MAX` project-relative
   * paths (edit summaries name paths the same way); the file content is never part of it.
   */
  z.strictObject({ get kind() { return z.literal('tracked-files-changed'); }, tool: toolRef, call: callRef, summary: auditSummarySchema,
    get deleted() { return z.strictObject({ count: counterSchema, paths: z.array(persistedString(z.string().min(1).max(4096))).max(AUDIT_TRACKED_PATHS_MAX) }); },
    get overwritten() { return z.strictObject({ count: counterSchema, paths: z.array(persistedString(z.string().min(1).max(4096))).max(AUDIT_TRACKED_PATHS_MAX) }); } }),
  /**
   * An applied governed authority change (POLICY-ADMIN P3, `policy.administer@1`): the command and the approval it consumed, who decided
   * it (the delegation bound is that person's authority, I3), the effective revision before and after, the change's size and the digest
   * of its canonical input — never the grants themselves (the revision archive keeps the documents). Recorded before any file changes.
   */
  z.strictObject({ get kind() { return z.literal('authority-change'); }, get operation() { return z.strictObject({ id: identitySchema, version: counterSchema.positive() }); },
    commandId: identitySchema, approvalId: identitySchema, decider: auditPrincipalSchema, inputDigest: digest,
    get revision() { return z.strictObject({ before: identitySchema, after: identitySchema }); },
    get counts() { return z.strictObject({ grantsAdded: counterSchema, grantsRemoved: counterSchema, bindingsAdded: counterSchema, bindingsRemoved: counterSchema }); },
    /** AUDIT-CHECKPOINT (wave 2026-10-15): the audit policy digest of the resulting effective policy; a later checkpoint accepts exactly this content. */
    get policyDigestBefore() { return digest.optional(); }, get policyDigest() { return digest.optional(); } }),
  /**
   * A refused authority change (POLICY-HARDEN P3-R): where it stopped (`decide` = an approval surface that may not decide authority
   * approvals, `submit` = before any intent, `settle` = a claimed intent refused terminally at the effect), the stable refusal code and the
   * command; `approvalId`/`decider` are null while none exists. Nothing of the change itself is recorded.
   */
  z.strictObject({ get kind() { return z.literal('authority-refusal'); }, get stage() { return z.enum(['decide', 'submit', 'settle']); }, get code() { return z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/); },
    get operation() { return z.strictObject({ id: identitySchema, version: counterSchema.positive() }); }, get commandId() { return identitySchema.nullable(); }, get approvalId() { return identitySchema.nullable(); },
    get decider() { return auditPrincipalSchema.nullable(); } }),
  /**
   * A standing approval (PERSISTENT-APPROVALS G6, owner 2026-09-28) at work. `remembered`: the person answered "this session" on an approval
   * card — recorded before the memory holds it (no record, no memory). `used`: a later call the standing approval lowered from an owner
   * approval to a run, recorded before the effect (no record, nothing runs). `source: grant` is the person's own persisted grant (its
   * creation is the `authority-change` event); the pattern itself is named by its digest and the call's own summary, never the raw text.
   */
  z.strictObject({ get kind() { return z.literal('standing-approval'); }, get phase() { return z.enum(['remembered', 'used']); }, get source() { return z.enum(['session', 'grant']); }, get grantId() { return identitySchema.nullable(); },
    get cell() { return z.enum(['edit', 'edit-self-source', 'shell-read-low', 'shell-narrow-mutating']); }, keyDigest: digest, get approvalId() { return identitySchema.nullable(); },
    tool: toolRef, call: callRef,
    summary: auditSummarySchema }),
  /**
   * SBX-05 x company policy (lead 2026-10-09): one write-set entry of an owner-approved destructive shell call that the decision still asks
   * for (a write-floor file, or an ordinary edit in a mode that lowers none), applied as card-approved — recorded with the call's approval
   * before its effect (no record, nothing applied). Policy denies and the configuration file are never admitted this way, nor a floor-named
   * directory.
   */
  z.strictObject({ get kind() { return z.literal('sandbox-write-approved'); }, approvalId: identitySchema, get cell() { return z.enum(['edit', 'edit-floor', 'edit-self-source']); },
    tool: toolRef, call: callRef, summary: auditSummarySchema }),
  /**
   * A typed execution pool hold change (K5, owner 2026-09-30 option A): `hold` stops new task reservations of the installation-wide pool,
   * `resume` restarts them; running work is never touched. Every decision on the `pool`/`hold|resume` cell is recorded — a refusal too
   * (`state` null, nothing written); an allowed change commits in the same ledger transaction as the hold row (no record, no change).
   * `state.previous === state.next` is an idempotent no-op (already held / already open). The operator's reason stays in the hold record.
   */
  z.strictObject({ get kind() { return z.literal('pool-capacity'); }, poolId: identitySchema, commandId: identitySchema,
    get decision() { return z.strictObject({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }); },
    get capacity() { return z.strictObject({ previous: z.strictObject({ executionSlots: counterSchema, inFlightSlots: counterSchema }),
      next: z.strictObject({ executionSlots: counterSchema.positive(), inFlightSlots: counterSchema.positive() }) }).nullable(); } }),
  z.strictObject({ get kind() { return z.literal('quota-release'); }, poolId: identitySchema, get poolIds() { return z.array(identitySchema).readonly().optional(); }, get decisionPoolId() { return identitySchema.optional(); }, get channelId() { return persistedString(z.string().min(1).max(256)); }, commandId: identitySchema,
    get decision() { return z.strictObject({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }); }, get released() { return counterSchema.nullable(); } }),
  z.strictObject({ get kind() { return z.literal('pool-hold'); }, get action() { return z.enum(['hold', 'resume']); }, poolId: identitySchema, commandId: identitySchema,
    get decision() { return z.strictObject({ effect: z.enum(['allow', 'deny', 'require-approval']), ruleId: identitySchema.nullable() }); },
    get state() { return z.strictObject({ previous: z.enum(['open', 'held']), next: z.enum(['open', 'held']) }).nullable(); } }),
  /**
   * A model-bound field carried hidden, bidi or tag Unicode (MODEL-INGRESS). Digests only: the raw field frame, the text the model
   * was shown, and the decoder output. The decoded payload itself is never stored and never enters the model.
   */
  z.strictObject({ get kind() { return z.literal('model-ingress'); }, fieldDigest: digest, projectedDigest: digest, get decodedDigest() { return digest.nullable(); },
    codePoints: counterSchema, get disposition() { return z.enum(['note', 'quarantine']); } }),
  /**
   * S6 (owner 2026-10-14): the pre-dispatch secret gate refused the tree a worker would receive, before any container, connection or dispatch
   * claim. `findings` names at most `AUDIT_TRACKED_PATHS_MAX` workspace-relative paths (`count` is the full number), each with the rule that
   * matched (`deny-path:<glob>`, `pattern:<id>`, `known-secret`) or, for an incomplete scan, the exhausted bound (`limit`). A value, a matched
   * substring or a digest of one is never recorded.
   */
  z.strictObject({ get kind() { return z.literal('worker-tree-refused'); }, runId: identitySchema, taskId: identitySchema, attemptId: identitySchema,
    get code() { return z.enum(['WORKER_TREE_SECRET_REFUSED', 'WORKER_TREE_SCAN_INCOMPLETE']); }, count: counterSchema,
    get findings() { return z.array(z.strictObject({ path: persistedString(z.string().min(1).max(4096)), rule: persistedString(z.string().min(1).max(600)) })).max(AUDIT_TRACKED_PATHS_MAX); },
    get limit() { return z.enum(['files', 'file-bytes', 'total-bytes', 'time']).nullable(); } }),
  /** S6 (owner 2026-10-15, 2026-10-17): hits lifted for a dispatched worker: path, rule and the exact entry that lifted it (`allowPatternPaths:<glob>` /
   * `acknowledgedDenyPaths:<path>` / `dependencyTree:<target>`, a declared dependency bind); at most `AUDIT_TRACKED_PATHS_MAX` entries, never a value. */
  z.strictObject({ get kind() { return z.literal('worker-tree-excluded'); }, runId: identitySchema, taskId: identitySchema, attemptId: identitySchema, get count() { return counterSchema.positive(); },
    get entries() { return z.array(z.strictObject({ path: persistedString(z.string().min(1).max(4096)), rule: persistedString(z.string().min(1).max(600)), by: persistedString(z.string().min(1).max(600)) })).min(1).max(AUDIT_TRACKED_PATHS_MAX); } }),
  /** Crash-loop breaker (pilot1 2026-10-17): a start found this attempt's dispatch preparation left unsettled by another process instance, i.e.
   * that process died during it. `phase` is the last preparation phase it entered (null: the record was unreadable); `aborts` counts such
   * ends since the last settle or resume; at `bound` the Run is parked (`progression-failed`, DISPATCH_PREPARATION_ABORTED) instead of dispatched. */
  z.strictObject({ get kind() { return z.literal('dispatch-preparation-aborted'); }, runId: identitySchema, taskId: identitySchema, attemptId: identitySchema,
    get phase() { return z.enum(DISPATCH_PREPARATION_PHASES).nullable(); }, get aborts() { return counterSchema.positive(); }, get bound() { return counterSchema.positive(); } }),
  /**
   * S6R-2 (owner 2026-10-23, anchor s6r-kayip-calisan-2026-10-23): one Nervous proposal, sealed before any effect and once per case (`caseId`:
   * the Attempt or scope case and the rule; the event id is derived from it). `disposition` is what the broker made of it: `shadow-only` (recorded
   * only), `proposal-only` (live, but no owner standing approval, an unmeasured rule or no executor) or `execute`. `target` names the Attempt
   * (generation null when the signal does not carry it) or null for a scope case; `evidence` is the typed signal summary, `evidenceDigest` its
   * canonical digest. Written only by the Nervous principal.
   */
  z.strictObject({ get kind() { return z.literal('recovery-detection'); }, caseId: digest, get rule() { return z.strictObject({ id: identitySchema, version: counterSchema.positive(),
    status: z.enum(NERVOUS_RULE_STATUSES) }); }, registryRevision: identitySchema, action: recoveryActionSchema,
    get disposition() { return z.enum(['shadow-only', 'proposal-only', 'execute']); },
    get target() { return z.strictObject({ runId: identitySchema, taskId: identitySchema, attemptId: identitySchema, generation: counterSchema.positive().nullable() }).nullable(); },
    evidence: recoveryEvidenceSchema, evidenceDigest: digest, get standingRef() { return identitySchema.optional(); } }),
  /**
   * S6R-5 (S6R-DESIGN §6, §9; owner Q-R1/Q-R2): one recovery decision, sealed by the recovery principal before its apply (live) or as the only record
   * (shadow: nothing else happens). `model` is the one call's channel, exact model, template and input/output digests (null: the gate, a bound, the
   * owner's grant, the role registry, the consent rule or the breaker decided without a model). `code` is the escalation code (null for a
   * continuation); `failure` the typed reason a call or its answer failed; `note` the registry note code passed on. Codes only, never model text.
   */
  z.strictObject({ get kind() { return z.literal('recovery-decision'); }, caseId: digest, get mode() { return z.enum(RECOVERY_DECISION_RECORD_MODES); }, evidenceDigest: digest,
    get target() { return z.strictObject({ runId: identitySchema, taskId: identitySchema, attemptId: identitySchema, generation: counterSchema.positive() }); },
    get gate() { return z.strictObject({ result: z.enum(['clear', 'reconciled', 'open']), settled: z.enum(['none', 'task-idempotent', 'not-declared', 'over-bound']), intents: counterSchema }); },
    /** alpha.56 G1: null only for a `would-stop` shadow decision (no stop ran, so there is no release receipt). */
    get terminationReceiptId() { return identitySchema.nullable(); },
    get model() { return z.strictObject({ channelId: identitySchema, modelId: identitySchema, template: z.strictObject({ id: identitySchema, version: counterSchema.positive() }),
      registryRevision: identitySchema, inputDigest: digest, outputDigest: digest.nullable(), invocationId: identitySchema.nullable() }).nullable(); },
    get action() { return z.enum(['continue-new-attempt', 'escalate-human']); }, get causeClass() { return z.enum(['infra-transient', 'infra-persistent', 'task-induced', 'unknown']).nullable(); },
    get note() { return z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u).nullable(); }, get code() { return identitySchema.nullable(); }, get failure() { return identitySchema.nullable(); }, get standingRef() { return identitySchema.nullable(); },
    /** S6R-6: `shadow` — this live decision adopts the sealed shadow decision of the same evidence (its model block is that call's; no second call).
     * alpha.56 G1: `would-stop` — a shadow decision of a detection whose stop step did not run, decided as if it had (never adopted by live). */
    get basis() { return z.enum(RECOVERY_DECISION_BASES).optional(); } }),
  /**
   * alpha.56 G4 (owner Q-A5): a person's blind verdict on one shadow-decided recovery case, written only by a person (the audit writer refuses
   * every AI principal). `detection`: whether the worker really was lost; `choice` (only when lost) what the person would have done. It measures
   * agreement and false positives; it changes no Run. One per case (`recovery-verdict:<caseId>`).
   */
  z.strictObject({ get kind() { return z.literal('recovery-verdict'); }, caseId: digest, decisionEventId: identitySchema, evidenceDigest: digest, get detection() { return z.enum(['lost', 'not-lost']); },
    get choice() { return z.enum(['continue-new-attempt', 'escalate-human']).nullable(); } }),
  z.strictObject({ get kind() { return z.literal('hub-client'); }, action: identitySchema, hubId: digest, commandId: identitySchema, inputDigest: digest }),
  /**
   * U9-7 (design rev 6 §11.4, v1): one SIWC worker relay record of one Attempt — a refused peer, the relay capability issued/refused, a relayed or
   * refused model exchange, a native-effect approval decision, the revocation, and the closing summary (`counters`, only on `closed`; `suppressed`
   * counts records past the registry bound). Opaque ids, digests, status, a bounded reason token and a byte count only: never a token, header,
   * prompt, body, command, path or email.
   */
  z.strictObject({ get kind() { return z.literal('siwc-relay'); }, get schemaVersion() { return z.literal(1); },
    get action() { return z.enum(['peer-refused', 'capability-issued', 'capability-refused', 'model-relayed', 'model-refused', 'approval', 'revoked', 'closed']); },
    runId: identitySchema, taskId: identitySchema, attemptId: identitySchema, get connectionId() { return persistedUuid(); }, bindingDigest: digest, policyDigest: digest,
    get requestId() { return persistedUuid().nullable(); }, get status() { return persistedInteger().min(100).max(599).nullable(); }, get reason() { return z.string().regex(/^[a-z][a-z0-9:-]{0,63}$/u).nullable(); },
    get bytes() { return counterSchema.nullable(); }, get counters() { return z.strictObject({ peersRefused: counterSchema, capabilityIssued: counterSchema, capabilityRefused: counterSchema, relayed: counterSchema,
      refused: counterSchema, upstreamSends: counterSchema, suppressed: counterSchema }).nullable(); } }),
]).superRefine((subject, context) => {
  // A null termination only with a would-stop shadow seal; a would-stop seal is shadow with no termination; a choice exactly when lost;
  // relay counters exactly on the closing summary.
  if (subject.kind === 'recovery-decision' && (subject.terminationReceiptId === null) !== (subject.basis === 'would-stop')
    || subject.kind === 'recovery-decision' && subject.basis === 'would-stop' && subject.mode !== 'shadow'
    || subject.kind === 'recovery-verdict' && (subject.choice === null) !== (subject.detection === 'not-lost')
    || subject.kind === 'siwc-relay' && (subject.counters === null) === (subject.action === 'closed')) context.addIssue({ code: z.ZodIssueCode.custom, message: 'AUDIT_SUBJECT_INCONSISTENT' });
});
/** Installer authority is OS file ownership, not a policy.administer approval. Existing governed events retain their strict shape. */
export const auditSubjectSchema = z.union([governedAuditSubjectSchema,
  z.strictObject({ get kind() { return z.literal('beuser-target-refusal'); }, get code() { return z.literal('BEUSER_TARGET_NOT_SANDBOX'); },
    get identity() { return z.strictObject({ scopeId: identitySchema, runId: identitySchema, taskId: identitySchema, attemptId: identitySchema,
      layoutRevision: identitySchema, generation: counterSchema.positive() }); }, realmId: identitySchema, get nonce() { return persistedUuid(); } }),
  z.strictObject({ get kind() { return z.literal('authority-change'); }, get installer() { return z.strictObject({ basis: z.literal('system-policy-rows'),
    packageId: identitySchema, dataRevision: counterSchema.positive(), packageDigest: digest, person: auditPrincipalSchema }); },
    get action() { return z.enum(['apply', 'rollback']); }, commandId: identitySchema, inputDigest: digest,
    get revision() { return z.strictObject({ before: identitySchema, after: identitySchema }); }, policyDigestBefore: digest, policyDigest: digest }),
  authorityDecisionSubjectSchema,
  /** BeUser D-08 (lead 2026-10-28): a work request the planner refused before any Run existed, so a person can see it later (run list, monitor,
   * report, audit list). The title is the request's first `AUDIT_SHELL_HEAD_MAX_CHARS` characters after known-secret and pattern redaction. */
  /** BeUser M-33 (owner 2026-10-28, Jev c10e0946): a person sets an accepted task's undelivered result aside (`dismiss`) or brings it back
   * (`restore`); the latest record per task decides whether /deliver and the monitor offer it. Patch and custody are untouched. */
  z.strictObject({ get kind() { return z.literal('delivery-dismissed'); }, runId: identitySchema, taskId: identitySchema, attemptId: identitySchema, get action() { return z.enum(['dismiss', 'restore']); } }),
  /** L1c (lead 2026-11-05): a person put back the files one working-tree delivery wrote (`paths` written back); the ledger delivery stays. */
  z.strictObject({ get kind() { return z.literal('delivery-rolled-back'); }, runId: identitySchema, taskId: identitySchema, attemptId: identitySchema, deliveryCommandId: identitySchema, commandId: identitySchema, paths: counterSchema }),
  z.strictObject({ get kind() { return z.literal('run-request-refused'); }, commandId: identitySchema, requestDigest: digest,
    get title() { return persistedString(z.string().min(1).max(AUDIT_SHELL_HEAD_MAX_CHARS)); }, get code() { return z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/); } }),
  /** AUDIT-CHECKPOINT wipe marker: written in the checkpoint's own transaction just before it, so checkpoint `checkpointSequence` has this record as its head. */
  z.strictObject({ get kind() { return z.literal('audit-checkpoint'); }, get checkpointSequence() { return counterSchema.positive(); }, get previousDigest() { return digest.nullable(); },
    /** An explicit operator re-baseline (witnessed human terminal, audited reason): supersedes earlier markers from this sequence on. */
    get rebaseline() { return z.strictObject({ reason: persistedString(z.string().trim().min(1).max(1024)) }).optional(); } }),
  z.strictObject({ get kind() { return z.literal('installation-pool'); }, get installer() { return z.strictObject({ basis: z.literal('file-owner') }); },
    poolId: identitySchema, get capacity() { return z.strictObject({ executionSlots: counterSchema, inFlightSlots: counterSchema }); } }),
  z.strictObject({ get kind() { return z.literal('authority-change'); }, get installer() { return z.strictObject({ basis: z.enum(['first-run', 'named-person']),
    template: z.strictObject({ id: identitySchema, version: counterSchema.positive() }), person: auditPrincipalSchema }); },
    commandId: identitySchema, inputDigest: digest, get revision() { return z.strictObject({ before: identitySchema, after: identitySchema }); },
    get counts() { return z.strictObject({ grantsAdded: counterSchema, grantsRemoved: counterSchema, bindingsAdded: counterSchema, bindingsRemoved: counterSchema }); },
    /** Lead 2026-11-09 (v20 side effect B): template rules left out because an allow already held their cell; ids only. */
    get skipped() { return z.array(z.strictObject({ ruleId: identitySchema, heldBy: identitySchema })).min(1).max(8).optional(); },
    get policyDigestBefore() { return digest.optional(); }, get policyDigest() { return digest.optional(); } }),
]);
export const auditEventSchema = z.strictObject({ get schemaVersion() { return z.literal(AUDIT_EVENT_SCHEMA_VERSION); }, eventId: identitySchema, scopeId: identitySchema,
  principal: auditPrincipalSchema, policyRevision: identitySchema, atMs: counterSchema, subject: auditSubjectSchema }).readonly();
/** The durable, sealed form: the event, its scope-local sequence and the key that sealed both (the approval MAC line). */
export const auditRecordSchema = z.strictObject({ event: auditEventSchema, get sequence() { return counterSchema.positive(); }, keyId: identitySchema, mac: digest }).readonly();
/** Summary counters (owner q5: decisions that were silent already are counted, not recorded): mutable totals, not evidence. */
export const auditCounterSchema = z.strictObject({ scopeId: identitySchema, counter: identitySchema, count: counterSchema, updatedAtMs: counterSchema }).readonly();
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditSubject = z.infer<typeof auditSubjectSchema>;
export type AuditRecord = z.infer<typeof auditRecordSchema>;
export type AuditCounter = z.infer<typeof auditCounterSchema>;
export class AuditError extends Error {
  constructor(readonly code: 'AUDIT_INVALID' | 'AUDIT_INTEGRITY' | 'AUDIT_CONFLICT' | 'AUDIT_UNAVAILABLE' | 'AUDIT_REBASELINE_REFUSED' | 'AUDIT_REBASELINE_STALE') { super(code); this.name = 'AuditError'; }
}
