import type { ProjectIdentity } from '#domain/index.js';

/** Bootstrap metadata only. It grants no principal, scope membership or execution authority. */
export type IdentityRead<T> = { readonly status: 'available'; readonly value: T }
  | { readonly status: 'unavailable'; readonly reason: 'not-created' | 'unsupported' };
export interface ProjectIdentityStore {
  read(): Promise<IdentityRead<ProjectIdentity>>;
  loadOrCreate(): Promise<ProjectIdentity>;
}
export type ProjectIdentityErrorCode = 'PROJECT_IDENTITY_INVALID' | 'PROJECT_IDENTITY_UNAVAILABLE' | 'PROJECT_IDENTITY_LOCKED' | 'PROJECT_IDENTITY_MASKED';
export class ProjectIdentityError extends Error {
  constructor(readonly code: ProjectIdentityErrorCode) { super(code); this.name = 'ProjectIdentityError'; }
}
