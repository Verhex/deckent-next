import { ErrorRegistry } from '#platform/index.js';
import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/index.js';
import type { RunSnapshot } from '#domain/index.js';
import type { RunSessionRegistry } from './session-registry.js';
import type { DispatchRecord } from '#engine/core/dispatch/index.js';
const progressionActorSchema = z.strictObject({ id: identitySchema, issuer: identitySchema, subject: identitySchema });
export const progressionCursorSchema = z.strictObject({ scopeId: identitySchema, runId: identitySchema });
export const progressionQuerySchema = z.strictObject({ actor: progressionActorSchema,
  after: progressionCursorSchema.nullable(), limit: counterSchema.positive().max(2147483646),
  /** When set, only scopes registered to this company are listed (foreign and unregistered scopes are not this installation's work). */
  companyId: identitySchema.optional() });
export type ProgressionQuery = z.infer<typeof progressionQuerySchema>;
export type ProgressionCursor = z.infer<typeof progressionCursorSchema>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export interface RunProgressionJournal {
  listRunProgression(query: ProgressionQuery): Promise<Readonly<{ items: readonly ProgressionCursor[]; next: ProgressionCursor | null }>>;
}

/** Full trusted local identity match, never a caller-selectable impersonation API. */
export function selectProgressionActor(actor: ProgressionQuery['actor'], read: (channel: 'mcp' | undefined) => ProgressionQuery['actor']): 'mcp' | undefined {
  for (const channel of [undefined, 'mcp'] as const) {
    const local = read(channel);
    if (actor.id === local.id && actor.issuer === local.issuer && actor.subject === local.subject) return channel;
  }
  throw ErrorRegistry.createError('RUN_PROGRESSION_AUTHORITY_REQUIRED');
}
/** Selection is revalidated from durable intent and custody before entering any actor context. */
export async function selectRunProgression(query: ProgressionCursor, ledger: string, companyId: string,
  source: { readRunProgressionIntent(scopeId: string, runId: string, companyId: string): { actor: ProgressionQuery['actor']; commandId: string } | null;
    loadRun(scopeId: string, runId: string): Promise<RunSnapshot | null>; loadBoundDispatch(identity: import('#domain/index.js').AttemptIdentity): Promise<DispatchRecord | null> },
  read: (channel: 'mcp' | undefined) => ProgressionQuery['actor'], session?: RunSessionRegistry, checkStart = true) {
  const intent = source.readRunProgressionIntent(query.scopeId, query.runId, companyId);
  if (!intent) throw ErrorRegistry.createError('RUN_PROGRESSION_AUTHORITY_REQUIRED');
  let channel = selectProgressionActor(intent.actor, read), maintenance = false;
  if (checkStart && channel === 'mcp') {
    const run = await source.loadRun(query.scopeId, query.runId);
    if (!run) throw ErrorRegistry.createError('RUN_NOT_FOUND');
    if (!session?.eligible({ ledger, companyId, ...query, commandId: intent.commandId, actor: intent.actor }, run)) {
      const actor = progressionCustodyActor(run, await Promise.all(run.bindings.map(binding => source.loadBoundDispatch(binding.identity))));
      if (!actor) throw ErrorRegistry.createError('RUN_PROGRESSION_REPROPOSE_REQUIRED');
      channel = selectProgressionActor(actor, read); maintenance = true;
    }
  }
  return { channel, maintenance };
}
type Page = Readonly<{ items: readonly ProgressionCursor[]; next: ProgressionCursor | null }>;
/** SQLite BINARY ordering uses Unicode code points, including identifiers outside the BMP. */
const compareText = (a: string, b: string) => {
  const left = [...a], right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) { const delta = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!; if (delta) return delta; }
  return left.length - right.length;
};
export function mergeProgressionPages(pages: readonly Page[], limit: number): Page {
  const all = pages.flatMap(page => page.items).sort((a, b) => compareText(a.scopeId, b.scopeId) || compareText(a.runId, b.runId));
  const items = all.slice(0, limit);
  return { items, next: all.length > limit || pages.some(page => page.next) ? items.at(-1) ?? null : null };
}

/** A binding alone is not started work. Unknown or mixed custody grants no actor substitution. */
export function progressionCustodyActor(run: import('#domain/index.js').RunSnapshot, dispatches: readonly (import('#engine/core/dispatch/index.js').DispatchRecord | null)[]): ProgressionQuery['actor'] | null {
  let actor: ProgressionQuery['actor'] | null = null;
  for (const [index, binding] of run.bindings.entries()) {
    const dispatch = dispatches[index];
    if (!dispatch || dispatch.launch !== 'granted') continue;
    if (!dispatch.grant || (!dispatch.worker && !dispatch.terminal && binding.observedKind !== 'started' && binding.observedKind !== 'exited')) throw ErrorRegistry.createError('DISPATCH_NOT_ADMITTED');
    const current = dispatch.grant.principal;
    if (actor && (actor.id !== current.id || actor.issuer !== current.issuer || actor.subject !== current.subject)) throw ErrorRegistry.createError('DISPATCH_NOT_ADMITTED');
    actor = current;
  }
  return actor;
}
