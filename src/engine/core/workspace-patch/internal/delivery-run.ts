import type { AttemptIdentity } from '#domain/index.js';
import { runWorkspaceCustodySchema, type RunWorkspaceCustody, type RunWorkspaceProvider } from '#engine/core/workspaces/index.js';
import { requireDelivered, WorkspaceAdoptionError, type IntegrationAdoptionStore } from './adoption.js';
import type { IntegrationDeliveryTarget } from './delivery.js';

export interface DeliveryRunPinRequest { readonly scopeId: string; readonly runId: string; readonly deliveryCommandId: string }
/** Workspace custody of a Run pinned to a completed delivery of the same scope: the delivered commit, captured from the trusted source.
 * The caller must be allowed to read the delivered attempt's output (the commit is that output). Never samples the source HEAD. */
export async function pinRunToDelivery(store: Pick<IntegrationAdoptionStore, 'findDelivery'>, deliveries: Pick<IntegrationDeliveryTarget, 'delivered'>,
  provider: Pick<RunWorkspaceProvider, 'captureSource'>, authorizeRead: (identity: AttemptIdentity) => Promise<void>,
  request: DeliveryRunPinRequest): Promise<RunWorkspaceCustody> {
  const delivery = await requireDelivered(store, deliveries, request.scopeId, request.deliveryCommandId);
  await authorizeRead(delivery.intent.command.identity);
  const { commit } = delivery.intent.plan;
  const captured = await provider.captureSource(commit);
  if (captured.baseRevision !== commit) throw new WorkspaceAdoptionError('ADOPTION_NOT_DELIVERED');
  return runWorkspaceCustodySchema.parse({ schemaVersion: 1, scopeId: request.scopeId, runId: request.runId,
    source: captured.source, baseRevision: commit });
}
