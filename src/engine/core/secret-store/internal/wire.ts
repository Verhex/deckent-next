import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { SECRET_NAME_PATTERN, SECRET_STORE_ID_PATTERN, SECRET_VALUE_MAX_BYTES, isSecretName, isSecretValue } from './port.js';

/**
 * Runtime service wire shapes of a secret change (SECRET-WRITE, protocol v18 `setSecret` / `deleteSecret`). No actor field: the socket peer
 * is the principal. The value is bounded by length only here (a UTF-8 value of at most 64 KiB has at most that many UTF-16 units); the byte
 * bound and emptiness are the application's typed `SECRET_VALUE_INVALID`. A schema failure never echoes the value (the protocol collapses it).
 */
const name = z.string().regex(SECRET_NAME_PATTERN);
export const secretSetCommandSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, name,
  value: z.string().min(1).max(SECRET_VALUE_MAX_BYTES) }).strict().readonly();
export const secretDeleteCommandSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, name }).strict().readonly();
/** The answer: which backend changed; `removed` is whether a delete found the secret (null for a set). Never a value. */
export const secretChangeResultSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, name, action: z.enum(['set', 'delete']),
  backend: z.string().min(1).max(128), removed: z.boolean().nullable() }).strict().readonly();
export type SecretSetCommand = z.infer<typeof secretSetCommandSchema>;
export type SecretDeleteCommand = z.infer<typeof secretDeleteCommandSchema>;
export type SecretChangeResult = z.infer<typeof secretChangeResultSchema>;

/** The client's check before anything is sent: typed name/value refusals that never echo the argument (`CLI_USAGE` for any other shape). */
export function prepareSecretChange(operation: 'setSecret' | 'deleteSecret', input: SecretSetCommand | SecretDeleteCommand): SecretSetCommand | SecretDeleteCommand {
  if (!isSecretName(input.name)) throw ErrorRegistry.createError('SECRET_NAME_INVALID');
  if (operation === 'setSecret' && !isSecretValue((input as SecretSetCommand).value)) throw ErrorRegistry.createError('SECRET_VALUE_INVALID');
  const parsed = (operation === 'setSecret' ? secretSetCommandSchema : secretDeleteCommandSchema).safeParse(input);
  if (!parsed.success) throw ErrorRegistry.createError('CLI_USAGE');
  return parsed.data;
}
/** An answer is trusted only for the change that was asked (same scope, name and action); anything else is null (a transport fault). */
export function acceptSecretChangeResult(operation: 'setSecret' | 'deleteSecret', command: SecretDeleteCommand, answer: unknown): SecretChangeResult | null {
  const result = secretChangeResultSchema.safeParse(answer);
  return result.success && result.data.scopeId === command.scopeId && result.data.name === command.name
    && result.data.action === (operation === 'setSecret' ? 'set' : 'delete') ? result.data : null;
}

/** SECRET-STORE-SWITCH (owner 2026-10-08; runtime protocol v24): move every secret into another registered store
 * and select it; no actor field. */
const storeId = z.string().max(128).regex(SECRET_STORE_ID_PATTERN);
export const secretStoreSwitchCommandSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, to: storeId,
  confirmDowngrade: z.boolean(), confirmEnvMissing: z.boolean().optional() }).strict().readonly();
/** The answer names stores and counts only: never a secret name or value. */
export const secretStoreSwitchResultSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, status: z.enum(['switched', 'current']),
  from: storeId, to: storeId, entries: z.number().int().nonnegative().safe(), downgrade: z.boolean(), cleaned: z.boolean() }).strict().readonly();
export type SecretStoreSwitchCommand = z.infer<typeof secretStoreSwitchCommandSchema>;
/** An answer is trusted only for the switch that was asked (same scope and target); anything else is null (a transport fault). */
export function acceptSecretStoreSwitchResult(command: SecretStoreSwitchCommand, answer: unknown) {
  const result = secretStoreSwitchResultSchema.safeParse(answer);
  return result.success && result.data.scopeId === command.scopeId && result.data.to === command.to ? result.data : null;
}
