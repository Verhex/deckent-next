export { parseModelAllocation, createModelAllocationCheckpoint, parseModelAllocationCheckpoint } from './internal/checkpoint.js';
export type { ModelAllocation, ModelAllocationCheckpoint } from './internal/checkpoint.js';
export { verifyModelAllocationIntegrity, validateModelAllocationPageSize, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ MODEL_ALLOCATION_INTEGRITY_PAGE_MAX } from './internal/integrity.js';
export type { ModelAllocationIntegrityQuery, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelAllocationIntegrityPage, ModelAllocationIntegrityReader } from './internal/integrity.js';
export { planModelAllocationSlotRelease } from './internal/release.js';
export type { ModelAllocationSlotRelease, ModelAllocationSlotReleaseStore, ModelAllocationStartCustody } from './internal/release.js';
