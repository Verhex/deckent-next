export { IDENTITY_PROFILE_LIMITS, IdentityProfileError, encodeIdentityProfile, identityProfileJsonSchema, identityProfileDefinitionSchema,
  identityPreviewRequestSchema, identityProfileConfigSchema, identityProfileRefSchema, identityProfilePackageSchema, identityPreviewInputSchema } from './internal/schema.js';
export type { IdentityProfileDefinition, IdentityProfileRef, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ IdentityProfilePackage, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ IdentityProfileErrorCode, IdentityPreviewInput } from './internal/schema.js';
export { validateIdentityDraft, draftIdentityPolicy } from './internal/draft.js';
export { identityPermissionDiff } from './internal/diff.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ IdentityPermissionDifference, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ IdentityCellSelection } from './internal/diff.js';
export { coreIdentityProfileData } from './internal/core-data.js';
export { identityDistributionSelectionSchema, identityDistributionSubmissionSchema } from './internal/distribution.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ IdentityDistributionSelection, IdentityDistributionSubmission } from './internal/distribution.js';
