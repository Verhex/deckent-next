import type { AttemptIdentity } from '#domain/index.js';
import { runWorkspaceCustodySchema, type RunWorkspaceCustody, type RunWorkspaceProvider } from '#engine/core/workspaces/index.js';
import { requireDelivered, WorkspaceAdoptionError, type IntegrationAdoptionStore } from './adoption.js';
import type { IntegrationDeliveryTarget } from './delivery.js';

export interface DeliveryRunPinRequest { readonly scopeId: string; readonly runId: string; readonly deliveryCommandId: string;
  /** Replay of an admitted command: resolve from the ledger's completed delivery only, like adoption's resume (no reference check). */
  readonly replay?: boolean }
/** Workspace custody of a Run pinned to a completed delivery of the same scope: the delivered commit, captured from the trusted source.
 * The caller must be allowed to read the delivered attempt's output (the commit is that output). Never samples the source HEAD.
 * A first admission also requires the delivery reference to still name the commit; a replay is compared with recorded custody instead. */
export async function pinRunToDelivery(store: Pick<IntegrationAdoptionStore, 'findDelivery'>, deliveries: Pick<IntegrationDeliveryTarget, 'delivered'>,
  provider: Pick<RunWorkspaceProvider, 'captureSource'>, authorizeRead: (identity: AttemptIdentity) => Promise<void>,
  request: DeliveryRunPinRequest): Promise<RunWorkspaceCustody> {
  const recorded = request.replay ? await store.findDelivery(request.scopeId, request.deliveryCommandId) : null;
  if (request.replay && !recorded?.delivered) throw new WorkspaceAdoptionError('ADOPTION_NOT_DELIVERED');
  const delivery = recorded ?? await requireDelivered(store, deliveries, request.scopeId, request.deliveryCommandId);
  await authorizeRead(delivery.intent.command.identity);
  const { commit } = delivery.intent.plan;
  const captured = await provider.captureSource(commit);
  if (captured.baseRevision !== commit) throw new WorkspaceAdoptionError('ADOPTION_NOT_DELIVERED');
  return runWorkspaceCustodySchema.parse({ schemaVersion: 1, scopeId: request.scopeId, runId: request.runId,
    source: captured.source, baseRevision: commit });
}
