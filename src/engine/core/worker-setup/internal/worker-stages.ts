import { z } from 'zod';
import type { SetupDecision, SetupStageContext } from '#engine/core/setup/index.js';

const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
/** BR1: the worker image as composition observes it (configuration, this installation's newest receipt, a read-only `image inspect` of the
 * configured image or else the receipt's, the Git path from coding detection). Absent until an installation can be read. */
export const workerFactsSchema = z.object({ configured: imageId.nullable(), receipt: z.object({ imageId, imageVersion: z.string().regex(/^r[1-9][0-9]*-\d{8}(?:-[a-z0-9]{1,32})?$/u),
  images: z.array(z.object({ imageId, providers: z.array(z.string()) }).passthrough()).optional() }).strict().nullable(),
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
/**
 * BR1 (owner Q2 2026-10-23): the worker image after the runtime. A receipt of this installation whose image the daemon has: done. Otherwise
 * only a person is asked (`person`; the build is a foreground stage after a card, `sizeGigabytes` is named); `--image-id` adopts the same way.
 */
function worker(context: SetupStageContext, options: Readonly<{ person: boolean; sizeGigabytes: number }>): SetupDecision {
  const found = workerFacts(context);
  if ('state' in found) return found;
  const { observed, scopeId } = found;
  if (observed.receipt && observed.image === 'present') return { state: 'done', reason: reason('workerBuilt', { image: short(observed.receipt.imageId), version: observed.receipt.imageVersion }) };
  const adopt = imageId.safeParse((context.answer as { imageId?: unknown } | null)?.imageId).data ?? null;
  const operation = { id: 'execution.worker-image', version: 1, input: { scopeId, ...(adopt ? { imageId: adopt } : {}) } };
  const cli = ['deckent', 'init', '--scope', scopeId, ...(adopt ? ['--image-id', adopt] : [])];
  if (context.answer === false) return { state: 'skipped', reason: reason('workerDeclined') };
  if (adopt || context.answer === true) return { state: 'ready', reason: adopt ? reason('workerAdopt', { image: short(adopt) }) : reason('workerBuildChosen'), operation, cli };
  if (!options.person) return { state: 'blocked', reason: reason('workerNone'), cli };
  return { state: 'needs-answer', reason: reason('workerNone'), question: { key: 'setup.execution.workerBuild', params: { size: options.sizeGigabytes.toFixed(1) } },
    default: false, operation, cli };
}
/** BR1: the execution settings composed from the runtime and Git paths detected here and the built image, through `config.set` (the existing owner). */
function settings(context: SetupStageContext): SetupDecision {
  if ((context.facts as Facts | undefined)?.worker?.configured) return { state: 'done', reason: reason('settingsWritten') };
  const found = workerFacts(context);
  if ('state' in found) return found;
  const { facts, observed, scopeId } = found, runtime = facts.runtimes.find(row => row.support === 'supported' && row.daemon === 'reachable');
  if (context.states.get(WORKER_STAGE_ID) !== 'done' || !observed.receipt) return blocked('workerWaits', { stage: WORKER_STAGE_ID });
  if (!observed.git || !runtime?.path) return blocked('workerGitMissing');
  // The settings section is named by the runtime registry entry the image runs on (`execution.<id>`), with the Git the coding detection found.
  const value = { [runtime.id]: { executable: runtime.path, imageId: observed.receipt.imageId }, git: { gitExecutable: observed.git } }, text = JSON.stringify(value);
  return { state: 'ready', reason: reason('workerReceipt', { image: short(observed.receipt.imageId), version: observed.receipt.imageVersion }),
    operation: { id: 'config.set', version: 1, input: { scopeId, keyPath: 'execution', value, layer: 'project' } }, cli: /\s/u.test(text) || text.length > 512 ? null : ['deckent', 'config', 'set', 'execution', text] };
}
/** The two BR1 stages of the execution family, after its runtime stage (ids sort in that order under the same anchor). */
export const workerSetupStages = (options: Readonly<{ person: boolean; sizeGigabytes: number }>) => [
  { id: WORKER_STAGE_ID, after: 'core:sandbox' as const, title: 'setup.execution.workerTitle', evaluate: (context: SetupStageContext) => worker(context, options) },
  { id: SETTINGS_STAGE_ID, after: 'core:sandbox' as const, title: 'setup.execution.settingsTitle', evaluate: settings }];
