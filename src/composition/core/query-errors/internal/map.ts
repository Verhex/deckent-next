import { ZodError } from 'zod';
import { DeckentError, ErrorRegistry, ManagedFileError } from '#platform/index.js';
import { ExecutionRegistryError, AuthenticationError, AttemptStoreError, DispatchError, DispatchInventoryError, PolicyAuthorizationError, RunStoreError } from '#engine/index.js';
/** Preserve stable failure identities without exposing paths, database messages or query contents. */
export function queryFailure(error: unknown): DeckentError {
  if (error instanceof DeckentError) return error;
  if (error instanceof ZodError) return ErrorRegistry.createError('INVENTORY_QUERY_INVALID');
  if (error instanceof DispatchInventoryError) return ErrorRegistry.createError('DISPATCH_INVENTORY_LIMIT');
  if (error instanceof ExecutionRegistryError || error instanceof AuthenticationError || error instanceof AttemptStoreError || error instanceof DispatchError || error instanceof RunStoreError ||
    error instanceof ManagedFileError || error instanceof PolicyAuthorizationError) return ErrorRegistry.createError(ErrorRegistry.has(error.code) ? error.code : 'INVENTORY_UNAVAILABLE');
  return ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
}
