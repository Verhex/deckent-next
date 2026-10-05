import { userInfo } from 'node:os';
import { join } from 'node:path';
import { productResourcePath, withConfigWriteLock, type ProductLayout } from '#platform/index.js';
import { FilePolicySource } from '#adapters/index.js';
import { DispatchPolicyAuthorization } from '#engine/index.js';
/** Trusted layout/owner/budget, never wire paths. Local POSIX custody, not remote policy distribution.
 * v2 role bindings share the guard/budget. Authority writes are archived and serialized (5 s lock). */
export function createLayoutPolicySource(layout: ProductLayout, ownerUid: number, maxBytes: number) {
  return new FilePolicySource({ path: productResourcePath(layout, 'policy'), bindingsPath: productResourcePath(layout, 'bindings'),
    archivePath: join(productResourcePath(layout, 'audit'), 'authority-revisions'), ownerUid, maxBytes },
  work => withConfigWriteLock(productResourcePath(layout, 'policy'), work, 5_000));
}
/** The attempt-level policy decision (read-output, …) of one scope context: the one construction workers list, transcript and monitor share. */
export const contextDispatchAuthorization = (c: { readonly layout: ProductLayout; readonly config: { readonly inspection: { readonly policyMaxBytes: number } } }, document?: unknown) =>
  new DispatchPolicyAuthorization(document === undefined ? createLayoutPolicySource(c.layout, userInfo().uid, c.config.inspection.policyMaxBytes) : { load: async () => document });
