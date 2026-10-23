import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import automationSeed from '../../../../../assets/memory/automation.json' with { type: 'json' };
import extractorsSeed from '../../../../../assets/memory/extractors.json' with { type: 'json' };
import templatesSeed from '../../../../../assets/memory/templates.json' with { type: 'json' };
import { CORE_WORK_CLASSES, mergeWorkClassRegistries, type WorkClassRegistry } from '#domain/core/run/index.js';
import { MEMORY_LIMITS, MemoryError, memoryLessonClaimSchema } from './contract.js';

/**
 * S4B-1 memory automation registries (S4B-DESIGN §4.1, §4.2, §4.4, §10; owner S-M1/S-M11 2026-10-23). Versioned Core seeds (`assets/memory`); every
 * bound is provisional until measured on a real installation (K-F S8). The installation overlay lives only under the protected config subtree `memory.automation`
 * (A10: no AI writes it) and may only narrow: lower a bound, add a WorkClass row, or switch a seed row's extraction off / shorten its retention.
 */
const positive = z.number().int().positive().safe();
const workClassRowSchema = z.object({ workClassId: identitySchema, retentionProfile: z.object({ id: identitySchema, entryMaxAgeMs: positive }).strict().readonly(),
  personalData: z.enum(['none', 'possible']), extraction: z.boolean() }).strict().readonly();
const boundsSchema = z.object({ perAttempt: positive, perRun: positive, perScopePerDay: positive, supportPerEntry: positive, loopPage: positive }).strict();
const contextSchema = z.object({ maxEntries: positive, maxBytes: positive, maxSourcesChecked: positive }).strict();
const evaluationSchema = z.object({ perScopePerDay: positive, contestsPerScopePerDay: positive }).strict();
const automationSchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema, status: z.enum(['provisional', 'measured']), bounds: boundsSchema.readonly(),
  context: contextSchema.readonly(), evaluation: evaluationSchema.readonly(), workClasses: z.array(workClassRowSchema).max(256).readonly() }).strict().readonly();
export const memoryAutomationOverlaySchema = z.object({ bounds: boundsSchema.partial().optional(), context: contextSchema.partial().optional(),
  evaluation: evaluationSchema.partial().optional(), workClasses: z.array(workClassRowSchema).max(256).readonly().optional() }).strict().readonly();
export type MemoryAutomation = z.infer<typeof automationSchema>;
export type MemoryWorkClassRow = z.infer<typeof workClassRowSchema>;
const invalid = () => new MemoryError('MEMORY_AUTOMATION_INVALID');
const narrower = <T extends Readonly<Record<string, number>>>(seed: T, overlay: { readonly [K in keyof T]?: number | undefined } | undefined): T => {
  const out: Record<string, number> = { ...seed };
  for (const [key, value] of Object.entries(overlay ?? {})) if (value !== undefined) { if (value > seed[key]!) throw invalid(); out[key] = value; }
  return Object.freeze(out) as T;
};
/** The seed with an installation overlay applied; any widening, duplicate row or malformed value is `MEMORY_AUTOMATION_INVALID` (never a default). */
export function composeMemoryAutomation(overlay?: unknown): MemoryAutomation {
  const seed = automationSchema.safeParse(automationSeed), extra = memoryAutomationOverlaySchema.safeParse(overlay ?? {});
  if (!seed.success || !extra.success) throw invalid();
  const rows = new Map(seed.data.workClasses.map(row => [row.workClassId, row] as const));
  if (rows.size !== seed.data.workClasses.length) throw invalid();
  const added = new Set<string>();
  for (const row of extra.data.workClasses ?? []) {
    const base = rows.get(row.workClassId);
    if (added.has(row.workClassId)) throw invalid();
    added.add(row.workClassId);
    if (base && (row.retentionProfile.entryMaxAgeMs > base.retentionProfile.entryMaxAgeMs || (base.personalData === 'possible' && row.personalData === 'none')
      || (!base.extraction && row.extraction))) throw invalid();
    rows.set(row.workClassId, row);
  }
  return Object.freeze({ ...seed.data, bounds: narrower(seed.data.bounds, extra.data.bounds), context: narrower(seed.data.context, extra.data.context),
    evaluation: narrower(seed.data.evaluation, extra.data.evaluation), workClasses: Object.freeze([...rows.values()]) });
}
/** S-M11: extraction runs only for a WorkClass with a row whose extraction is enabled and that carries no personal data. */
export const memoryExtractionAllowed = (automation: MemoryAutomation, workClassId: string) =>
  automation.workClasses.some(row => row.workClassId === workClassId && row.extraction && row.personalData === 'none');

/** The source class as the distiller keys it: its id, its family (root of the parent chain) and its proposal risk (unset → normal). Unknown → null. */
export function memoryWorkClassOf(configured: WorkClassRegistry | undefined, classId: string | null): { id: string; family: string; risk: 'low' | 'normal' | 'high' } | null {
  if (classId === null) return null;
  const policy = configured?.schemaVersion !== undefined && configured.schemaVersion !== 1 ? mergeWorkClassRegistries(CORE_WORK_CLASSES, [configured]) : configured ?? CORE_WORK_CLASSES;
  const byId = new Map(policy.classes.map(row => [row.id, row] as const)), start = byId.get(classId);
  if (!start) return null;
  let root = start;
  for (let hops = 0; 'parentClassId' in root && root.parentClassId !== undefined && hops < byId.size; hops++) root = byId.get(root.parentClassId) ?? root;
  const risk = 'proposalAdmission' in start && start.proposalAdmission ? start.proposalAdmission.risk : 'normal';
  return { id: start.id, family: root.id, risk };
}
const extractorSchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema, rules: z.array(z.object({ id: z.enum(['E1', 'E2', 'E3']), version: positive,
  kind: z.enum(['human-answer', 'failure-fix', 'worker-claim']), enabled: z.boolean() }).strict().readonly()).min(1).max(16).readonly() }).strict().readonly();
