import { sha256 } from '#platform/index.js';
import { BEUSER_LIMITS_REGISTRY, BeuserContractError, type createBeuserTranscript } from '#engine/index.js';
import type { HarnessEvent } from '#adapters/index.js';

type Transcript = ReturnType<ReturnType<typeof createBeuserTranscript>['finalize']>;
const limits = BEUSER_LIMITS_REGISTRY.evaluator;
/** Presentation only: canonical transcript bytes and their digests stay in retained custody. */
export function beuserEvaluatorEvidence(transcript: Transcript, rubric: unknown) {
  let previous: { digest: string; evidenceRef: string; repeats: number } | undefined;
  const rows = transcript.transcript.map(row => {
    const { sequence, kind, atMs, evidenceRef, digest } = row.entry;
    const entry = { sequence, kind, atMs, evidenceRef, digest };
    let text = row.text;
    if (kind === 'screen') {
      const payload = JSON.parse(text) as HarnessEvent;
      if (payload.screen) {
        const screenDigest = sha256(JSON.stringify(payload.screen));
        if (previous?.digest === screenDigest) {
          previous.repeats++;
          return { entry, text: '', screenRef: previous.evidenceRef, repetition: previous.repeats, action: payload.action, process: payload.process };
        }
        previous = { digest: screenDigest, evidenceRef, repeats: 1 };
        const cells = payload.screen.cells;
        const screen = Object.fromEntries(Object.entries(payload.screen).filter(([key]) => !['cells', 'main', 'scrollback'].includes(key)));
        const styles = new Map<string, unknown>();
        let minContrast: number | null = null, unknownContrast = 0, samplesLimited = false;
        for (const cell of cells ?? []) {
          const { foreground, background, dim, invisible, bold, inverse, contrast } = cell;
          const style = { foreground, background, dim, invisible, bold, inverse };
          const key = JSON.stringify(style);
          if (!styles.has(key)) { if (styles.size < limits.maxStyleSamples) styles.set(key, style); else samplesLimited = true; }
          if (contrast === null) unknownContrast++; else minContrast = Math.min(minContrast ?? contrast, contrast);
        }
        text = JSON.stringify({ ...payload, screen: { ...screen, ...(cells ? { styleSummary: { runs: cells.length,
          digest: sha256(JSON.stringify(cells)), samples: [...styles.values()], samplesLimited,
          minContrast, unknownContrast } } : {}) } });
      }
    } else if (kind !== 'action') previous = undefined;
    return { entry, text };
  });
  return { rubric, transcript: { binding: transcript.binding, transcriptDigest: transcript.transcriptDigest,
    evidenceRefs: transcript.evidenceRefs, transcript: rows } };
}
type Evidence = ReturnType<typeof beuserEvaluatorEvidence>;
function isEvidence(value: unknown): value is Evidence {
  if (!value || typeof value !== 'object' || !('transcript' in value)) return false;
  const snapshot = value.transcript;
  return !!snapshot && typeof snapshot === 'object' && 'transcript' in snapshot && Array.isArray(snapshot.transcript)
    && snapshot.transcript.every((row: unknown) => !!row && typeof row === 'object' && 'text' in row && typeof row.text === 'string');
}
/** Keep complete identity/reference metadata and rubric. Only observation text may lose its middle. */
export function boundedBeuserEvaluatorMessages(system: string, input: unknown, evidence: unknown) {
  const messages = (data: unknown) => [{ role: 'system' as const, content: system },
    { role: 'user' as const, content: JSON.stringify({ input, evidence: data }) }];
  const fits = (value: ReturnType<typeof messages>) => Buffer.byteLength(JSON.stringify(value)) <= limits.maxInputBytes;
  const full = messages(evidence);
  if (fits(full)) return full;
  if (!isEvidence(evidence)) throw new BeuserContractError('BEUSER_EVALUATOR_INPUT_TOO_LARGE');
  const rows = evidence.transcript.transcript;
  const total = rows.reduce((size, row) => size + row.text.length, 0);
  const clipped = (keep: number) => {
    let head = Math.ceil(keep / 2), tail = Math.floor(keep / 2);
    const heads = rows.map(row => { const count = Math.min(row.text.length, head); head -= count; return count; });
    const tails = rows.map(() => 0);
    for (let i = rows.length - 1; i >= 0; i--) { tails[i] = Math.min(rows[i]!.text.length - heads[i]!, tail); tail -= tails[i]!; }
    let retainedTextCodeUnits = 0;
    const excerpts = rows.map((row, i) => {
      const start = heads[i]!, end = tails[i]!;
      if (start + end === row.text.length) { retainedTextCodeUnits += row.text.length; return row; }
      // Never split a UTF-16 surrogate pair when retaining a UTF-8 observation excerpt.
      const prefix = row.text.slice(0, start).replace(/[\uD800-\uDBFF]$/u, '');
      const suffix = end ? row.text.slice(-end).replace(/^[\uDC00-\uDFFF]/u, '') : '';
      retainedTextCodeUnits += prefix.length + suffix.length;
      return { ...row, text: prefix, textTail: suffix, textTruncated: true };
    });
    return messages({ ...evidence, transcript: { ...evidence.transcript, truncation: { truncated: true, originalTextCodeUnits: total,
      retainedTextCodeUnits, strategy: 'head-tail' }, transcript: excerpts } });
  };
  let low = 0, high = total;
  if (!fits(clipped(0))) throw new BeuserContractError('BEUSER_EVALUATOR_INPUT_TOO_LARGE');
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(clipped(middle))) low = middle; else high = middle - 1;
  }
  return clipped(low);
}
