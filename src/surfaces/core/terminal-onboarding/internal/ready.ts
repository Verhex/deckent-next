import { ErrorRegistry } from '#platform/index.js';
import type { SetupStage } from '#engine/index.js';
import type { OnboardingPort, OnboardingPresentation, OnboardingUi } from './contract.js';

/** Reobserve each owner after every write, including a relaunch after a partial ready card. */
export async function settleOnboardingReady(port: OnboardingPort, ui: OnboardingUi, refresh: () => Promise<OnboardingPresentation>,
  confirmProfile: (preview: Awaited<ReturnType<NonNullable<OnboardingPort['previewProfile']>>>) => Promise<boolean>) {
  for (const id of ['execution:worker-settings', 'work:kind', 'work:pool']) {
    const fresh = await refresh(), current = fresh.snapshot.plan.stages.find(row => row.id === id);
    if (current?.state === 'done' && !current.operation) continue;
    if (current?.state !== 'ready' || !current.operation) throw ErrorRegistry.createError('WORKER_SETUP_PENDING', { params: { phase: 'awaiting-confirmation' } });
    let stage: SetupStage = current;
    if (current.operation.id === 'work.profile-add') {
      if (!port.previewProfile) throw ErrorRegistry.createError('CODING_TEMPLATE_INPUT_INVALID');
      const preview = await port.previewProfile(current);
      if (!await confirmProfile(preview)) return false;
      stage = { ...current, operation: { ...current.operation, input: { ...current.operation.input, digest: preview.digest, expect: preview.expect } } };
    }
    const result = id === 'execution:worker-settings' || current.operation.id === 'work.profile-add'
      ? await port.apply(stage, fresh.snapshot.configBasis) : await ui.foreground(stage);
    if (result.status !== 'applied') return false;
    const after = await refresh(), settled = after.snapshot.plan.stages.find(row => row.id === id);
    if (settled?.state !== 'done' || settled.operation) throw ErrorRegistry.createError('WORKER_SETUP_PENDING', { params: { phase: 'awaiting-confirmation' } });
  }
  return true;
}
