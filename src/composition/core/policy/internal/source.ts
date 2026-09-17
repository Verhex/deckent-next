import { productResourcePath, type ProductLayout } from '#platform/index.js';
import { FilePolicySource } from '#adapters/index.js';
/** Caller pins the existing layout and trusted administrative owner/budget. No path comes from command wire.
 * This is a local POSIX provisioning boundary, not signed remote/Enterprise policy distribution.
 */
export function createLayoutPolicySource(layout: ProductLayout, ownerUid: number, maxBytes: number) {
  return new FilePolicySource({ path: productResourcePath(layout, 'policy'), ownerUid, maxBytes });
}
