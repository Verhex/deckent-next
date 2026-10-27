import { ErrorRegistry } from '#platform/index.js';
import type { RuntimeServiceOperation } from './service-protocol.js';

/** SEC-1 (owner A48-D5, F32): the runtime-service authority writes. Each needs a service-held witness on every surface (CLI, terminal, MCP, SDK);
 * policy administration, identity distribution and approval decisions already require the same witness through their approval path. */
export const RUNTIME_SERVICE_AUTHORITY_WRITE_OPERATIONS: readonly RuntimeServiceOperation[] = Object.freeze(['setPermissionMode', 'setSecret', 'deleteSecret', 'switchSecretStore']);
export const isRuntimeServiceAuthorityWriteOperation = (operation: RuntimeServiceOperation): boolean => RUNTIME_SERVICE_AUTHORITY_WRITE_OPERATIONS.includes(operation);
/** S-05 (owner GO 2026-10-27, law audit K1/K2): creating, changing or unfreezing the API budget and reconciling held spend need the person's
 * witness from every non-MCP caller (CLI, terminal, SDK); the MCP actor stays decided by its policy grant here (no MCP hard floor). */
export const RUNTIME_SERVICE_PERSON_WRITE_OPERATIONS: readonly RuntimeServiceOperation[] = Object.freeze(['manageProviderSpend']);
/** Evidence the composition holds that a person at an interactive terminal made the request, never a client flag or wire field. Core composes the
 * process's controlling terminal; an Enterprise composition may require a stronger witness (hardware key, central session) through this port. */
export interface AuthorityWitness { attest(): Promise<boolean> }
/** The one refusal for any authority write (runtime operation, MCP server trust, …) before anything is touched: the MCP actor never grants
 * authority; any other actor needs the witness. `write` names the change for JSON consumers only. */
export async function assertAuthorityWitness(write: string, channel: 'mcp' | undefined, witness: AuthorityWitness): Promise<void> {
  if (channel === 'mcp' || !await witness.attest()) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: write } });
}
/** The runtime service's gate: authority writes need the witness, person writes need it off MCP; every other operation passes without asking it. */
export async function requireAuthorityWitness(operation: RuntimeServiceOperation, channel: 'mcp' | undefined, witness: AuthorityWitness): Promise<void> {
  if (isRuntimeServiceAuthorityWriteOperation(operation)) await assertAuthorityWitness(operation, channel, witness);
  else if (channel !== 'mcp' && RUNTIME_SERVICE_PERSON_WRITE_OPERATIONS.includes(operation)) await assertAuthorityWitness(operation, undefined, witness);
}
