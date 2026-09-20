import { z } from 'zod';
import { immutableJsonObjectSchema, parseProviderSpendAuditCommand } from '#domain/index.js';
import { parseProviderSpendAuditReceipt, type ProviderSpendAuditReceipt } from './audit-receipt.js';
import { ProviderSpendError } from './error.js';

export type ProviderSpendAuditResult = Readonly<{ schemaVersion: 1; receipt: ProviderSpendAuditReceipt; replayed: boolean }>;
const resultSchema = immutableJsonObjectSchema.pipe(z.object({ schemaVersion: z.literal(1),
  receipt: z.unknown(), replayed: z.boolean() }).strict().readonly());

export function parseProviderSpendAuditResultForCommand(commandInput: unknown, resultInput: unknown): ProviderSpendAuditResult {
  let command;
  try { command = parseProviderSpendAuditCommand(commandInput); }
  catch { throw new ProviderSpendError('PROVIDER_SPEND_INVALID'); }
  const parsed = resultSchema.safeParse(resultInput);
  if (!parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const receipt = parseProviderSpendAuditReceipt(parsed.data.receipt);
  if (JSON.stringify(receipt.command) !== JSON.stringify(command)) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  return Object.freeze({ schemaVersion: 1, receipt, replayed: parsed.data.replayed });
}

/** Gate a new receipt before recording; replay has no new audit effect but still obeys delivery limits. */
export function boundProviderSpendAuditResult(result: ProviderSpendAuditResult, maxResultBytes: number): ProviderSpendAuditResult {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxResultBytes) throw new ProviderSpendError('PROVIDER_SPEND_RESULT_LIMIT');
  return result;
}
