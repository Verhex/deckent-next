import { createHash } from 'node:crypto';
import { z } from 'zod';
import { counterSchema, identitySchema, immutableJsonObjectSchema, parseProviderSpendAuditCommand,
  providerSpendAuditCommandSchema, verifiedPrincipalSchema, type ProviderSpendAuditCommand,
  type VerifiedPrincipal } from '#domain/index.js';
import { parseProviderSpendCheckpoint, type ProviderSpendCheckpoint } from './checkpoint.js';
import { ProviderSpendError } from './error.js';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const actorSchema = verifiedPrincipalSchema.unwrap().pick({ id: true, issuer: true, subject: true,
  assurance: true }).strict().readonly();
const authorizationSchema = z.object({ revision: identitySchema, ruleId: identitySchema }).strict().readonly();
const receiptSchema = z.object({ schemaVersion: z.literal(1), command: providerSpendAuditCommandSchema,
  actor: actorSchema, authorization: authorizationSchema, examinedCheckpoint: z.unknown(),
  startedAtMs: counterSchema, completedAtMs: counterSchema, digest: digestSchema }).strict().readonly();

export interface ProviderSpendAuditReceiptInput {
  readonly command: ProviderSpendAuditCommand;
  readonly principal: VerifiedPrincipal;
  readonly authorization: Readonly<{ revision: string; ruleId: string }>;
  readonly examinedCheckpoint: ProviderSpendCheckpoint;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
}
export interface ProviderSpendAuditReceipt {
  readonly schemaVersion: 1;
  readonly command: ProviderSpendAuditCommand;
  readonly actor: Readonly<Pick<VerifiedPrincipal, 'id' | 'issuer' | 'subject' | 'assurance'>>;
  readonly authorization: Readonly<{ revision: string; ruleId: string }>;
  readonly examinedCheckpoint: ProviderSpendCheckpoint;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly digest: string;
}

function receiptDigest(receipt: Omit<ProviderSpendAuditReceipt, 'digest'>): string {
  return createHash('sha256').update(`deckent.provider-spend-audit-receipt.v1\n${JSON.stringify(receipt)}`).digest('hex');
}
function validateCorrelation(command: ProviderSpendAuditCommand, checkpoint: ProviderSpendCheckpoint): void {
  const budget = checkpoint.account.budget;
  if (command.scopeId !== budget.scopeId || command.budgetId !== budget.budgetId
    || command.budgetRevision !== budget.revision || command.expectedCheckpointDigest !== checkpoint.digest) {
    throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  }
}
function construct(input: ProviderSpendAuditReceiptInput): ProviderSpendAuditReceipt {
  let command: ProviderSpendAuditCommand, principal: VerifiedPrincipal, authorization: z.infer<typeof authorizationSchema>;
  let examinedCheckpoint: ProviderSpendCheckpoint;
  try {
    command = parseProviderSpendAuditCommand(input.command);
    principal = verifiedPrincipalSchema.parse(input.principal);
    authorization = authorizationSchema.parse(input.authorization);
    examinedCheckpoint = parseProviderSpendCheckpoint(input.examinedCheckpoint);
    counterSchema.parse(input.startedAtMs); counterSchema.parse(input.completedAtMs);
  } catch (error) {
    if (error instanceof ProviderSpendError) throw error;
    throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  }
  if (!principal.scopeIds.includes(command.scopeId)) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  if (input.completedAtMs < input.startedAtMs) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  validateCorrelation(command, examinedCheckpoint);
  const withoutDigest = Object.freeze({ schemaVersion: 1 as const, command,
    actor: actorSchema.parse({ id: principal.id, issuer: principal.issuer, subject: principal.subject,
      assurance: principal.assurance }), authorization, examinedCheckpoint,
    startedAtMs: input.startedAtMs, completedAtMs: input.completedAtMs });
  return Object.freeze({ ...withoutDigest, digest: receiptDigest(withoutDigest) });
}

export function createProviderSpendAuditReceipt(input: ProviderSpendAuditReceiptInput): ProviderSpendAuditReceipt {
  return construct(input);
}

export function parseProviderSpendAuditReceipt(input: unknown): ProviderSpendAuditReceipt {
  const copied = immutableJsonObjectSchema.safeParse(input), parsed = copied.success && receiptSchema.safeParse(copied.data);
  if (!parsed || !parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const examinedCheckpoint = parseProviderSpendCheckpoint(parsed.data.examinedCheckpoint);
  const receipt = construct({ command: parsed.data.command, principal: { ...parsed.data.actor, scopeIds: [parsed.data.command.scopeId] },
    authorization: parsed.data.authorization, examinedCheckpoint,
    startedAtMs: parsed.data.startedAtMs, completedAtMs: parsed.data.completedAtMs });
  if (receipt.digest !== parsed.data.digest) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  return receipt;
}
