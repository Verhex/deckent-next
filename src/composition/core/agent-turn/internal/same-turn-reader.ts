import { isDeepStrictEqual } from 'node:util';
import type { ModelInvocationReceipt } from '#domain/index.js';
import { ModelInvocationPolicyAuthorization, ModelInvocationStoreError, PolicyAuthorizationError } from '#engine/index.js';
import { withLocalPrincipalChannel, withMcpPrincipal, type LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { inspectionApplication, loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';

type InvocationContext = Awaited<ReturnType<typeof loadPeerInvocationContext>>;
/** Internal chat composition only. Captures the accepted socket object and the person witnessed before entering MCP. */
export function bindRetainedTurnResponse(root: string, options: ConfigLoadOptions, peer: LocalPeerIdentity, scopeId: string,
  witness: InvocationContext, signal: AbortSignal, observe?: (receipt: ModelInvocationReceipt, policyRevision: string) => void) {
  const connection = peer.connection, sameInstallation = (current: InvocationContext) =>
    witness.installationId !== null && current.installationId === witness.installationId
      && current.config.company.id === witness.config.company.id && isDeepStrictEqual(current.layout, witness.layout);
  const live = () => !signal.aborted && connection !== undefined && peer.connection === connection && !connection.aborted && peer.isConnectionActive?.() === true;
  const refuse = (): never => { throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE'); };
  async function actorFor(receipt: ModelInvocationReceipt) {
    if (receipt.claim.scopeId !== scopeId) return refuse();
    const actor = await withMcpPrincipal(() => loadPeerInvocationContext(root, scopeId, options, peer, 'read'));
    if (actor.principal.assurance !== 'workload-verified' || !sameInstallation(actor)) return refuse();
    return actor;
  }
  let used = false;
  return Object.freeze({
    async read(receipt: ModelInvocationReceipt, isCurrent: () => boolean) {
      if (used) return refuse();
      used = true;
      const valid = () => live() && isCurrent();
      if (!valid() || witness.principal.assurance !== 'os-user') return refuse();
      const actor = await actorFor(receipt), path = await actor.path();
      const app = inspectionApplication({ ...actor, path: async () => path });
      return app.readRetainedTurnResponse(receipt, target => withLocalPrincipalChannel(undefined, async () => {
        if (!valid()) return refuse();
        const person = await loadPeerInvocationContext(root, scopeId, options, peer, 'read');
        if (!sameInstallation(person) || !isDeepStrictEqual(person.principal, witness.principal) || await person.path() !== path) return refuse();
        let decisionPolicy: typeof person.document | undefined;
        const source = { load: async () => (decisionPolicy = await person.policy.load()) };
        const authorization = await new ModelInvocationPolicyAuthorization(source).authorize('inspect-content', target, person.principal).catch((error: unknown) => {
          if (decisionPolicy && error instanceof PolicyAuthorizationError && error.code === 'POLICY_DENIED') observe?.(receipt, decisionPolicy.revision);
          throw error;
        });
        if (authorization.revision !== person.document.revision) return refuse();
      }, peer), valid);
    },
    async inspect(receipt: ModelInvocationReceipt) {
      if (!live()) return refuse();
      return inspectionApplication(await actorFor(receipt)).inspectRetainedTurnReceipt(receipt);
    },
  });
}
