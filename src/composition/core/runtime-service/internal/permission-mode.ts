import { userInfo } from 'node:os';
import { AuditError, PolicyError } from '#domain/index.js';
import { AuditApplication, inspectPermissionMode, PermissionModeApplication, PermissionModeError, RuntimeServiceProtocolError, runtimeServiceResultCapacity,
  type RuntimeServiceRequest } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteAuditStore, PolicyFileError, type LocalPeerIdentity } from '#adapters/index.js';
import { DeckentError, ErrorRegistry, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredPeerScopeContext } from '#composition/core/scoped-request/index.js';

/**
 * v15 permission-mode operations (T-L4 slice 4c): the socket peer reads and sets its own mode. The read answers from the request's
 * policy + bindings snapshot (scope admission `read`); the write goes through the one application that owns the change, with the
 * layout policy source as its conditional bindings store and the Core audit port as its evidence. The surface never touches a file.
 */
export async function executeConfiguredRuntimePermissionModeOperation(projectRoot: string, request: RuntimeServiceRequest, peer: LocalPeerIdentity,
  responseMaxBytes: number, options: ConfigLoadOptions): Promise<unknown> {
  if (!request.delivery) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  const capacity = runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes);
  let result: unknown;
  try {
    // The protocol already validated the input shape; the application parses it again before deciding.
    const scopeId = (request.input as { readonly scopeId: string }).scopeId;
    if (request.operation === 'inspectPermissionMode') {
      const context = await loadConfiguredPeerScopeContext(projectRoot, scopeId, options, peer, 'read');
      result = inspectPermissionMode(context.document, context.principal, request.input);
    } else if (request.operation === 'setPermissionMode') {
      const context = await loadConfiguredPeerScopeContext(projectRoot, scopeId, options, peer, 'write');
      const store = await openSqliteAuditStore(await context.path(), context.config.storage.sqlite, 'forbid');
      try {
        // A producer of audit evidence, like the approval request: the integrity key is created on first use.
        const audit = new AuditApplication(store, await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true));
        const clock = new SystemTrustedClock();
        result = await new PermissionModeApplication(createLayoutPolicySource(context.layout, userInfo().uid, context.config.inspection.policyMaxBytes),
          event => { audit.record(event); }, () => clock.sample().wallMs).set(context.principal, request.input);
      } finally { store.close(); }
    } else throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  } catch (error) {
    if (error instanceof PermissionModeError && error.code === 'PERMISSION_MODE_DENIED') throw ErrorRegistry.createError(error.code, { params: { mode: error.mode ?? '' } });
    if (error instanceof PermissionModeError || error instanceof AuditError) throw ErrorRegistry.createError(error.code);
    // The authority write lock is held (another writer): the person's next step is to retry, so the lock's holder travels as parameters.
    if (error instanceof DeckentError && error.code === 'CONFIG_WRITE_LOCKED') throw ErrorRegistry.createError('PERMISSION_MODE_LOCKED', error.params ? { params: error.params } : {});
    // An unreadable, unsafe or inconsistent authority file refuses the change like every other policy consumer (nothing written).
    if (error instanceof PolicyFileError || error instanceof PolicyError) throw ErrorRegistry.createError('POLICY_UNAVAILABLE');
    throw queryFailure(error);
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > capacity) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT');
  return result;
}
