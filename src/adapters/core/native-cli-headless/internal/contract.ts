import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';

/** S3 headless model step: the unmodified CLI as one tool-less, MCP-less turn behind the model-invocation port (design S3 rev 2). */
export const NATIVE_CLI_HEADLESS_ADAPTER = Object.freeze({ id: 'native-cli-headless', version: 1 });
const path = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0') && !/\/\.\.?(?:\/|$)/u.test(value));
/**
 * The sealed adapter definition (written by the connect path, S3-3): the executable's realpath, the person's uid and CLI config directory,
 * this connection's private state directory (run dir `<stateDir>/run`, preflight record), the catalog row's minimum CLI version, and the
 * delegated-use consent (enforced by S3-3; recorded here so the profile digest seals it). Deckent never opens the config directory's files.
 */
export const nativeCliHeadlessDefinitionSchema = z.object({ schemaVersion: z.literal(1), executable: path, configDir: path, stateDir: path,
  ownerUid: counterSchema, minCliVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  delegatedUse: z.object({ consentedBy: identitySchema, atMs: counterSchema, classes: z.array(z.enum(['ai', 'system'])).min(1).max(2).readonly() }).strict().readonly().nullable(),
}).strict().readonly();
export type NativeCliHeadlessDefinition = z.infer<typeof nativeCliHeadlessDefinitionSchema>;
export const isNativeCliHeadlessAdapter = (adapter: Readonly<{ id: string; version: number }>) =>
  adapter.id === NATIVE_CLI_HEADLESS_ADAPTER.id && adapter.version === NATIVE_CLI_HEADLESS_ADAPTER.version;
/** Typed refusals before any claim (EN/TR family `headless`). Params carry check names only: never a path, account field or output. */
export type HeadlessRefusalCode = 'HEADLESS_CLI_UNAVAILABLE' | 'HEADLESS_OWNER_MISMATCH' | 'HEADLESS_PREFLIGHT_FAILED' | 'HEADLESS_LOGIN_REQUIRED' | 'HEADLESS_REQUEST_INVALID';
export function refuse(code: HeadlessRefusalCode, params?: Record<string, string>): never { throw ErrorRegistry.createError(code, params ? { params } : undefined); }
/**
 * The adapter-composed body of a rejected receipt (never CLI output, model text or stderr), so a consumer (S3-4) can name the cause:
 * `guard` (field), `model-mismatch`, `quota` (resetsAtMs), `credits-required`, `login-required`, `invalid-output` (subtype), `provider-error`
 * (status), `response-limit`.
 */
export const headlessRejectionBodySchema = z.object({ schemaVersion: z.literal(1),
  refusal: z.enum(['guard', 'model-mismatch', 'quota', 'credits-required', 'login-required', 'invalid-output', 'provider-error', 'response-limit']),
  field: z.string().max(64).optional(), subtype: z.string().max(64).optional(), resetsAtMs: counterSchema.nullable().optional(), status: counterSchema.nullable().optional(),
}).strict().readonly();
export type HeadlessRejectionBody = z.infer<typeof headlessRejectionBodySchema>;
