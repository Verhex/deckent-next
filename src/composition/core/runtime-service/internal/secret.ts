import { AuditError, PolicyError } from '#domain/index.js';
import { AuditApplication, policySecretChangeAuthorization, RuntimeServiceProtocolError, runtimeServiceResultCapacity, secretDeleteCommandSchema,
  secretSetCommandSchema, SecretStoreAdministration, type RuntimeServiceRequest } from '#engine/index.js';
import { openConfiguredSecretStore, openLocalIntegrityAuthority, openSqliteAuditStore, PolicyFileError, type LocalPeerIdentity } from '#adapters/index.js';
import { ErrorRegistry, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredPeerScopeContext } from '#composition/core/scoped-request/index.js';

/** v18 secret changes (SECRET-WRITE, option A, S3): the socket peer's change is decided on the `secret` cell of this installation's policy and
 * sealed as `secret-change` in the same installation's ledger before the store is written (MCP user-trust precedent). The value goes from the
 * request to the store only; no answer, error or record carries it. */
export async function executeConfiguredRuntimeSecretOperation(projectRoot: string, request: RuntimeServiceRequest, peer: LocalPeerIdentity,
  responseMaxBytes: number, options: ConfigLoadOptions): Promise<unknown> {
  if (!request.delivery) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  const capacity = runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes);
  const set = request.operation === 'setSecret' ? secretSetCommandSchema.parse(request.input) : null, command = set ?? secretDeleteCommandSchema.parse(request.input);
  let result: unknown;
  try {
    const context = await loadConfiguredPeerScopeContext(projectRoot, command.scopeId, options, peer, 'write');
    const secrets = openConfiguredSecretStore(context.config, options.env ?? process.env, options.platform);
    const store = await openSqliteAuditStore(await context.path(), context.config.storage.sqlite, 'forbid');
    try {
      const audit = new AuditApplication(store, await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true)), clock = new SystemTrustedClock();
      const administration = new SecretStoreAdministration(secrets, policySecretChangeAuthorization(context.document, context.principal),
        event => { audit.record(event); }, () => clock.sample().wallMs);
      const change = { principal: { issuer: context.principal.issuer, subject: context.principal.subject }, scopeId: command.scopeId, name: command.name };
      const removed = set ? (await administration.set(change, set.value), null) : await administration.delete(change);
      result = { schemaVersion: 1, scopeId: command.scopeId, name: command.name, action: set ? 'set' : 'delete', backend: secrets.descriptor.id, removed };
    } finally { store.close(); }
  } catch (error) {
    if (error instanceof AuditError) throw ErrorRegistry.createError(error.code);
    if (error instanceof PolicyFileError || error instanceof PolicyError) throw ErrorRegistry.createError('POLICY_UNAVAILABLE');
    throw queryFailure(error);
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > capacity) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT');
  return result;
}