export const MEMORY_EXTRACTORS = Object.freeze(extractorSchema.parse(extractorsSeed));
const templatesSchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema, templates: z.array(z.object({ id: identitySchema, version: positive,
  text: z.string().min(1).max(MEMORY_LIMITS.bodyMaxBytes) }).strict().readonly()).min(1).max(32).readonly() }).strict().readonly();
/** Model-facing texts (worker report sentence, context header, evaluator prompt): versioned data, never literals in code; `id@version` is sealed. */
export const MEMORY_TEMPLATES = Object.freeze(templatesSchema.parse(templatesSeed));
export function memoryTemplate(id: string, version: number): string {
  const row = MEMORY_TEMPLATES.templates.find(template => template.id === id && template.version === version);
  if (!row) throw invalid();
  return row.text;
}

/** One sealed source the distiller reads (built by an adapter from sealed ledger records only; never a live workspace). */
export const memoryExtractionSourceSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, runId: identitySchema, taskId: identitySchema,
  attemptId: identitySchema, generation: counterSchema.positive(),
  workClass: z.object({ id: identitySchema, family: identitySchema, risk: z.enum(['low', 'normal', 'high']) }).strict().readonly().nullable(),
  workTargetId: identitySchema.nullable(), evaluation: z.object({ id: identitySchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly(),
  /** Task phase accepted and the canonical evaluation accepted. */ accepted: z.boolean(),
  /** No unresolved effect and the Task not reopened. */ settled: z.boolean(),
  inputAnswer: z.object({ question: z.string().min(1), answer: z.string().min(1) }).strict().readonly().nullable(),
  earlierFailure: z.object({ reasonCode: identitySchema, checkIds: z.array(identitySchema).max(16).readonly() }).strict().readonly().nullable(),
  lessons: z.array(z.unknown()).max(64).readonly().nullable(), reportDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict().readonly();
export type MemoryExtractionSource = z.infer<typeof memoryExtractionSourceSchema>;
export interface MemoryCandidate { readonly ruleId: 'E1' | 'E2' | 'E3'; readonly ruleVersion: number; readonly claimIndex: number; readonly producer: 'rule' | 'worker-claim';
  readonly content: unknown }

const bytes = (value: string) => new TextEncoder().encode(value).length;
/** The longest whole-character prefix within `max` bytes, trimmed (a title is a label of the full text kept in the body, never a replacement). */
function prefix(value: string, max: number): string {
  let out = '';
  for (const char of value.trim()) { if (bytes(out + char) > max) break; out += char; }
  return out.trim();
}
/**
 * The deterministic rules (§4.2) over one sealed source, in registry order; disabled rules produce nothing. E1: a person answered the earlier
 * Attempt's question and the next generation was accepted. E2: an earlier generation failed with a typed reason and the accepted Attempt's lesson
 * claim names the correction (no claim → no candidate). E3: each claim of the accepted Attempt. Content is returned unvalidated; the caller
 * screens it and the journal refuses an invalid entry. Free worker text never becomes a cause: E2's cause is the typed reason and check ids.
 */
export function distilMemoryCandidates(source: MemoryExtractionSource): readonly MemoryCandidate[] {
  const out: MemoryCandidate[] = [], label = `run ${source.runId} task ${source.taskId}${source.workClass ? ` (${source.workClass.id})` : ''}`;
  const evidence = `evaluation ${source.evaluation.id} sha256:${source.evaluation.digest}`;
  const claims = (source.lessons ?? []).map(claim => memoryLessonClaimSchema.safeParse(claim));
  for (const rule of MEMORY_EXTRACTORS.rules) {
    if (!rule.enabled) continue;
    const base = { ruleId: rule.id, ruleVersion: rule.version };
    if (rule.kind === 'human-answer' && source.inputAnswer) out.push({ ...base, claimIndex: 0, producer: 'rule', content: { kind: 'lesson',
      title: prefix(source.inputAnswer.question, MEMORY_LIMITS.titleMaxBytes), body: source.inputAnswer.answer, tags: [],
      lesson: { source: label, cause: source.inputAnswer.question, correction: source.inputAnswer.answer, evidence } } });
    if (rule.kind === 'failure-fix' && source.earlierFailure) {
      const index = claims.findIndex(claim => claim.success && claim.data.kind === 'lesson');
      const claim = index < 0 ? undefined : claims[index]!.data;
      if (claim?.kind === 'lesson') out.push({ ...base, claimIndex: index, producer: 'rule', content: { kind: 'lesson', title: claim.title, body: claim.body, tags: [],
        lesson: { source: label, cause: [source.earlierFailure.reasonCode, ...source.earlierFailure.checkIds].join(' '), correction: claim.correction, evidence } } });
    }
    if (rule.kind === 'worker-claim') claims.forEach((claim, index) => out.push({ ...base, claimIndex: index, producer: 'worker-claim',
      content: !claim.success ? null : claim.data.kind === 'fact' ? { kind: 'fact', title: claim.data.title, body: claim.data.body, tags: [], lesson: null }
        : { kind: 'lesson', title: claim.data.title, body: claim.data.body, tags: [], lesson: { source: label, cause: claim.data.cause, correction: claim.data.correction, evidence } } }));
  }
  return Object.freeze(out);
}
