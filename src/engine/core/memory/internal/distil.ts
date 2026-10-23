import { composeMemoryAutomation, distilMemoryCandidates, memoryContentSchema, memoryExtractionAllowed, memoryExtractionSourceSchema } from '#domain/index.js';
import { hasSecret } from '#platform/index.js';
import { projectModelIngressField } from '#engine/core/agent-turn/index.js';
import { MemoryJournalError, type MemoryDistilOutcome, type MemoryExtractionReceipt, type MemoryJournalDependencies } from './contract.js';

const DAY_MS = 86_400_000;
type Refusal = MemoryExtractionReceipt['refused'][number];
/** Every text field of a candidate (title, body, tags, lesson fields): what screening reads. */
const texts = (content: unknown): string[] => typeof content === 'string' ? [content] : Array.isArray(content) ? content.flatMap(texts)
  : content && typeof content === 'object' ? Object.values(content).flatMap(texts) : [];
/** §4.5 screening, fail closed and before any write: a known or pattern secret refuses; a hidden-character payload is quarantined (refused). */
export function screenMemoryCandidate(content: unknown, known: MemoryJournalDependencies['knownSecrets']): Refusal['code'] | null {
  if (!memoryContentSchema.safeParse(content).success) return 'MEMORY_ENTRY_INVALID';
  const fields = texts(content);
  if (fields.some(text => hasSecret(text, known))) return 'MEMORY_CANDIDATE_SECRET';
  if (fields.some(text => projectModelIngressField(text).disposition === 'quarantine')) return 'MEMORY_CANDIDATE_QUARANTINED';
  return null;
}

/**
 * One distiller pass over one sealed source (S4B-DESIGN §4.1–§4.5): gate (accepted and settled, WorkClass row with extraction on and no personal
 * data), the versioned rules, screening, then the bounds of the registry (per Attempt, per Run, per scope per UTC day; past a bound the rest is
 * refused with one alert, never truncated). Shadow computes and records the receipt but writes no candidate. Once per Attempt (receipt).
 */
export async function distilSource(deps: MemoryJournalDependencies, input: unknown, options: { readonly mode: 'live' | 'shadow' },
  ports: { admit(scopeId: string): Promise<void>; propose(command: unknown): Promise<{ readonly status: 'proposed' | 'supported' | 'replayed' }> }): Promise<MemoryDistilOutcome> {
  const source = memoryExtractionSourceSchema.parse(input);
  await ports.admit(source.scopeId);
  const automation = composeMemoryAutomation(deps.automation);
  if (!source.accepted || !source.settled) return { schemaVersion: 1, status: 'skipped', reason: 'not-accepted' };
  if (!source.workClass || !memoryExtractionAllowed(automation, source.workClass.id)) return { schemaVersion: 1, status: 'skipped', reason: 'work-class' };
  const ref = { runId: source.runId, taskId: source.taskId, attemptId: source.attemptId }, now = deps.now();
  const store = await deps.openStore('write');
  let counts;
  try {
    if (!store.extractionReceipt || !store.recordExtraction || !store.extractionCounts) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
    const prior = await store.extractionReceipt(source.scopeId, ref);
    if (prior) return { schemaVersion: 1, status: 'replayed', receipt: prior };
    counts = await store.extractionCounts(source.scopeId, source.runId, now - now % DAY_MS);
  } finally { store.close(); }
  const { bounds } = automation, refused: Refusal[] = [];
  let written = 0, proposed = 0, supported = 0, shadow = 0;
  for (const candidate of distilMemoryCandidates(source)) {
    const at = { ruleId: candidate.ruleId, claimIndex: candidate.claimIndex }, code = screenMemoryCandidate(candidate.content, deps.knownSecrets);
    if (code) { refused.push({ ...at, code }); continue; }
    const taken = written + shadow;
    if (taken >= bounds.perAttempt || counts.run + taken >= bounds.perRun || counts.scope + taken >= bounds.perScopePerDay) { refused.push({ ...at, code: 'MEMORY_EXTRACTION_BOUND' }); continue; }
    if (options.mode === 'shadow') { shadow++; continue; }
    try {
      const result = await ports.propose({ schemaVersion: 1, scopeId: source.scopeId, source: ref, ...at, ruleVersion: candidate.ruleVersion, content: candidate.content,
        audience: { workClassFamily: source.workClass.family, workTargetId: source.workTargetId },
        support: { producer: candidate.producer, evaluationId: source.evaluation.id, evaluationDigest: source.evaluation.digest, reportDigest: source.reportDigest } });
      written++; if (result.status === 'proposed') proposed++; else if (result.status === 'supported') supported++;
    } catch (error) {
      if (error instanceof MemoryJournalError && ['MEMORY_PURGED_CONTENT', 'MEMORY_EXTRACTION_BOUND'].includes(error.code)) refused.push({ ...at, code: error.code }); else throw error;
    }
  }
  const receipt: MemoryExtractionReceipt = { schemaVersion: 1, scopeId: source.scopeId, source: ref, atMs: now, proposed: written, shadow, mode: options.mode, refused,
    registryRevision: automation.revision };
  const sealed = await deps.openStore('write');
  try { await sealed.recordExtraction!(receipt); } finally { sealed.close(); }
  const count = (codes: readonly string[]) => refused.filter(row => codes.includes(row.code)).length;
  const alerts = ([['memory.alert.extractionBound', ['MEMORY_EXTRACTION_BOUND']], ['memory.alert.screening', ['MEMORY_CANDIDATE_SECRET', 'MEMORY_CANDIDATE_QUARANTINED']]] as const)
    .map(([key, codes]) => ({ key, scopeId: source.scopeId, count: count(codes) })).filter(alert => alert.count > 0);
  return { schemaVersion: 1, status: 'extracted', proposed, supported, shadow, refused, alerts };
}
