import { isDeepStrictEqual } from 'node:util';
import { parseProviderSpendManagementCommand, parseProviderSpendBudget, modelActivationActorSchema, modelActivationAuthorizationSchema,
  type ProviderSpendManagementCommand, type ModelInvocationActor, type ModelInvocationAuthorization, type VerifiedPrincipal, immutableJsonObjectSchema } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { parseProviderSpendAccount, parseProviderSpendReservation, providerSpendEvidenceDigest, type ProviderSpendAccount } from './account.js';
import { canonicalProviderSpendExactMinorUnits, ceilProviderSpendExactMinorUnits, addProviderSpendExactMinorUnits } from './exact.js';
import { parseProviderSpendCheckpoint, type ProviderSpendCheckpoint } from './checkpoint.js';
import { ProviderSpendError } from './error.js';
export interface ProviderSpendManagementAuthorization {
  authorize(action: 'reconcile' | 'budget-revision', target: { scopeId: string; budgetId: string; budgetRevision: number },
    principal: VerifiedPrincipal): Promise<ModelInvocationAuthorization>;
}
export interface ProviderSpendManagementReceipt {
  readonly schemaVersion: 1; readonly command: ProviderSpendManagementCommand; readonly actor: ModelInvocationActor;
  readonly authorization: ModelInvocationAuthorization; readonly recordedAtMs: number;
  readonly before: ProviderSpendCheckpoint; readonly after: ProviderSpendAccount; readonly digest: string;
}
export interface ProviderSpendManagementResult { readonly receipt: ProviderSpendManagementReceipt; readonly replayed: boolean }
export interface ProviderSpendManagementStore {
  apply(command: ProviderSpendManagementCommand, actor: ModelInvocationActor, authorization: ModelInvocationAuthorization,
    recordedAtMs: number, maxResultBytes: number): Promise<ProviderSpendManagementResult>;
  close(): void;
}
export function parseProviderSpendManagementReceipt(input: ProviderSpendManagementReceipt): ProviderSpendManagementReceipt {
  if (!input || typeof input !== 'object' || Object.keys(input).length !== 8 || !['schemaVersion', 'command', 'actor', 'authorization', 'recordedAtMs', 'before', 'after', 'digest'].every(key => Object.hasOwn(input, key))
    || !immutableJsonObjectSchema.safeParse(input).success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const command = parseProviderSpendManagementCommand(input.command), actor = modelActivationActorSchema.parse(input.actor),
    authorization = modelActivationAuthorizationSchema.parse(input.authorization), before = parseProviderSpendCheckpoint(input.before),
    after = parseProviderSpendAccount(input.after);
  const { digest, ...body } = input;
  if (input.schemaVersion !== 1 || !Number.isSafeInteger(input.recordedAtMs) || input.recordedAtMs < 0
    || command.expectedCheckpointDigest !== before.digest || command.scopeId !== before.account.budget.scopeId
    || command.budgetId !== before.account.budget.budgetId || command.budgetRevision !== before.account.budget.revision
    || after.budget.scopeId !== command.scopeId || after.budget.budgetId !== command.budgetId
    || (command.kind === 'budget-revision' ? !isDeepStrictEqual(after, reviseProviderSpendBudget(before.account, command))
      : !isDeepStrictEqual(after.budget, before.account.budget) || after.reservedMinorUnits > before.account.reservedMinorUnits
        || after.settledExactMinorUnits !== addProviderSpendExactMinorUnits(before.account.settledExactMinorUnits, command.exactMinorUnits)
        || (before.account.frozen && !after.frozen))
    || providerSpendEvidenceDigest(body) !== digest
    || !isDeepStrictEqual(command, input.command) || !isDeepStrictEqual(actor, input.actor)
    || !isDeepStrictEqual(authorization, input.authorization)) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  return Object.freeze({ ...input, command, actor, authorization, before, after });
}
/** Held money has one governed exit. Settled reservations cannot be changed by any correction. */
export function reconcileProviderSpend(accountInput: unknown, reservationInput: unknown, command: Extract<ProviderSpendManagementCommand, { kind: 'reconcile' }>, receiptDigest: string) {
  const account = parseProviderSpendAccount(accountInput), reservation = parseProviderSpendReservation(reservationInput), d = reservation.descriptor;
  const exact = canonicalProviderSpendExactMinorUnits(command.exactMinorUnits);
  if (reservation.disposition.state !== 'held' || reservation.reconciliation || command.invocationId !== d.invocationId
    || command.scopeId !== d.scopeId || d.budgetId !== account.budget.budgetId || d.currency !== account.budget.currency
    || d.budgetRevision > account.budget.revision || account.reservedMinorUnits < d.quote.maxChargeMinorUnits
    || (command.resolution !== 'settle' && exact !== '0')
    || (command.resolution === 'write-off') !== (command.evidence.kind === 'write-off')) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  const settled = addProviderSpendExactMinorUnits(account.settledExactMinorUnits, exact);
  return Object.freeze({ account: parseProviderSpendAccount({ ...account, reservedMinorUnits: account.reservedMinorUnits - d.quote.maxChargeMinorUnits,
    settledExactMinorUnits: settled, settledMinorUnits: ceilProviderSpendExactMinorUnits(settled),
    frozen: account.frozen || ceilProviderSpendExactMinorUnits(exact) > d.quote.maxChargeMinorUnits }),
    reservation: parseProviderSpendReservation({ ...reservation, schemaVersion: 3, reconciliation: { commandId: command.commandId,
      budgetRevision: command.budgetRevision, resolution: command.resolution, exactMinorUnits: exact, evidenceKind: command.evidence.kind,
      evidenceDigest: command.evidence.digest, receiptDigest } }) });
}
export function reviseProviderSpendBudget(accountInput: unknown, command: Extract<ProviderSpendManagementCommand, { kind: 'budget-revision' }>) {
  const account = parseProviderSpendAccount(accountInput), budget = parseProviderSpendBudget(command.budget);
  if (budget.scopeId !== account.budget.scopeId || budget.budgetId !== account.budget.budgetId || budget.currency !== account.budget.currency
    || budget.revision !== account.budget.revision + 1) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  return parseProviderSpendAccount({ ...account, budget, budgetRevisionDigest: providerSpendEvidenceDigest(command), budgetRevisionCommandId: command.commandId, ...(command.unfreeze ? { frozen: false, unfrozenAtBudgetRevision: budget.revision } : {}) });
}
export class ProviderSpendManagementApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: ProviderSpendManagementAuthorization,
    private readonly openStore: () => Promise<ProviderSpendManagementStore>, private readonly now: () => number = Date.now) {}
  async execute(input: unknown, credential?: unknown, maxResultBytes = Number.MAX_SAFE_INTEGER): Promise<ProviderSpendManagementResult> {
    if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes <= 0) throw new ProviderSpendError('PROVIDER_SPEND_RESULT_LIMIT');
    let command: ProviderSpendManagementCommand;
    try { command = parseProviderSpendManagementCommand(input); } catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
    if (command.kind === 'reconcile') canonicalProviderSpendExactMinorUnits(command.exactMinorUnits);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    const actor = modelActivationActorSchema.parse({ id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance });
    const authorization = modelActivationAuthorizationSchema.parse(await this.authorization.authorize(command.kind, command, principal));
    const store = await this.openStore();
    try {
      const result = await store.apply(command, actor, authorization, this.now(), maxResultBytes);
      const receipt = parseProviderSpendManagementReceipt(result.receipt);
      if (!isDeepStrictEqual(receipt.command, command) || !isDeepStrictEqual(receipt.actor, actor)) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
      if (Buffer.byteLength(JSON.stringify(result)) > maxResultBytes) throw new ProviderSpendError('PROVIDER_SPEND_RESULT_LIMIT');
      return Object.freeze({ ...result, receipt });
    } finally { store.close(); }
  }
}

/** Strict shared result parser for SDK and runtime clients. */
export function parseProviderSpendManagementResultForCommand(command: ProviderSpendManagementCommand, input: unknown): ProviderSpendManagementResult {
  if (!input || typeof input !== 'object' || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'receipt') || !Object.hasOwn(input, 'replayed')) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const result = input as ProviderSpendManagementResult, receipt = parseProviderSpendManagementReceipt(result.receipt);
  if (!isDeepStrictEqual(receipt.command, command) || typeof result.replayed !== 'boolean') throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  return Object.freeze({ receipt, replayed: result.replayed });
}
