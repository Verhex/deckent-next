import { emit, t, terminalSafeText, type Locale } from '#platform/index.js';
import type { SetupStage } from '#engine/index.js';
import { askCliCard, lendHeldInput, type CliCardIo } from '#surfaces/core/cli-human/index.js';
import { runKernelCommand, type KernelCommandContext } from '#surfaces/core/cli-observe/index.js';
import type { SetupApplyResult, SetupCommandContext } from './contract.js';
import registry from './modes.json' with { type: 'json' };

/** Stages whose owner takes the person's terminal itself (a card, a picker, a second window or sudo's own password prompt): the setup
 * window closes first, the owner runs on the plain terminal, then the window reopens on a fresh observation (registry data). */
export const isForegroundStage = (stage: SetupStage | null) => !!stage?.operation && registry.foreground.includes(stage.operation.id);
const code = (error: unknown) => { const value = (error as { code?: unknown } | null)?.code; return typeof value === 'string' ? value : 'SETUP_STAGE_FAILED'; };

/** A y/n card; anything but y is "not applied" (said on the terminal), never a retry. */
async function confirmed(io: CliCardIo, title: string, body: readonly string[], yes: string): Promise<boolean> {
  const answer = await askCliCard({ title, body, options: [{ id: 'apply', label: yes, key: 'y' }, { id: 'no', label: t('setup.window.no', {}, io.locale), key: 'n' }] }, io);
  if (answer !== 'apply') emit(t('setup.foreground.notApplied', {}, io.locale), { stdout: process.stdout });
  return answer === 'apply';
}
/** BR1 1b: `init registry`'s owner: its preview (the CLI version read in a temporary network-free container), the card, then its apply. */
async function declareWorkKind(context: SetupCommandContext, root: string, stage: SetupStage, scopeId: string, io: CliCardIo,
  result: (status: SetupApplyResult['status'], failure?: string) => SetupApplyResult): Promise<SetupApplyResult> {
  const input = stage.operation!.input, locale = io.locale, options = { env: io.env ?? process.env, heal: false };
  const request = { schemaVersion: 1 as const, scopeId, provider: String(input['provider']), kind: String(input['kind']), poolId: String(input['poolId']),
    executionSlots: Number(input['executionSlots']), inFlightSlots: Number(input['inFlightSlots']) };
  emit(t('setup.work.previewing', { provider: terminalSafeText(request.provider) }, locale), { stdout: process.stdout });
  const preview = await context.initializeNativeCodingRegistry!(root, { ...request, apply: false }, options);
  if (preview.status === 'current') return result('applied');
  const params = { kind: terminalSafeText(request.kind), provider: terminalSafeText(request.provider), profile: terminalSafeText(`${preview.profile.id}@${preview.profile.version}`),
    pool: terminalSafeText(request.poolId), execution: request.executionSlots, inFlight: request.inFlightSlots };
  if (!await confirmed(io, t('setup.work.card.title', params, locale), [t('setup.work.card.body', params, locale), t('setup.work.card.write', {}, locale)], t('setup.work.card.yes', {}, locale))) {
    return result('declined');
  }
  const applied = await context.initializeNativeCodingRegistry!(root, { ...request, apply: true }, options);
  return applied.status === 'applied' || applied.status === 'current' ? result('applied') : result('refused', `INITIAL_REGISTRY_${applied.status.toUpperCase()}`);
}

/**
 * One foreground stage through its existing human owner, on the process terminal and only after the window has unmounted (never while Ink
 * holds stdin in raw mode): Docker install (I-D2 card, `sudo -k`, foreground sudo), the first-run policy upgrade (rules on a card, then the witnessed apply with the preview's `--expect`),
 * the worker image (BR1: its card, then the build or the adoption check), the first work kind and the pool (BR1 1b: each owner's preview, a card,
 * then its apply) and the human doctor (with its own fix cards). A "no" on a card is `declined`. The result never decides the next state; the
 * caller observes again. The model connection and the project-instruction bridges are onboarding (U3-1a): never a `deckent init` stage.
 */
