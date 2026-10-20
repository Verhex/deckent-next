import { randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, evaluatePolicy, policySchema, type AuditEvent } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';

/** Where an approved install comes from (audited; never a command line, path or password). */
export type ExecutionInstallSource = Readonly<{ distribution: string; codename: string; fingerprint: string }>;
export type ExecutionInstallOutcome = Readonly<{ status: 'succeeded' | 'failed' | 'uncertain'; step: number | null; exitCode: number | null; version: string | null }>;
export type ExecutionInstallDecision = Readonly<{ effect: 'allow' | 'deny' | 'require-approval'; ruleId: string | null; revision: string }>;
export type ExecutionInstallRequest = Readonly<{ environment: string; scopeId: string; principal: Readonly<{ id: string; issuer: string; subject: string;
  assurance: 'os-user' | 'token-verified' | 'workload-verified' }>; source: ExecutionInstallSource }>;

/** `execution-environment` / `install` (policy v13): installation-wide like backup, so only a grant over all scopes allows it; the AI floor
 * (domain) already denies every AI actor whatever a policy grants. */
export function policyExecutionInstallAuthorization(input: unknown) {
  const document = policySchema.parse(input);
  return (request: ExecutionInstallRequest): ExecutionInstallDecision => {
    const decision = evaluatePolicy(document, { principal: { ...request.principal, scopeIds: [request.scopeId] }, scopeId: request.scopeId, action: 'install',
      resource: { kind: 'execution-environment', id: request.environment } });
    const scopes = document.grants.find(rule => rule.id === decision.ruleId)?.scopes;
    return { effect: decision.decision === 'allow' && scopes !== 'all' ? 'deny' : decision.decision, ruleId: decision.ruleId ?? null, revision: decision.revision };
  };
}

/**
 * The one owner of the approved host install (INIT-D2 cond. 4; ANALYSIS §11(c)8): decide → (refused: audit, typed refusal, nothing runs) →
 * the person's card → audit intent before the first privileged step → the adapter's effect → audit its end. A thrown effect is recorded as
 * `uncertain`; the next state is never taken from the outcome but from a fresh detection by the caller, and nothing is retried here.
 */
export class ExecutionEnvironmentInstallApplication {
  constructor(private readonly authorize: (request: ExecutionInstallRequest) => ExecutionInstallDecision, private readonly audit: (event: AuditEvent) => Promise<void>,
    private readonly now: () => number = Date.now) {}
  async install(request: ExecutionInstallRequest, effect: Readonly<{ confirm: () => Promise<boolean>; apply: () => Promise<ExecutionInstallOutcome> }>): Promise<ExecutionInstallOutcome | 'declined'> {
    const decision = this.authorize(request), operationId = randomUUID();
    const record = (phase: 'intent' | 'refused' | ExecutionInstallOutcome['status'], outcome?: ExecutionInstallOutcome) => this.audit({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION,
      eventId: randomUUID(), scopeId: request.scopeId, principal: { issuer: request.principal.issuer, subject: request.principal.subject }, policyRevision: decision.revision,
      atMs: this.now(), subject: { kind: 'execution-environment-install', operationId, environment: request.environment, source: request.source, phase, step: outcome?.step ?? null,
        exitCode: outcome?.exitCode ?? null, version: outcome?.version ?? null, decision: { effect: decision.effect, ruleId: decision.ruleId } } });
    if (decision.effect !== 'allow') {
      await record('refused');
      throw ErrorRegistry.createError('SETUP_INSTALL_DENIED', { params: { environment: request.environment } });
    }
    if (!await effect.confirm()) return 'declined';
    await record('intent');
    let outcome: ExecutionInstallOutcome;
    try { outcome = await effect.apply(); } catch (error) { await record('uncertain'); throw error; }
    await record(outcome.status, outcome);
    return outcome;
  }
}
