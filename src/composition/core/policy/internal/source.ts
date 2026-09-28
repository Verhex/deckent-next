import { join } from 'node:path';
import { productResourcePath, withConfigWriteLock, type ProductLayout } from '#platform/index.js';
import { FilePolicySource } from '#adapters/index.js';
/** Caller pins the existing layout and trusted administrative owner/budget. No path comes from command wire.
 * This is a local POSIX provisioning boundary, not signed remote/Enterprise policy distribution.
 * Role bindings are a separate layout resource under the same guard and byte budget; only a v2 policy reads them (H34 S2).
 * Every authority write is archived under the registered `audit` resource (POLICY-ADMIN P2; never opened to the agent tools) and
 * serialized across processes by the platform's exclusive directory lock (`policy.json.write-lock`, bounded 5 s wait, stale reclaim).
 */
export function createLayoutPolicySource(layout: ProductLayout, ownerUid: number, maxBytes: number) {
  return new FilePolicySource({ path: productResourcePath(layout, 'policy'), bindingsPath: productResourcePath(layout, 'bindings'),
    archivePath: join(productResourcePath(layout, 'audit'), 'authority-revisions'), ownerUid, maxBytes },
  work => withConfigWriteLock(productResourcePath(layout, 'policy'), work, 5_000));
}
