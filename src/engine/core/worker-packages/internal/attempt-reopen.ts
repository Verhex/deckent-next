import type { AttemptIdentity, NativeNodeDependencyParameters, NativeNodeDependencyReference, RunSnapshot } from '#domain/index.js';
import { packageConsentDigest } from '#engine/core/config/index.js';
import { DispatchPolicyAuthorization } from '#engine/core/policy/index.js';
import type { RunReceipt } from '#engine/core/runs/index.js';
import { packageRefused } from './package-activity.js';
import { recheckPackageSecrets } from './package-secrets.js';
import { withPackageUse } from './package-use.js';
import type { PackageContext, PackageProfile, PackageSecretSnapshot, WorkerPackagePorts } from './ports.js';

export async function assertAttemptPackageInput(dependencies: NativeNodeDependencyParameters, run: RunSnapshot | null,
  identity: AttemptIdentity, loadReceipt: (scopeId: string, commandId: string) => Promise<RunReceipt | null>): Promise<void> {
  if (dependencies.state !== 'sealed' || !run?.authority || dependencies.approval.scopeId !== identity.scopeId) throw packageRefused();
  if (!dependencies.allowance) {
    const receipt = await loadReceipt(identity.scopeId, dependencies.approval.commandId);
    if (!run.authority.approval || receipt?.snapshot.identity.runId !== identity.runId
      || receipt.snapshot.authority?.approval?.approvalId !== run.authority.approval.approvalId) throw packageRefused();
  }
}

export function reopenAttemptPackage<C extends PackageContext, T>(ports: WorkerPackagePorts<C>, context: C, identity: AttemptIdentity,
  dependencies: NativeNodeDependencyReference, profile: PackageProfile, scanned: PackageSecretSnapshot | undefined,
  stage: string, validate: (() => Promise<void>) | undefined, work: () => Promise<T>): Promise<T> {
  if (!validate) throw packageRefused();
  // Compare the completed scan's snapshot under custody through each managed handover.
  if (!dependencies.allowance) return ports.secrets.exclusive(async selected => {
    await recheckPackageSecrets(ports.secrets, context.config, selected, scanned?.registered);
    await validate();
    return work();
  });
  const useId = packageConsentDigest('worker-package-attempt:1', { identity, stage });
  return withPackageUse(ports, context, [{ reference: dependencies, profile }], 'open', useId, work, async fresh => {
    const policy = ports.policySource(fresh, fresh.document);
    await new DispatchPolicyAuthorization(policy).authorizeIdentity('execute', identity, fresh.principal);
    await validate();
  });
}
