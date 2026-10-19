import { ErrorRegistry } from '#platform/index.js';
import type { RuntimeServiceOperation } from './service-protocol.js';

/** SEC-1 (owner A48-D5, F32): the runtime-service authority writes. Each needs a service-held witness on every surface (CLI, terminal, MCP, SDK);
 * policy administration, identity distribution and approval decisions already require the same witness through their approval path. */
export const RUNTIME_SERVICE_AUTHORITY_WRITE_OPERATIONS: readonly RuntimeServiceOperation[] = Object.freeze(['setPermissionMode', 'setSecret', 'deleteSecret', 'switchSecretStore']);
export const isRuntimeServiceAuthorityWriteOperation = (operation: RuntimeServiceOperation): boolean => RUNTIME_SERVICE_AUTHORITY_WRITE_OPERATIONS.includes(operation);
/** Evidence the service holds that a person at an interactive terminal made the request, never a client flag or wire field. Core composes the
 * peer process's controlling terminal; an Enterprise composition may require a stronger witness (hardware key, central session) through this port. */
export interface AuthorityWitness { attest(): Promise<boolean> }
/** Refuses an authority write before any store, audit record or secret is touched: the MCP actor never grants authority; any other actor needs the witness. */
export async function requireAuthorityWitness(operation: RuntimeServiceOperation, channel: 'mcp' | undefined, witness: AuthorityWitness): Promise<void> {
  if (isRuntimeServiceAuthorityWriteOperation(operation) && (channel === 'mcp' || !await witness.attest())) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation } });
}
