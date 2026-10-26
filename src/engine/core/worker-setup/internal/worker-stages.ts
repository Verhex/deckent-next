import { workerImageStateSchema } from './acquisition.js';
import { z } from 'zod';
import type { SetupDecision, SetupStageContext } from '#engine/core/setup/index.js';

const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
/** BR1: the worker image as composition observes it (configuration, this installation's newest receipt, a read-only `image inspect` of the
 * configured image or else the receipt's, the Git path from coding detection). Absent until an installation can be read. */
export const workerFactsSchema = z.object({ configured: imageId.nullable(), receipt: z.object({ imageId, imageVersion: z.string().regex(/^r[1-9][0-9]*-\d{8}$/u),
  images: z.array(z.object({ imageId, providers: z.array(z.string()), tagVersion: z.string().regex(/^r[1-9][0-9]*(?:-[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/u).nullable().optional() }).passthrough()).optional() }).strict().nullable(),
  provider: z.string().optional(), providerPending: z.boolean().optional(), acquisition: workerImageStateSchema.nullable().optional(),
  image: z.enum(['present', 'missing', 'unknown', 'not-run']), git: z.string().min(1).max(4096).nullable() }).strict();
type WorkerFacts = z.infer<typeof workerFactsSchema>;
/** The part of the execution family's facts these stages read (the family validates the whole shape with its own schema). */
type Facts = Readonly<{ runtimes: readonly Readonly<{ id: string; support: string; daemon: string; path: string | null }>[]; worker?: WorkerFacts }>;
export const RUNTIME_STAGE_ID = 'execution:runtime', WORKER_STAGE_ID = 'execution:worker', SETTINGS_STAGE_ID = 'execution:worker-settings';

const reason = (code: string, params: Record<string, string | number> = {}) => ({ code: `setup.execution.${code}`, params });
const blocked = (code: string, params: Record<string, string | number> = {}): SetupDecision => ({ state: 'blocked', reason: reason(code, params) });
const short = (id: string) => id.slice(7, 19);
/** Shared by both stages: the observed worker facts once the runtime is ready and an installation exists; a configured image is reported
 * as the daemon has it (never rewritten here). */
function workerFacts(context: SetupStageContext): SetupDecision | Readonly<{ facts: Facts; observed: WorkerFacts; scopeId: string }> {
  const facts = context.facts as Facts | undefined, observed = facts?.worker, policy = context.states.get('core:policy');
  if (!observed) return blocked('workerUnavailable');
  if (context.states.get(RUNTIME_STAGE_ID) !== 'done') return blocked('workerWaits', { stage: RUNTIME_STAGE_ID });
  if (observed.configured) return observed.image === 'present' ? { state: 'done', reason: reason('workerReady', { image: short(observed.configured) }) }
    : blocked(observed.image === 'missing' ? 'workerMissing' : 'workerUnknown', { image: short(observed.configured) });
  if (!context.scopeId || (policy !== 'done' && policy !== 'skipped')) return blocked('workerWaits', { stage: 'core:policy' });
  return { facts: facts!, observed, scopeId: context.scopeId };
}
/** Image acquisition is an onboarding job: this stage reads consent-bound facts and never starts it. */
function worker(context: SetupStageContext): SetupDecision {
  if (!hasWorkerKind(context)) return { state: 'skipped', reason: reason('noWorkKind') };
  const facts = (context.facts as Facts | undefined)?.worker, acquisition = facts?.acquisition;
  const ready = acquisition?.images.find(image => image.provider === facts?.provider);
  if (ready && !(facts?.configured === ready.imageId && facts.image !== 'present')) return { state: 'done', reason: reason('workerBuilt', { image: short(ready.imageId), version: ready.imageVersion }) };
  if (acquisition && acquisition.phase !== 'ready') return blocked('workerAcquisition', { phase: acquisition.phase, step: acquisition.step ?? '', code: acquisition.code ?? '' });
  // A present installation fallback is not consent or an image for a newly selected provider.
  if (facts?.providerPending) {
    if (context.states.get(RUNTIME_STAGE_ID) !== 'done') return blocked('workerWaits', { stage: RUNTIME_STAGE_ID });
    if (!context.scopeId || !['done', 'skipped'].includes(context.states.get('core:policy') ?? '')) return blocked('workerWaits', { stage: 'core:policy' });
    return blocked('workerConsentRequired', { scope: context.scopeId });
  }
  const found = workerFacts(context);
  if ('state' in found) return found;
  const { observed, scopeId } = found;
  if (observed.receipt && observed.image === 'present') return { state: 'done', reason: reason('workerBuilt', { image: short(observed.receipt.imageId), version: observed.receipt.imageVersion }) };
  return blocked('workerConsentRequired', { scope: scopeId });
}
/** BR1: the execution settings composed from the runtime and Git paths detected here and the built image, through `config.set` (the existing owner). */
function settings(context: SetupStageContext): SetupDecision {
  if (!hasWorkerKind(context)) return { state: 'skipped', reason: reason('noWorkKind') };
  const observedFacts = (context.facts as Facts | undefined)?.worker;
  if (observedFacts?.configured && observedFacts.image === 'present') return { state: 'done', reason: reason('settingsWritten') };
  if (observedFacts?.configured && observedFacts.image !== 'missing') return blocked('workerUnknown', { image: short(observedFacts.configured) });
  const configured = observedFacts?.configured;
  const found = workerFacts(configured ? { ...context, facts: { ...(context.facts as Facts), worker: { ...observedFacts, configured: null } } } : context);
  if ('state' in found) return found;
  const { facts, observed, scopeId } = found, runtime = facts.runtimes.find(row => row.support === 'supported' && row.daemon === 'reachable');
  const selected = observed.acquisition?.images.find(image => image.provider === observed.provider);
  const receipt = selected ?? observed.receipt;
  if (context.states.get(WORKER_STAGE_ID) !== 'done' || !receipt) return blocked('workerWaits', { stage: WORKER_STAGE_ID });
  if (configured) return { state: 'ready', reason: reason('workerReceipt', { image: short(receipt.imageId), version: receipt.imageVersion }),
    operation: { id: 'config.set', version: 1, input: { scopeId, keyPath: 'execution.docker.imageId', value: receipt.imageId, layer: 'project' } },
    cli: ['deckent', 'config', 'set', 'execution.docker.imageId', receipt.imageId] };
  if (!observed.git || !runtime?.path) return blocked('workerGitMissing');
  // The settings section is named by the runtime registry entry the image runs on (`execution.<id>`), with the Git the coding detection found.
  const value = { [runtime.id]: { executable: runtime.path, imageId: receipt.imageId }, git: { gitExecutable: observed.git } }, text = JSON.stringify(value);
  return { state: 'ready', reason: reason('workerReceipt', { image: short(receipt.imageId), version: receipt.imageVersion }),
    operation: { id: 'config.set', version: 1, input: { scopeId, keyPath: 'execution', value, layer: 'project' } }, cli: /\s/u.test(text) || text.length > 512 ? null : ['deckent', 'config', 'set', 'execution', text] };
}
/** The two BR1 stages of the execution family, after its runtime stage (ids sort in that order under the same anchor). */
export const workerSetupStages = (options: Readonly<{ person: boolean; sizeGigabytes: number }>) => {
  void options; // Existing family callers retain their signature until the S4 card replaces the old image question.
  return [
  { id: WORKER_STAGE_ID, after: 'core:sandbox' as const, title: 'setup.execution.workerTitle', evaluate: (context: SetupStageContext) => worker(context) },
  { id: SETTINGS_STAGE_ID, after: 'core:sandbox' as const, title: 'setup.execution.settingsTitle', evaluate: settings }];
};

/** U3 passes earlier answers through `prior`; the observed registry done and pending consent are independent work-kind signals. */
export function hasWorkerKind(context: SetupStageContext): boolean {
  const facts = (context.facts as Facts | undefined)?.worker;
  const prior = (context as SetupStageContext & { prior?: ReadonlyMap<string, unknown> }).prior;
  return context.states.get('work:kind') === 'done' || typeof prior?.get('work:kind') === 'string' || !!facts?.provider;
}
