import { userInfo } from 'node:os';
import { inspectProductDirectory, loadConfig, type ProductLayout } from '#platform/index.js';
import { FileArtifactStore } from '#adapters/index.js';
import { DispatchApplication, DispatchError, DispatchPolicyAuthorization, sandboxRequestSchema,
  type RunCancellationDispatchStore, type SandboxRequest, type PrincipalVerifier, type DispatchStore } from '#engine/index.js';
import type { AttemptStore } from '#engine/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { recordedSupervisor } from './recorded-supervisor.js';

type CancellationStore = RunCancellationDispatchStore & DispatchStore & Pick<AttemptStore, 'load' | 'commit'>;
type Config = Awaited<ReturnType<typeof loadConfig>>;

/** Restore each worker from its recorded supervisor profile. Current config supplies only policy,
 * artifact limits and local management access; it never replaces execution custody. */
export function createRecordedCancellationDelivery(store: CancellationStore, config: Config, layout: ProductLayout,
  principal: VerifiedPrincipal, verifier: PrincipalVerifier) {
  const createDispatch = async (request: SandboxRequest) => {
    const recorded = await store.loadCancellationDispatch(request.identity);
    if (!recorded) throw new DispatchError('DISPATCH_NOT_ADMITTED');
    const artifacts = new FileArtifactStore({ root: await inspectProductDirectory(layout, 'artifacts'), maxBytes: config.artifacts.maxBytes });
    const policy = new DispatchPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes));
    return new DispatchApplication(store, recordedSupervisor(recorded.profile), verifier, policy, principal.id, artifacts);
  };
  return Object.freeze({
    async authorizeCancellation(request: SandboxRequest, credential?: unknown) {
      const parsed = sandboxRequestSchema.parse(request); await (await createDispatch(parsed)).authorizeCancellation(parsed, credential);
    },
    async cancel(request: SandboxRequest, credential?: unknown) {
      const parsed = sandboxRequestSchema.parse(request); return (await createDispatch(parsed)).cancel(parsed, credential);
    },
  });
}
