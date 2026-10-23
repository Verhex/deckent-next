import { z } from 'zod';
import { workerFactsSchema, workerSetupStages, type SetupDecision, type SetupFamilyPackage, type SetupOperation, type SetupStageContext } from '#engine/index.js';
import limits from './limits.json' with { type: 'json' };

const version = z.string().regex(/^[0-9A-Za-z.+~_-]{1,64}$/u).nullable();
/** One registry entry as detected. `daemon`: reachable | unreachable (stopped, socket missing) | no-permission (this user may not open the
 * socket) | unknown (no answer in time) | not-run. `group` only with no-permission: member | relogin | not-member | unknown. */
export const runtimeFactsSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), label: z.string().min(1).max(64), support: z.enum(['supported', 'unsupported']),
  cli: z.enum(['found', 'absent', 'unknown']), path: z.string().min(1).max(4096).nullable(), version,
  daemon: z.enum(['reachable', 'unreachable', 'no-permission', 'unknown', 'not-run']), serverVersion: version,
  kind: z.enum(['engine', 'desktop', 'rootless', 'unknown']).nullable(), endpoint: z.enum(['system', 'user', 'remote']).nullable(),
  group: z.enum(['member', 'relogin', 'not-member', 'unknown']).nullable() }).strict();
/** The execution-environment family's facts (I-S2): one row per registry entry, in registry order; locale-free and secret-free. */
export const executionFactsSchema = z.object({ schemaVersion: z.literal(1), runtimes: z.array(runtimeFactsSchema).max(16), worker: workerFactsSchema.optional() }).strict();
export type RuntimeFacts = z.infer<typeof runtimeFactsSchema>;
export type ExecutionFacts = z.infer<typeof executionFactsSchema>;
/** I-D2's seam: an install offer for a machine without a supported runtime (its own operation, question and command; keys under
 * `setup.execution.`); null keeps the detection-only stage. Family stages are never `--yes`-eligible (planner rule). */
export type ExecutionInstallOffer = Readonly<{ operation: SetupOperation; question: Readonly<{ key: string; params: Readonly<Record<string, string | number>> }>;
  cli: readonly string[] | null }>;
/** `person`: a person answers in the window, so the worker-image build may be offered (never to a pipe, `--json`, an agent or `--yes`). */
export type ExecutionFamilyOptions = Readonly<{ install?: (facts: ExecutionFacts) => ExecutionInstallOffer | null; person?: boolean }>;
export const EXECUTION_STAGE_ID = 'execution:runtime', WORKER_IMAGE_ESTIMATED_GB: number = limits.workerImageGigabytes;

const reason = (code: string, params: Record<string, string | number> = {}) => ({ code: `setup.execution.${code}`, params });
const blocked = (code: string, params: Record<string, string | number> = {}): SetupDecision => ({ state: 'blocked', reason: reason(code, params) });
function evaluate(context: SetupStageContext, options: ExecutionFamilyOptions): SetupDecision {
  const facts = context.facts as ExecutionFacts | undefined;
  if (!facts) return blocked('unavailable');
  const supported = facts.runtimes.filter(row => row.support === 'supported'), ready = supported.find(row => row.daemon === 'reachable');
  if (ready) return { state: 'done', reason: reason(ready.kind === 'desktop' ? 'readyDesktop' : ready.kind === 'rootless' ? 'readyRootless' : 'ready',
    { runtime: ready.label, version: ready.serverVersion ?? '-' }) };
  const installed = supported.find(row => row.cli === 'found') ?? supported.find(row => row.cli === 'unknown');
  if (installed) {
    const runtime = installed.label;
    if (installed.daemon === 'no-permission') return blocked(installed.group === 'relogin' ? 'relogin' : installed.group === 'member' ? 'socketMode' : 'noPermission', { runtime });
    return blocked(installed.daemon !== 'unreachable' ? 'unknown' : installed.kind === 'desktop' ? 'desktopStopped' : 'stopped', { runtime });
  }
  // D3: an honest capability label: no Run, /do or delivery without an execution environment; chat, MCP and governed tools work.
  const other = facts.runtimes.find(row => row.support === 'unsupported' && row.cli === 'found'), offer = options.install?.(facts) ?? null;
  const absent = other ? reason('unsupportedOnly', { runtime: other.label }) : reason('none'), cli = offer?.cli ? [...offer.cli] : null;
  if (!offer) return { state: other ? 'unsupported' : 'blocked', reason: absent };
  if (context.answer === false) return { state: 'skipped', reason: reason('declined') };
  return context.answer === true ? { state: 'ready', reason: absent, operation: offer.operation, cli }
    : { state: 'needs-answer', reason: absent, operation: offer.operation, question: offer.question, default: false, cli };
}

/** The execution-environment setup family (INIT ANALYSIS §11(b)): its facts, the detection stage after the Core sandbox stage, then the worker
 * image and the execution settings (BR1, the engine's pure stages). One package per namespace (a second `execution` package is refused), so
 * I-D2 extends this one through `install`. */
export const executionSetupFamily = (options: ExecutionFamilyOptions = {}): SetupFamilyPackage => Object.freeze({ namespace: 'execution', source: 'deckent-core',
  facts: executionFactsSchema.optional(), stages: [{ id: EXECUTION_STAGE_ID, after: 'core:sandbox' as const, title: 'setup.execution.title',
    evaluate: (context: SetupStageContext) => evaluate(context, options) },
  ...workerSetupStages({ person: options.person === true, sizeGigabytes: WORKER_IMAGE_ESTIMATED_GB })] });
