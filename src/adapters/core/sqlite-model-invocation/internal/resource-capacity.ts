import type { DatabaseSync } from 'node:sqlite';
import { nativeCliLoginCapacity } from '#adapters/core/native-cli-registry/index.js';
import type { ModelInvocationProfile, RunSnapshot } from '#domain/index.js';
import { bindCapacityResource, findCapacityResource, readCapacityOccupancy, readRunResourceCapacity as readLedgerRunResourceCapacity } from '#adapters/core/sqlite-ledger/index.js';
import { hasCapacityRoom, ModelInvocationStoreError, verifyModelInvocationReceipt } from '#engine/index.js';
/** Every claimed receipt is verified; an unbound legacy receipt of another login cannot occupy a resource and observation never creates its metadata. */
function claimedLogin(row: Readonly<Record<string, unknown>>) {
  const receipt = verifyModelInvocationReceipt(JSON.parse(String(row.record)));
  if (receipt.claim.scopeId !== row.scope_id || receipt.claim.invocationId !== row.invocation_id || receipt.outcome !== null) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  return nativeCliLoginCapacity(receipt.profile)?.binding ?? null;
}
const reconnect = (): never => { throw new ModelInvocationStoreError('NATIVE_AGENT_RECONNECT_REQUIRED'); };
export function invocationCapacityResource(db: DatabaseSync, profile: ModelInvocationProfile) {
  const login = nativeCliLoginCapacity(profile);
  return login ? findCapacityResource(db, login.binding) ?? reconnect() : null;
}
export const readCapacityResourceOccupancy = (db: DatabaseSync, resourceKey: string) => readCapacityOccupancy(db, resourceKey, claimedLogin);
export function assertInvocationResourceCapacity(db: DatabaseSync, profile: ModelInvocationProfile) {
  const login = nativeCliLoginCapacity(profile);
  if (!login) return;
  let resource = findCapacityResource(db, login.binding);
  if (!resource) {
    const slots = login.firstUseSlots() ?? reconnect();
    // Resource metadata only: never consent, source authority or credentials. The claim transaction owns this write.
    resource = bindCapacityResource(db, login.binding, { executionSlots: slots, inFlightSlots: slots });
  }
  if (!hasCapacityRoom(resource.capacity, readCapacityResourceOccupancy(db, resource.resourceKey))) throw new ModelInvocationStoreError('MODEL_INVOCATION_CAPACITY_EXHAUSTED');
}
export const readRunResourceCapacity = (db: DatabaseSync, run: RunSnapshot) => readLedgerRunResourceCapacity(db, run, claimedLogin);
