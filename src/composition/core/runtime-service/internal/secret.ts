import { AuditError, PolicyError } from '#domain/index.js';
import { policySecretChangeAuthorization, policySecretStoreSwitchAuthorization, RuntimeServiceProtocolError, runtimeServiceResultCapacity,
  secretDeleteCommandSchema, secretSetCommandSchema, secretStoreSwitchCommandSchema, SecretStoreAdministration, SecretStoreSwitch, type RuntimeServiceRequest } from '#engine/index.js';
import { createInstallationSecretCustody, createInstallationSecretStoreSelection, isRegisteredSecretStore, openConfiguredSecretStore, openRegisteredSecretStore,
  PolicyFileError, type LocalPeerIdentity } from '#adapters/index.js';
import { ErrorRegistry, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredPeerScopeContext, withScopeAudit } from '#composition/core/scoped-request/index.js';
import { missingEnvironmentReferenceNames } from '#composition/core/secrets/index.js';

/** v18 secret changes (SECRET-WRITE, option A, S3): the socket peer's change is decided on the `secret` cell of this installation's policy and
 * sealed as `secret-change` in the same installation's ledger before the store is written (MCP user-trust precedent). The value goes from the
 * request to the store only; no answer, error or record carries it. The answer is known before the change (scope, name, action, backend;
 * `removed` null for a set, at most `false` for a delete), so a delivery budget it cannot fit is `RUNTIME_SERVICE_RESPONSE_LIMIT` before the
 * decision, any audit record or the store is touched (Astra 2185 R6) — a delivery refusal like the read-only backend's, not an authority one. */
export async function executeConfiguredRuntimeSecretOperation(projectRoot: string, request: RuntimeServiceRequest, peer: LocalPeerIdentity,
  responseMaxBytes: number, options: ConfigLoadOptions): Promise<unknown> {
  if (!request.delivery) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  const capacity = runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes);
  if (request.operation === 'switchSecretStore') return switchStore(projectRoot, request, peer, capacity, options);
  const set = request.operation === 'setSecret' ? secretSetCommandSchema.parse(request.input) : null, command = set ?? secretDeleteCommandSchema.parse(request.input);
  let result: unknown;
  try {
    const context = await loadConfiguredPeerScopeContext(projectRoot, command.scopeId, options, peer, 'write');
    const env = options.env ?? process.env, platform = options.platform ?? process.platform, secrets = openConfiguredSecretStore(context.config, env, platform);
    const answer = (removed: boolean | null) => ({ schemaVersion: 1, scopeId: command.scopeId, name: command.name, action: set ? 'set' : 'delete',
      backend: secrets.descriptor.id, removed });
    if (Buffer.byteLength(JSON.stringify(answer(set ? null : false)), 'utf8') > capacity) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT');
    result = await withScopeAudit(context, async audit => {
      const clock = new SystemTrustedClock();
      const administration = new SecretStoreAdministration(secrets, policySecretChangeAuthorization(context.document, context.principal),
        event => { audit.record(event); }, () => clock.sample().wallMs, createInstallationSecretCustody(env, platform));
      const change = { principal: { issuer: context.principal.issuer, subject: context.principal.subject }, scopeId: command.scopeId, name: command.name };
      return answer(set ? (await administration.set(change, set.value), null) : await administration.delete(change));
    });
  } catch (error) { throw secretFailure(error); }
  return result;
}
const secretFailure = (error: unknown) => error instanceof RuntimeServiceProtocolError ? error : error instanceof AuditError ? ErrorRegistry.createError(error.code)
  : error instanceof PolicyFileError || error instanceof PolicyError ? ErrorRegistry.createError('POLICY_UNAVAILABLE') : queryFailure(error);

/** v24 SECRET-STORE-SWITCH: the socket peer moves every secret into another registered store under the `secret`/`switch` cell of this
 * installation's policy, audited as `secret-store-switch` in the same ledger before anything moves. The answer carries store ids and counts
 * only; its bound is checked before the decision (the largest answer: both ids at their bound and a full count). */
async function switchStore(projectRoot: string, request: RuntimeServiceRequest, peer: LocalPeerIdentity, capacity: number, options: ConfigLoadOptions): Promise<unknown> {
  const command = secretStoreSwitchCommandSchema.parse(request.input), env = options.env ?? process.env, platform = options.platform ?? process.platform;
  const widest = { schemaVersion: 1, scopeId: command.scopeId, status: 'switched', from: 'x'.repeat(128), to: command.to, entries: Number.MAX_SAFE_INTEGER, downgrade: false, cleaned: false };
  if (Buffer.byteLength(JSON.stringify(widest), 'utf8') > capacity) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT');
  try {
    const context = await loadConfiguredPeerScopeContext(projectRoot, command.scopeId, options, peer, 'write');
    return await withScopeAudit(context, audit => {
      const clock = new SystemTrustedClock();
      return new SecretStoreSwitch({ has: isRegisteredSecretStore, open: id => openRegisteredSecretStore(id, env, platform),
        selection: createInstallationSecretStoreSelection(env, platform), authorize: policySecretStoreSwitchAuthorization(context.document, context.principal),
        audit: event => { audit.record(event); }, now: () => clock.sample().wallMs, custody: createInstallationSecretCustody(env, platform),
        environmentReferences: target => missingEnvironmentReferenceNames(projectRoot, options, target) })
        .switch({ principal: { issuer: context.principal.issuer, subject: context.principal.subject }, scopeId: command.scopeId, to: command.to,
          confirmDowngrade: command.confirmDowngrade, confirmEnvMissing: command.confirmEnvMissing ?? false });
    });
  } catch (error) { throw secretFailure(error); }
}
