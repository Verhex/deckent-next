import type { Policy } from '#domain/index.js';
export interface AuthorityRevision { readonly key: string | null; readonly before: Policy; readonly after: Policy }
/** Trusted, bounded archive observations, null when history cannot be verified; never a second authority writer. */
export interface AuthorityHistorySource { authorityHistory(): Promise<readonly AuthorityRevision[] | null> }
