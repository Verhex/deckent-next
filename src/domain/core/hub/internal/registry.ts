import { persistedInteger } from '#domain/core/primitives/index.js';
import { z } from 'zod';
import limitData from './hub-limits.json' with { type: 'json' };
import policyData from './hub-trust-policies.json' with { type: 'json' };
import reviewData from './hub-review-levels.json' with { type: 'json' };
import fieldData from './hub-package-fields.json' with { type: 'json' };
import fileData from './hub-file-types.json' with { type: 'json' };

const positive = persistedInteger().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).positive();
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const uniqueIds = (rows: readonly { readonly id: string }[]) => new Set(rows.map(row => row.id)).size === rows.length;
export const hubLimitsSchema = z.strictObject({ schemaVersion: z.literal(1), packageMaxBytes: positive, packageMaxFiles: positive, itemsMax: positive,
  dependencyDepthMax: positive, dependenciesMax: positive, reviewerSignaturesMax: positive, searchPageMax: positive, feedPageMax: positive,
  sourcesPerScopeMax: positive, revocationRefreshMinutes: positive, feedMaxAgeMs: positive, fetchTimeoutMs: positive,
  fetchRetries: persistedInteger().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nonnegative(), publishesPerHour: positive, cacheMaxBytes: positive, skillFilesMaxBytes: positive,
  maxRedirects: persistedInteger().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nonnegative(), httpMaxBytes: positive, networkInputMaxBytes: positive, httpMaxConcurrentRequests: positive,
  skillReadMaxBytes: positive, skillReadMaxFiles: positive, delegationMaxMs: positive, clockSkewMs: persistedInteger().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nonnegative() }).readonly();
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type HubLimits = z.infer<typeof hubLimitsSchema>;
export const HUB_LIMITS = hubLimitsSchema.parse(limitData);
/** Unit conversion of the registry cadence, shared by publisher and client. */
export const HUB_REVOCATION_REFRESH_MS = HUB_LIMITS.revocationRefreshMinutes * 60_000;
export const hubTrustPoliciesSchema = z.strictObject({ schemaVersion: z.literal(1), addedSourceDefault: id, moderatedSourceDefault: id,
  policies: z.array(z.strictObject({ id, publisherPinned: z.boolean(), reviewers: z.enum(['none', 'high-risk', 'always']), moderation: z.boolean() }).readonly())
    .min(1).refine(uniqueIds).readonly() }).refine(row => [row.addedSourceDefault, row.moderatedSourceDefault].every(id => row.policies.some(p => p.id === id))).readonly();
export const HUB_TRUST_POLICIES = hubTrustPoliciesSchema.parse(policyData);
export const hubReviewLevelsSchema = z.strictObject({ schemaVersion: z.literal(1), levels: z.array(z.strictObject({ id, personOnly: z.boolean() }).readonly())
  .min(1).refine(uniqueIds).readonly() }).readonly();
export const HUB_REVIEW_LEVELS = hubReviewLevelsSchema.parse(reviewData);
export const hubPackageFieldsSchema = z.strictObject({ schemaVersion: z.literal(1), packageSchema: z.literal(1),
  optionalFields: z.array(z.strictObject({ object: z.enum(['manifest', 'dependency', 'signature']), field: id.or(z.string().regex(/^[a-z][a-zA-Z]+$/)), reader: id }).readonly()).refine(rows => new Set(rows.map(r => `${r.object}/${r.field}`)).size === rows.length).readonly() }).readonly();
export const HUB_PACKAGE_FIELDS = hubPackageFieldsSchema.parse(fieldData);
export const hubFileTypesSchema = z.strictObject({ schemaVersion: z.literal(1), mediaTypes: z.array(z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/))
  .min(1).refine(rows => new Set(rows).size === rows.length).readonly() }).readonly();
export const HUB_FILE_TYPES = hubFileTypesSchema.parse(fileData);
