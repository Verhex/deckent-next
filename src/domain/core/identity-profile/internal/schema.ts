import { z } from 'zod';
import limits from './limits.json' with { type: 'json' };
import { createImmutableJsonObjectSchema, identitySchema } from '#domain/core/primitives/index.js';
import { companyIdSchema, policyRoleSchema } from '#domain/core/policy/index.js';

/** Bounded v1 transport, not an installation capacity limit. */
export const IDENTITY_PROFILE_LIMITS = Object.freeze(limits);
export const identityProfileJsonSchema = createImmutableJsonObjectSchema(IDENTITY_PROFILE_LIMITS);
const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/);
const key = z.string().regex(/^[a-z][a-zA-Z0-9_.-]{0,127}$/);
export const identityProfileRefSchema = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,62}:[a-z0-9][a-z0-9._-]{0,62}$/), version: z.number().int().positive().safe() }).strict().readonly();
export const identityProfileDefinitionSchema = identityProfileJsonSchema.pipe(z.object({
  schemaVersion: z.literal(1), ...identityProfileRefSchema.unwrap().shape, labelKey: key,
  defaults: z.object({ projectSelection: z.literal('current-projects'), preserveExisting: z.literal(true), showOrganization: z.boolean() }).strict().readonly(),
  roleTemplates: z.array(policyRoleSchema).max(64).readonly(),
  approvalPolicyTemplate: z.object({ adminApprovalRequired: z.literal(true), secondPerson: z.enum(['disabled', 'founder-choice']) }).strict().readonly(),
  hierarchyOptions: z.object({ nodeKinds: z.array(z.enum(['site', 'unit'])).max(2).readonly(), futureProjects: z.literal('explicit-draft-only') }).strict().readonly(),
  requires: z.array(z.object({ id: identitySchema, version: z.number().int().positive().safe() }).strict().readonly()).max(64).readonly(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.roleTemplates.map(role => role.id)).size !== value.roleTemplates.length
    || value.roleTemplates.some(role => new Set(role.permissions.map(p => p.id)).size !== role.permissions.length)
    || new Set(value.hierarchyOptions.nodeKinds).size !== value.hierarchyOptions.nodeKinds.length
    || new Set(value.requires.map(r => r.id)).size !== value.requires.length) ctx.addIssue({ code: 'custom', message: 'IDENTITY_PROFILE_INVALID' });
}).readonly());
export type IdentityProfileDefinition = z.infer<typeof identityProfileDefinitionSchema>;
export type IdentityProfileRef = z.infer<typeof identityProfileRefSchema>;
export const identityProfilePackageSchema = identityProfileJsonSchema.pipe(z.object({ schemaVersion: z.literal(1), namespace: slug,
  source: identitySchema, digest: z.string().regex(/^[a-f0-9]{64}$/), definition: identityProfileDefinitionSchema,
  labels: z.object({ en: z.string().min(1).max(256), tr: z.string().min(1).max(256) }).strict().readonly(),
}).strict().readonly());
export type IdentityProfilePackage = z.infer<typeof identityProfilePackageSchema>;
const principalRef = z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly();
const member = z.object({ id: slug, principal: principalRef, label: z.string().min(1).max(256),
  kind: z.enum(['human', 'machine', 'agent']), organizationNodeId: slug.optional() }).strict().readonly();
const node = z.object({ id: slug, kind: z.enum(['site', 'unit']), companyId: companyIdSchema, parentId: slug.nullable(), label: z.string().min(1).max(256) }).strict().readonly();
const previewShape = z.object({ schemaVersion: z.literal(1), profile: identityProfileRefSchema,
  scopeId: identitySchema, projectScopeIds: z.array(identitySchema).min(1).max(128).readonly().optional(),
  members: z.array(member).max(1024).readonly(), organization: z.array(node).max(1024).readonly(),
  assignments: z.array(z.object({ id: slug, memberId: slug, roleId: slug, scopeIds: z.array(identitySchema).min(1).max(128).readonly() }).strict().readonly()).max(1024).readonly(),
  removeBindingIds: z.array(slug).max(1024).readonly(), includeFutureProjects: z.boolean().optional(),
}).strict();
export const identityPreviewInputSchema = identityProfileJsonSchema.pipe(previewShape.readonly());
export const identityPreviewRequestSchema = identityProfileJsonSchema.pipe(previewShape.extend({ profile: identityProfileRefSchema.optional() }).readonly());
export const identityProfileConfigSchema = z.object({ profile: identityProfileRefSchema, packages: z.array(identityProfilePackageSchema).max(64).optional() }).strict();
export type IdentityPreviewInput = z.infer<typeof identityPreviewInputSchema>;
export type IdentityProfileErrorCode = 'IDENTITY_PROFILE_INVALID' | 'IDENTITY_PROFILE_NAMESPACE_UNKNOWN' | 'IDENTITY_PROFILE_VERSION_UNKNOWN'
  | 'IDENTITY_PROFILE_UNKNOWN' | 'IDENTITY_PROFILE_SHADOW' | 'IDENTITY_PROFILE_DIGEST_MISMATCH' | 'IDENTITY_PREVIEW_INVALID'
  | 'IDENTITY_PREVIEW_SCOPE_DENIED' | 'IDENTITY_PREVIEW_CONFLICT' | 'IDENTITY_PREVIEW_LIMIT' | 'IDENTITY_PREVIEW_UNAVAILABLE';
export class IdentityProfileError extends Error {
  constructor(readonly code: IdentityProfileErrorCode) { super(code); this.name = 'IdentityProfileError'; }
}
/** Reuses the descriptor-safe sorted-key JSON encoding; arrays retain authored order. */
export function encodeIdentityProfile(value: unknown): string { return JSON.stringify(identityProfileJsonSchema.parse(value)); }
