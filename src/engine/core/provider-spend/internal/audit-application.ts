import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { parseProviderSpendAuditCommand, type ProviderSpendAuditCommand, type VerifiedPrincipal } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { createProviderSpendAuditReceipt, parseProviderSpendAuditReceipt, type ProviderSpendAuditReceipt } from './audit-receipt.js';
import { parseProviderSpendCheckpoint } from './checkpoint.js';
import { verifyProviderSpendIntegrity, PROVIDER_SPEND_INTEGRITY_PAGE_MAX, type ProviderSpendIntegrityReader } from './integrity.js';
import { ProviderSpendError } from './error.js';
import { ProviderSpendAuditBudget } from './audit-budget.js';
import { boundProviderSpendAuditResult, parseProviderSpendAuditResultForCommand, type ProviderSpendAuditResult } from './audit-result.js';

export interface ProviderSpendAuditAuthorization {
  authorize(action: 'audit', target: Readonly<{ scopeId: string; budgetId: string; budgetRevision: number }>,
    principal: VerifiedPrincipal): Promise<Readonly<{ revision: string; ruleId: string }>>;
}
/** Recording compares the live checkpoint and inserts one immutable command receipt in the same transaction. */
export interface ProviderSpendAuditStore {
  find(scopeId: string, commandId: string): Promise<ProviderSpendAuditReceipt | null>;
  record(receipt: ProviderSpendAuditReceipt, signal?: AbortSignal): Promise<ProviderSpendAuditResult>;
  close(): void;
}
export const providerSpendAuditWorkLimitsSchema = z.object({ pageSize: z.number().int().positive().max(PROVIDER_SPEND_INTEGRITY_PAGE_MAX),
  maxReservations: z.number().int().positive().safe(), timeoutMs: z.number().int().positive().max(2_147_483_647) }).strict();
const limitsSchema = providerSpendAuditWorkLimitsSchema.extend({ maxResultBytes: z.number().int().positive().safe() }).strict().readonly();
export type ProviderSpendAuditLimits = z.infer<typeof limitsSchema>;
function correlated(receiptInput: unknown, command: ProviderSpendAuditCommand, principal: VerifiedPrincipal) {
  const receipt = parseProviderSpendAuditReceipt(receiptInput), actor = receipt.actor;
  if (JSON.stringify(receipt.command) !== JSON.stringify(command) || actor.id !== principal.id || actor.issuer !== principal.issuer
    || actor.subject !== principal.subject || actor.assurance !== principal.assurance) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  return receipt;
}
async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ProviderSpendError) throw error;
    throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
  }
}
function close(resource: { close(): void } | undefined) {
  try { resource?.close(); } catch { throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE'); }
}

/** Explicit monetary consistency check, never a model outcome verdict or permission to alter settled charges. */
export class ProviderSpendAuditApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: ProviderSpendAuditAuthorization,
    private readonly openStore: () => Promise<ProviderSpendAuditStore>,
    private readonly openReader: () => Promise<ProviderSpendIntegrityReader>, private readonly limits: ProviderSpendAuditLimits,
    private readonly now: () => number = Date.now, private readonly elapsed: () => number = () => performance.now()) {}
  async audit(input: unknown, credential?: unknown, signal?: AbortSignal): Promise<ProviderSpendAuditResult> {
    let command: ProviderSpendAuditCommand, limits: ProviderSpendAuditLimits;
    try { command = parseProviderSpendAuditCommand(input); limits = limitsSchema.parse(this.limits); }
    catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
    const startedAtMs = this.now(), budget = new ProviderSpendAuditBudget(limits.timeoutMs, this.elapsed, signal);
    const check = () => budget.check();
    let store: ProviderSpendAuditStore | undefined, reader: ProviderSpendIntegrityReader | undefined;
    try {
      const principal = await budget.run(() => authenticate(this.verifier, credential, command.scopeId));
      const target = { scopeId: command.scopeId, budgetId: command.budgetId, budgetRevision: command.budgetRevision };
      await budget.run(() => this.authorization.authorize('audit', target, principal));
      store = await budget.run(() => storage(this.openStore), value => value.close());
      const prior = await budget.run(() => storage(() => store!.find(command.scopeId, command.commandId))); check();
      if (prior) return boundProviderSpendAuditResult(Object.freeze({ schemaVersion: 1,
        receipt: correlated(prior, command, principal), replayed: true }), limits.maxResultBytes);
      reader = await budget.run(() => storage(this.openReader), value => value.close());
      const bounded: ProviderSpendIntegrityReader = { close() {}, readPage: async query => {
        check(); const page = await budget.run(() => storage(() => reader!.readPage(query))); check();
        if (!page) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
        const checkpoint = parseProviderSpendCheckpoint(page.checkpoint), accountBudget = checkpoint.account.budget;
        if (checkpoint.digest !== command.expectedCheckpointDigest || accountBudget.scopeId !== command.scopeId
          || accountBudget.budgetId !== command.budgetId || accountBudget.revision !== command.budgetRevision) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
        if (checkpoint.reservationCount > limits.maxReservations) throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
        return page;
      } };
      const verified = await verifyProviderSpendIntegrity(bounded, command.scopeId, limits.pageSize, budget.signal); check();
      if (!verified) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
      const authorization = await budget.run(() => this.authorization.authorize('audit', target, principal)); check();
      const receipt = createProviderSpendAuditReceipt({ command, principal, authorization,
        examinedCheckpoint: verified.checkpoint, startedAtMs, completedAtMs: this.now() });
      boundProviderSpendAuditResult({ schemaVersion: 1, receipt, replayed: false }, limits.maxResultBytes);
      const result = await budget.run(() => storage(() => store!.record(receipt, budget.signal)));
      const validated = parseProviderSpendAuditResultForCommand(command, result);
      const recorded = correlated(validated.receipt, command, principal);
      if (!validated.replayed && recorded.digest !== receipt.digest) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
      return boundProviderSpendAuditResult(validated, limits.maxResultBytes);
    } finally { budget.dispose(); try { close(reader); } finally { close(store); } }
  }
}
