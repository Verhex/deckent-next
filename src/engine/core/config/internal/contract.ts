import type { z } from 'zod';
import { DeckentError, ErrorRegistry } from '#platform/index.js';
import type { ApprovalSubject, AuditEvent, VerifiedPrincipal } from '#domain/index.js';
import type { DeckentConfig } from '#platform/index.js';
import type { Environment } from '#platform/index.js';
export type ConfigLayer = 'project' | 'global';
export type ConfigSource = 'default' | ConfigLayer | 'env';
export interface ConfigFieldView {
  readonly key: string; readonly value: unknown; readonly defaultValue: unknown; readonly source: ConfigSource;
  readonly descriptionKey: string; readonly description: string; readonly schema: unknown;
  readonly binding: { readonly state: 'bound'; readonly consumers: readonly string[] } | { readonly state: 'declared-only'; readonly reason: string };
  readonly apply: 'live' | 'restart'; readonly redacted: boolean;
}
export interface ConfigSnapshot {
  readonly document: Record<string, unknown>; readonly global: Record<string, unknown>; readonly project: Record<string, unknown>;
  readonly effective: DeckentConfig; readonly digest: string | null; readonly layer: ConfigLayer; readonly env: Environment;
}
export interface ConfigWriteInput {
  readonly keyPath: string; readonly value?: unknown; readonly layer?: ConfigLayer; readonly expect?: string | null;
  readonly principal: VerifiedPrincipal; readonly scopeId: string; readonly commandId: string;
}
export interface ConfigWriteResult {
  readonly keyPath: string; readonly layer: ConfigLayer; readonly beforeDigest: string | null; readonly afterDigest: string;
  readonly backupPath: string | null; readonly overridden: boolean;
}
export interface ConfigPlan { readonly document: Record<string, unknown>; readonly event: AuditEvent }
export interface ConfigDocumentPort {
  snapshot(layer: ConfigLayer): Promise<ConfigSnapshot>;
  publish(input: ConfigWriteInput, plan: (snapshot: ConfigSnapshot) => Promise<ConfigPlan>): Promise<ConfigWriteResult>;
}
export interface ConfigAuthorityPort {
  /** Allow-only authorization (`require-approval` is `POLICY_APPROVAL_UNSUPPORTED`): `set`/`unset` and every caller without approvals. */
  authorize(input: ConfigWriteInput): Promise<string>;
  audit(event: AuditEvent): Promise<void>;
  /** T3 L2: the approval-aware write path of `submit`; absent, `submit` behaves as `set`/`unset`. */
  readonly approvals?: ConfigApprovalPort;
}
/** The policy decision of one config write (`deny` is thrown, never returned); `ruleId` names the rule that decided. */
export interface ConfigAuthorization { readonly decision: 'allow' | 'require-approval'; readonly revision: string; readonly ruleId: string | null }
export type ConfigChangeSubject = Extract<ApprovalSubject, { kind: 'config-change' }>;
export type ConfigApprovalAdmission =
  | { readonly pending: { readonly approvalId: string; readonly revision: number; readonly expiresAt: number; readonly summary: string } }
  | { readonly approved: { readonly approvalId: string; readonly actionDigest: string } };
/**
 * T3 L2 CONFIG-APPROVAL (Jev 9181d2be): the policy decision under the current policy and the approval broker of exactly one change. Trusted
 * composition binds the principal's policy, the approval store and the card's words (the requester's language); no surface or model supplies them.
 */
export interface ConfigApprovalPort {
  evaluate(input: ConfigWriteInput): Promise<ConfigAuthorization>;
  admit(input: ConfigWriteInput, subject: ConfigChangeSubject, authorization: ConfigAuthorization): Promise<ConfigApprovalAdmission>;
}
/** What `submit` did: applied (with the approval it consumed, if one was needed) or nothing written and an approval pending. */
export type ConfigChangeOutcome =
  | { readonly status: 'applied'; readonly result: ConfigWriteResult; readonly approvalId: string | null }
  | { readonly status: 'approval-pending'; readonly commandId: string; readonly expect: string | null; readonly keyPath: string; readonly layer: ConfigLayer;
    readonly approval: { readonly approvalId: string; readonly revision: number; readonly expiresAt: number; readonly summary: string } };
export class ConfigApplicationError extends DeckentError {
  constructor(code: string) {
    const error = ErrorRegistry.createError(code);
    super(code, error.message, error.suggestion, error.docLink, error.whatHappened, error.why, error.howToFix, error.category, undefined, error.localize, error.params);
    this.name = 'ConfigApplicationError';
  }
}
export interface ConfigDefinition { readonly schema: z.ZodTypeAny; readonly descriptionKey: string;
  readonly binding: ConfigFieldView['binding']; readonly apply: ConfigFieldView['apply'] }