export async function runForegroundStage(context: SetupCommandContext, root: string, stage: SetupStage, scopeId: string | null, locale: Locale): Promise<SetupApplyResult> {
  const op = stage.operation!.id, env = context.env ?? process.env, io: CliCardIo = { locale, env, stdin: process.stdin, stdout: process.stdout };
  const result = (status: SetupApplyResult['status'], failure?: string): SetupApplyResult => ({ stage: stage.id, operation: op, status, ...(failure ? { code: failure } : {}) });
  const human = { ...context, env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, locale };
  try {
    if (op === 'doctor.inspect') { await runKernelCommand(['doctor'], human as unknown as KernelCommandContext); return result('applied'); }
    if (!scopeId) return result('refused', 'CLI_SCOPE_REQUIRED');
    if (op === 'execution-environment.install' && context.installExecutionEnvironment) {
      // sudo asks on the terminal itself: the held input goes back to the line discipline for the whole install (its card included).
      const giveBack = lendHeldInput(process.stdin, { plain: true });
      const status = await context.installExecutionEnvironment(root, scopeId, io).finally(giveBack);
      if (status === 'declined') return result('declined');
      return result(status === 'succeeded' || status === 'present' ? 'applied' : 'refused', status === 'succeeded' || status === 'present' ? undefined : `SETUP_INSTALL_${status.toUpperCase()}`);
    }
    if (op === 'execution.worker-image' && context.prepareWorkerImage) {
      const imageId = stage.operation!.input['imageId'], status = await context.prepareWorkerImage(root, io, typeof imageId === 'string' ? { imageId } : {});
      return status === 'declined' ? result('declined') : result('applied');
    }
    if (op === 'work.registry' && context.initializeNativeCodingRegistry) return await declareWorkKind(context, root, stage, scopeId, io, result);
    if (op === 'work.pool' && context.installConfiguredExecutionPool) {
      const preview = await context.installConfiguredExecutionPool(root, scopeId, false), pool = preview.configured;
      if (preview.status === 'current') return result('applied');
      if (preview.status !== 'preview' || !pool) return result('refused', `POOL_${preview.status.toUpperCase()}`);
      const params = { pool: terminalSafeText(pool.poolId), execution: pool.capacity.executionSlots, inFlight: pool.capacity.inFlightSlots };
      if (!await confirmed(io, t('setup.work.poolCard.title', params, locale), [t('setup.work.poolCard.body', params, locale)], t('setup.work.poolCard.yes', {}, locale))) return result('declined');
      const applied = await context.installConfiguredExecutionPool(root, scopeId, true);
      return applied.status === 'created' || applied.status === 'current' ? result('applied') : result('refused', `POOL_${applied.status.toUpperCase()}`);
    }
    if (op === 'installation.policy-upgrade' && context.upgradePolicyTemplateInstallation) {
      const preview = await context.upgradePolicyTemplateInstallation(root, scopeId, false);
      if (preview.status !== 'preview' || !preview.expect) return result('refused', `POLICY_UPGRADE_${preview.status.toUpperCase()}`);
      const rules = (preview.rules ?? []).map(rule => { const grant = rule as { id?: string; resource?: { kind?: string } }; return `+ ${terminalSafeText(grant.id ?? '-')}: ${terminalSafeText(grant.resource?.kind ?? '-')}`; });
      const answer = await askCliCard({ title: t('setup.foreground.upgradeTitle', {}, locale), body: [t('setup.foreground.upgradeBody', { scope: terminalSafeText(scopeId) }, locale), ...rules],
        options: [{ id: 'apply', label: t('setup.foreground.upgradeApply', {}, locale), key: 'y' }, { id: 'no', label: t('setup.window.no', {}, locale), key: 'n' }] }, io);
      if (answer !== 'apply') { emit(t('setup.foreground.notApplied', {}, locale), { stdout: process.stdout }); return result('declined'); }
      const applied = await context.upgradePolicyTemplateInstallation(root, scopeId, true, preview.expect);
      return result(applied.status === 'upgraded' ? 'applied' : 'refused', applied.status === 'upgraded' ? undefined : `POLICY_UPGRADE_${applied.status.toUpperCase()}`);
    }
    return result('not-wired');
  } catch (error) {
    // The owner's own typed refusal (no terminal, no witness, no grant, a declined card) is shown as it is; nothing is retried here.
    emit(t('setup.apply.refused', { stage: terminalSafeText(stage.id), code: code(error) }, locale), { stdout: process.stdout });
    return result('refused', code(error));
  }
}
