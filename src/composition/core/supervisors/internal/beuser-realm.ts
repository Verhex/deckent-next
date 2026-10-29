import { join } from 'node:path';
import { userInfo } from 'node:os';
import { beuserDigest, type ArtifactStore } from '#capabilities/index.js';
import { pinRealmOptions, createBeuserRealmCustody, createBeuserRealm, createBeuserRemovalReadback, beuserPrivateRecord } from '#adapters/index.js';
import { BEUSER_LIMITS_REGISTRY, BeuserContractError, beuserBindingDigest, type BeuserContext, type SandboxRequest, type SupervisorProfile,
  type DispatchStore, type BeuserRealmCustody } from '#engine/index.js';
import { ErrorRegistry, sha256, prepareProductDirectory, type ProductLayout, type ResolvedConfig } from '#platform/index.js';
import { profileData } from './beuser-profile.js';

/** Opens only the retained realm owner. No surface, model, launch or mutable execution-profile selection. */
export async function openConfiguredBeuserRealmOwner(c: { readonly config: ResolvedConfig; readonly layout: ProductLayout }, context: BeuserContext,
  request: SandboxRequest, profile: SupervisorProfile, store: Pick<DispatchStore, 'readDispatch'>, artifacts: ArtifactStore, owner: string,
  created?: (id: string) => Promise<void>) {
  const data = profileData(profile), config = c.config;
  const limits = BEUSER_LIMITS_REGISTRY.profiles.find(item => item.revision === data.limitsRevision);
  if (!limits || JSON.stringify(limits) !== JSON.stringify(context.limits)) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE');
  if (beuserBindingDigest(data.binding) !== beuserBindingDigest(context.binding) || beuserDigest(request.identity) !== beuserDigest(context.binding.identity)) throw new BeuserContractError('BEUSER_INPUT_INVALID');
  const control = config.execution?.docker; if (!control) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
  const crashes = await prepareProductDirectory(c.layout, 'crashes'), directory = join(crashes, 'beuser-custody');
  const retainedCustody = await createBeuserRealmCustody({ context, request, store, owner, directory, timeoutMs: config.configFile.writeLockTimeoutMs });
  const custody: BeuserRealmCustody = { ...retainedCustody, async publish(ctx, handle) { await retainedCustody.publish(ctx, handle); if (handle.containerId) await created?.(handle.containerId); } };
  const runtimeOptions = pinRealmOptions({ controllerRoot: directory, packageRoot: data.candidateRoot, executable: control.executable,
    image: control.imageId, uid: userInfo().uid, gid: userInfo().gid, memoryBytes: control.memoryBytes, nanoCpus: control.cpus * 1_000_000_000,
    pids: control.pids, filesystemBytes: control.tmpBytes });
  const removal = createBeuserRemovalReadback(runtimeOptions, artifacts, beuserPrivateRecord(directory, `kernel-${sha256(JSON.stringify(context.binding.identity))}`, context.limits.maxArtifactBytes));
  const realm = createBeuserRealm({ context, options: runtimeOptions, custody, artifacts, measurement: { digest: data.packageDigest, files: data.files, limits: config.installation.packageMeasurement }, capture: removal.capture, removal: removal.read });
  return { data, custody, runtimeOptions, removal, realm };
}
