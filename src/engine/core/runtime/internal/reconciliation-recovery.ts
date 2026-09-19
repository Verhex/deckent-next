import { z } from 'zod';
import { Buffer } from 'node:buffer';
import { attemptIdentitySchema, identitySchema } from '#domain/index.js';
import { dispatchTerminalSchema, type DispatchInventoryPage } from '#engine/core/dispatch/index.js';

const inputSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, after: identitySchema.nullable() }).strict().readonly();
const entrySchema = z.object({
  identity: attemptIdentitySchema, owner: identitySchema, launch: z.enum(['pending', 'granted', 'prevented-before-launch']),
  terminal: dispatchTerminalSchema.nullable(), cancellationRequested: z.boolean(), outputRecorded: z.boolean(),
}).strict();
const pageSchema = z.object({ entries: z.array(entrySchema), nextAfter: identitySchema.nullable() }).strict();
export type ReconciliationRecoveryCommand = z.infer<typeof inputSchema>;
export interface ReconciliationRecoveryInventory { inspect(command: ReconciliationRecoveryCommand & { limit: number }): Promise<DispatchInventoryPage> }
export interface ReconciliationRecoveryExecutor {
  reconcile(identity: z.infer<typeof attemptIdentitySchema>): Promise<Readonly<{ status: 'terminal' | 'unresolved' | 'prevented'; outputRecorded: boolean }>>;
  recoverOutput(identity: z.infer<typeof attemptIdentitySchema>): Promise<Readonly<{ completeness: 'complete' | 'partial' | 'unavailable' }>>;
}
export interface ReconciliationRecoveryOptions { readonly maxPageSize: number; readonly maxConcurrentReconciliations: number }
export class ReconciliationRecoveryError extends Error { constructor(readonly code: 'RECONCILIATION_RECOVERY_INVALID') { super(code); this.name = 'ReconciliationRecoveryError'; } }
export type ReconciliationRecoveryOutcome = Readonly<{ identity: z.infer<typeof attemptIdentitySchema>; status: 'terminal' | 'unresolved' | 'prevented' | 'output-recovered' | 'skipped' | 'failed'; completeness?: 'complete' | 'partial' | 'unavailable'; reason?: 'denied' | 'unavailable' }>;
export type ReconciliationRecoveryPage = Readonly<{ nextAfter: string | null; outcomes: readonly ReconciliationRecoveryOutcome[] }>;

function failureReason(error: unknown): 'denied' | 'unavailable' {
  const code = z.object({ code: z.string() }).passthrough().safeParse(error);
  return code.success && ['AUTHENTICATION_REQUIRED', 'AUTHENTICATION_SCOPE_DENIED', 'POLICY_DENIED'].includes(code.data.code)
    ? 'denied' : 'unavailable';
}
function follows(value: string, previous: string) {
  return Buffer.compare(Buffer.from(value, 'utf8'), Buffer.from(previous, 'utf8')) > 0;
}

/** Inventory is validated completely before effects; executors must freshly authorize every identity. */
export class ReconciliationRecoveryApplication {
  private readonly options: ReconciliationRecoveryOptions;
  constructor(private readonly inventory: ReconciliationRecoveryInventory, private readonly executor: ReconciliationRecoveryExecutor,
    options: ReconciliationRecoveryOptions) {
    if (!Number.isSafeInteger(options.maxPageSize) || options.maxPageSize < 1 || !Number.isSafeInteger(options.maxConcurrentReconciliations) || options.maxConcurrentReconciliations < 1) throw new ReconciliationRecoveryError('RECONCILIATION_RECOVERY_INVALID');
    this.options = Object.freeze({ ...options });
  }
  async recover(input: unknown): Promise<ReconciliationRecoveryPage> {
    const command = inputSchema.parse(input);
    const page = this.validate(command, await this.inventory.inspect({ ...command, limit: this.options.maxPageSize }));
    const outcomes: ReconciliationRecoveryOutcome[] = new Array(page.entries.length);
    for (let index = 0; index < page.entries.length; index += this.options.maxConcurrentReconciliations) {
      await Promise.all(page.entries.slice(index, index + this.options.maxConcurrentReconciliations).map(async (entry, offset) => {
        const at = index + offset, identity = entry.identity;
        try { outcomes[at] = await this.recoverEntry(entry); }
        catch (error) { outcomes[at] = Object.freeze({ identity, status: 'failed', reason: failureReason(error) }); }
      }));
    }
    return Object.freeze({ nextAfter: page.nextAfter, outcomes: Object.freeze(outcomes) });
  }
  private async recoverEntry(entry: z.infer<typeof entrySchema>): Promise<ReconciliationRecoveryOutcome> {
    const identity = entry.identity;
    if (entry.launch !== 'granted') return Object.freeze({ identity, status: 'skipped' });
    if (entry.terminal === null) {
      const result = await this.executor.reconcile(identity);
      if (result.status !== 'terminal' || result.outputRecorded) return Object.freeze({ identity, status: result.status });
    } else if (entry.outputRecorded) return Object.freeze({ identity, status: 'skipped' });
    const recovered = await this.executor.recoverOutput(identity);
    return Object.freeze({ identity, status: 'output-recovered', completeness: recovered.completeness });
  }
  private validate(command: ReconciliationRecoveryCommand, value: unknown) {
    let page: z.infer<typeof pageSchema>;
    try { page = pageSchema.parse(value); } catch { throw new ReconciliationRecoveryError('RECONCILIATION_RECOVERY_INVALID'); }
    if (page.entries.length > this.options.maxPageSize) throw new ReconciliationRecoveryError('RECONCILIATION_RECOVERY_INVALID');
    const ids = new Set<string>();
    let previous = command.after;
    for (const entry of page.entries) {
      if (entry.identity.scopeId !== command.scopeId || ids.has(entry.identity.attemptId)) throw new ReconciliationRecoveryError('RECONCILIATION_RECOVERY_INVALID');
      if (previous !== null && !follows(entry.identity.attemptId, previous)) throw new ReconciliationRecoveryError('RECONCILIATION_RECOVERY_INVALID');
      previous = entry.identity.attemptId;
      ids.add(entry.identity.attemptId);
    }
    if ((page.nextAfter !== null && page.entries.length === 0) || (page.nextAfter !== null && page.nextAfter !== page.entries.at(-1)!.identity.attemptId)) throw new ReconciliationRecoveryError('RECONCILIATION_RECOVERY_INVALID');
    return page;
  }
}
