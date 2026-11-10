import { userInfo } from 'node:os';
import { join } from 'node:path';
import { productResourcePath, withConfigWriteLock, type ProductLayout } from '#platform/index.js';
import type { Policy } from '#domain/index.js';
import { FilePolicySource, PolicyFileError } from '#adapters/index.js';
import { type PolicySource, DispatchPolicyAuthorization } from '#engine/index.js';
/** Trusted layout/owner/budget, never wire paths. Local POSIX custody, not remote policy distribution.
 * v2 role bindings share the guard/budget. Authority writes are archived and serialized (5 s lock). */
export function createLayoutPolicySource(layout: ProductLayout, ownerUid: number, maxBytes: number) {
  return new FilePolicySource({ path: productResourcePath(layout, 'policy'), bindingsPath: productResourcePath(layout, 'bindings'),
    archivePath: join(productResourcePath(layout, 'audit'), 'authority-revisions'), ownerUid, maxBytes },
  work => withConfigWriteLock(productResourcePath(layout, 'policy'), work, 5_000));
}
/** The file a policy read refused (unsafe, damaged, missing bindings) and why, for the caller's own typed refusal; null for any other failure. */
export const policyFileRefusal = (layout: ProductLayout, error: unknown) => error instanceof PolicyFileError && error.resource !== 'archive' ? { path: productResourcePath(layout, error.resource), reason: error.code } : null;
type PolicyContext = { readonly layout: ProductLayout; readonly ownerUid?: number | undefined; readonly config: { readonly inspection: { readonly policyMaxBytes: number } } };
type PolicySnapshot = Policy | (() => Promise<Policy>);
/** One policy-source seam: file reads stay fresh; a supplied document pins only this source to that snapshot. Installer custody is explicit. */
export function contextPolicySource(c: PolicyContext): FilePolicySource;
export function contextPolicySource(c: PolicyContext, document?: PolicySnapshot): PolicySource;
export function contextPolicySource(c: PolicyContext, document?: PolicySnapshot): PolicySource {
  return document === undefined ? createLayoutPolicySource(c.layout, c.ownerUid ?? userInfo().uid, c.config.inspection.policyMaxBytes)
    : { load: typeof document === 'function' ? document : async () => document };
}
export const contextDispatchAuthorization = (c: PolicyContext, document?: Policy) => new DispatchPolicyAuthorization(contextPolicySource(c, document));
