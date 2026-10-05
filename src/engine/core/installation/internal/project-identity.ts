import type { ProjectIdentity } from '#domain/index.js';

/** Bootstrap metadata only. It grants no principal, scope membership or execution authority. */
export interface ProjectIdentityStore {
  loadOrCreate(): Promise<ProjectIdentity>;
}
export type ProjectIdentityErrorCode = 'PROJECT_IDENTITY_INVALID' | 'PROJECT_IDENTITY_UNAVAILABLE' | 'PROJECT_IDENTITY_LOCKED';
export class ProjectIdentityError extends Error {
  constructor(readonly code: ProjectIdentityErrorCode) { super(code); this.name = 'ProjectIdentityError'; }
}
