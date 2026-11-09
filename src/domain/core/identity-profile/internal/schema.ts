import { CodedError, persistedString, persistedInteger, createImmutableJsonObjectSchema, identitySchema } from '#domain/core/primitives/index.js';
import { z } from 'zod';
import limits from './limits.json' with { type: 'json' };
import { companyIdSchema, policyRoleSchema } from '#domain/core/policy/index.js';
/** Bounded v1 transport, not an installation capacity limit. */
export const IDENTITY_PROFILE_LIMITS = Object.freeze(limits);
export const identityProfileJsonSchema = createImmutableJsonObjectSchema(IDENTITY_PROFILE_LIMITS);
const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/);
const key = z.string().regex(/^[a-z][a-zA-Z0-9_.-]{0,127}$/);
export const identityProfileRefSchema = z.strictObject({ get id() { return z.string().regex(/^[a-z0-9][a-z0-9.-]{0,62}:[a-z0-9][a-z0-9._-]{0,62}$/); }, get version() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER); } }).readonly();
export const identityProfileDefinitionSchema = identityProfileJsonSchema.pipe(z.strictObject({
  get schemaVersion() { return z.literal(1); }, ...identityProfileRefSchema.unwrap().shape, labelKey: key,
  get defaults() { return z.strictObject({ projectSelection: z.literal('current-projects'), preserveExisting: z.literal(true), showOrganization: z.boolean() }).readonly(); },
  get roleTemplates() { return z.array(policyRoleSchema).max(64).readonly(); },
  get approvalPolicyTemplate() { return z.strictObject({ adminApprovalRequired: z.literal(true), secondPerson: z.enum(['disabled', 'founder-choice']) }).readonly(); },
  get hierarchyOptions() { return z.strictObject({ nodeKinds: z.array(z.enum(['site', 'unit'])).max(2).readonly(), futureProjects: z.literal('explicit-draft-only') }).readonly(); },
  get requires() { return z.array(z.strictObject({ id: identitySchema, version: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }).readonly()).max(64).readonly(); },
}).superRefine((value, ctx) => {
  if (new Set(value.roleTemplates.map(role => role.id)).size !== value.roleTemplates.length
    || value.roleTemplates.some(role => new Set(role.permissions.map(p => p.id)).size !== role.permissions.length)
    || new Set(value.hierarchyOptions.nodeKinds).size !== value.hierarchyOptions.nodeKinds.length
    || new Set(value.requires.map(r => r.id)).size !== value.requires.length) ctx.addIssue({ code: 'custom', message: 'IDENTITY_PROFILE_INVALID' });
}).readonly());
export type IdentityProfileDefinition = z.infer<typeof identityProfileDefinitionSchema>;
export type IdentityProfileRef = z.infer<typeof identityProfileRefSchema>;
export const identityProfilePackageSchema = identityProfileJsonSchema.pipe(z.strictObject({ get schemaVersion() { return z.literal(1); }, namespace: slug,
  source: identitySchema, get digest() { return z.string().regex(/^[a-f0-9]{64}$/); }, definition: identityProfileDefinitionSchema,
  get labels() { return z.strictObject({ en: persistedString(z.string().min(1).max(256)), tr: persistedString(z.string().min(1).max(256)) }).readonly(); },
}).readonly());
export type IdentityProfilePackage = z.infer<typeof identityProfilePackageSchema>;
const principalRef = z.strictObject({ issuer: identitySchema, subject: identitySchema }).readonly();
const member = z.strictObject({ id: slug, principal: principalRef, get label() { return persistedString(z.string().min(1).max(256)); },
  get kind() { return z.enum(['human', 'machine', 'agent']); }, get organizationNodeId() { return slug.optional(); } }).readonly();
const node = z.strictObject({ id: slug, get kind() { return z.enum(['site', 'unit']); }, companyId: companyIdSchema, get parentId() { return slug.nullable(); }, get label() { return persistedString(z.string().min(1).max(256)); } }).readonly();
const previewShape = z.strictObject({ get schemaVersion() { return z.literal(1); }, profile: identityProfileRefSchema,
  scopeId: identitySchema, get projectScopeIds() { return z.array(identitySchema).min(1).max(128).readonly().optional(); },
  get members() { return z.array(member).max(1024).readonly(); }, get organization() { return z.array(node).max(1024).readonly(); },
  get assignments() { return z.array(z.strictObject({ id: slug, memberId: slug, roleId: slug, scopeIds: z.array(identitySchema).min(1).max(128).readonly() }).readonly()).max(1024).readonly(); },
  get removeBindingIds() { return z.array(slug).max(1024).readonly(); }, get includeFutureProjects() { return z.boolean().optional(); },
});
export const identityPreviewInputSchema = identityProfileJsonSchema.pipe(previewShape.readonly());
export const identityPreviewRequestSchema = identityProfileJsonSchema.pipe(previewShape.extend({ profile: identityProfileRefSchema.optional() }).readonly());
export const identityProfileConfigSchema = z.strictObject({ profile: identityProfileRefSchema, get packages() { return z.array(identityProfilePackageSchema).max(64).optional(); } });
export type IdentityPreviewInput = z.infer<typeof identityPreviewInputSchema>;
export type IdentityProfileErrorCode = 'IDENTITY_PROFILE_INVALID' | 'IDENTITY_PROFILE_NAMESPACE_UNKNOWN' | 'IDENTITY_PROFILE_VERSION_UNKNOWN'
  | 'IDENTITY_PROFILE_UNKNOWN' | 'IDENTITY_PROFILE_SHADOW' | 'IDENTITY_PROFILE_DIGEST_MISMATCH' | 'IDENTITY_PREVIEW_INVALID'
  | 'IDENTITY_PREVIEW_SCOPE_DENIED' | 'IDENTITY_PREVIEW_CONFLICT' | 'IDENTITY_PREVIEW_LIMIT' | 'IDENTITY_PREVIEW_UNAVAILABLE';
export class IdentityProfileError extends CodedError {
  constructor(override readonly code: IdentityProfileErrorCode) { super(code); this.name = 'IdentityProfileError'; }
}
/** Reuses the descriptor-safe sorted-key JSON encoding; arrays retain authored order. */
export function encodeIdentityProfile(value: unknown): string { return JSON.stringify(identityProfileJsonSchema.parse(value)); }
