import { z } from 'zod';
import { nativeCliIds } from '#domain/index.js';
import type { SetupDecision, SetupFamilyPackage, SetupStageContext } from '#engine/core/setup/index.js';
import defaults from './work.json' with { type: 'json' };

/** The `work` family's facts (BR1 1b): what the first job still needs, from configuration and the pool ledger only (the I-S7 first-job facts). */
export const workFactsSchema = z.object({ execution: z.boolean(), registry: z.boolean(), pool: z.boolean(), pendingProvider: z.string().optional(),
  providers: z.array(z.string()).max(16).optional(), kinds: z.array(z.string()).max(256).optional(),
  images: z.record(z.string(), z.string().regex(/^sha256:[a-f0-9]{64}$/u)).optional() }).strict();
export const WORK_KIND_STAGE_ID = 'work:kind', WORK_POOL_STAGE_ID = 'work:pool';
/** The coding CLIs a first work kind may run on: the native CLI registry, in its order (the window's choices). */
export const WORK_PROVIDERS: readonly string[] = nativeCliIds;
export const WORK_DEFAULTS = Object.freeze({ kind: defaults.kind, poolId: defaults.pool, executionSlots: defaults.executionSlots, inFlightSlots: defaults.inFlightSlots });
const reason = (code: string, params: Record<string, string | number> = {}) => ({ code: `setup.work.${code}`, params });
const registryCli = (scopeId: string, provider: string) => ['deckent', 'init', 'registry', '--scope', scopeId, '--provider', provider, '--kind', WORK_DEFAULTS.kind,
  '--pool', WORK_DEFAULTS.poolId, '--execution-slots', String(WORK_DEFAULTS.executionSlots), '--in-flight-slots', String(WORK_DEFAULTS.inFlightSlots), '--preview'];

/** The execution settings must name a present worker image first: the execution family's own stage when it is observed, else configuration. */
const executionReady = (context: SetupStageContext, facts: z.infer<typeof workFactsSchema>) => {
  const image = context.states.get('execution:worker'), settings = context.states.get('execution:worker-settings');
  return image === undefined ? facts.execution : image === 'done' && settings === 'done';
};
/** The first work kind (its CLI chosen from the native CLI registry); the registry preview starts a container, so it runs only as a foreground stage. */
function kind(context: SetupStageContext): SetupDecision {
  const facts = context.facts as z.infer<typeof workFactsSchema> | undefined, scopeId = context.scopeId;
  if (!facts) return { state: 'blocked', reason: reason('unavailable') };
  const selected = context.answer ?? facts.pendingProvider;
  if (facts.registry && (typeof selected !== 'string' || facts.providers === undefined || facts.providers.includes(selected))) return { state: 'done', reason: reason('kindDone') };
  if (context.answer === false) return { state: 'skipped', reason: reason('kindMissing', { kind: WORK_DEFAULTS.kind, pool: WORK_DEFAULTS.poolId }) };
  if (!scopeId) return { state: 'blocked', reason: reason('unavailable') };
  const provider = WORK_PROVIDERS.includes(String(context.answer ?? facts.pendingProvider)) ? String(context.answer ?? facts.pendingProvider) : null;
  if (!provider) return { state: 'needs-answer', reason: reason('kindMissing', { kind: WORK_DEFAULTS.kind, pool: WORK_DEFAULTS.poolId }),
    question: { key: 'setup.work.kindQuestion', params: { kind: WORK_DEFAULTS.kind, pool: WORK_DEFAULTS.poolId, slots: WORK_DEFAULTS.executionSlots } }, cli: registryCli(scopeId, `<${nativeCliIds.join('|')}>`) };
  if (!executionReady(context, facts) || !facts.images?.[provider]) return { state: 'done', reason: reason('kindChosen', { provider, kind: WORK_DEFAULTS.kind }) };
  const kind = facts.registry && facts.kinds?.includes(WORK_DEFAULTS.kind) ? `${provider}-${WORK_DEFAULTS.kind}` : WORK_DEFAULTS.kind;
  return { state: 'ready', reason: reason('kindChosen', { provider, kind }), cli: registryCli(scopeId, provider),
    operation: { id: facts.registry ? 'work.profile-add' : 'work.registry', version: 1, input: { scopeId, provider, image: facts.images[provider]!, ...WORK_DEFAULTS, kind } } };
}
/** The pool's ledger row once a registry names the pool (`init pool`'s own preview, then its apply after the card). */
function pool(context: SetupStageContext): SetupDecision {
  const facts = context.facts as z.infer<typeof workFactsSchema> | undefined, scopeId = context.scopeId;
  if (!facts) return { state: 'blocked', reason: reason('unavailable') };
  if (facts.pool) return { state: 'done', reason: reason('poolDone') };
  if (!scopeId || !facts.registry) return { state: 'blocked', reason: reason('waits', { stage: WORK_KIND_STAGE_ID }) };
  return { state: 'ready', reason: reason('poolMissing'), operation: { id: 'work.pool', version: 1, input: { scopeId } }, cli: ['deckent', 'init', 'pool', '--scope', scopeId, '--preview'] };
}
/** BR1 1b: the first work kind, then its pool, after the model and the project instructions; family stages are never `--yes`-eligible. */
export const WORK_SETUP_FAMILY: SetupFamilyPackage = Object.freeze({ namespace: 'work', source: 'deckent-core', facts: workFactsSchema.optional(),
  stages: [{ id: WORK_KIND_STAGE_ID, after: 'core:model' as const, title: 'setup.work.kindTitle', evaluate: kind },
    { id: WORK_POOL_STAGE_ID, after: 'core:model' as const, title: 'setup.work.poolTitle', evaluate: pool }] });
