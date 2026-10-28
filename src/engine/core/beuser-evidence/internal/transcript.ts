import { beuserTranscriptEntrySchema, beuserVerdictSchema, type BeuserTranscriptEntry, type BeuserVerdict } from '#domain/core/beuser/index.js';
import { beuserDigest } from '#capabilities/index.js';
import { redactForRecord, type KnownSecretSnapshot } from '#platform/index.js';
import { assertBeuserAccess, pinBeuserLimits, type BeuserContext, type EvidencePort } from '#engine/core/beuser-contract/index.js';
/** Controller-private recorder: return only redacted text to both the model and retained supervisor output. */
export function createBeuserTranscript(admitted: BeuserContext, known: KnownSecretSnapshot) {
  const limits = pinBeuserLimits(admitted.limits), rows: { readonly entry: BeuserTranscriptEntry; readonly text: string }[] = [];
  let sealed = false;
  return Object.freeze({
    append(context: BeuserContext, event: { readonly binding: unknown; readonly atMs: number; readonly kind: BeuserTranscriptEntry['kind']; readonly evidenceRef: string; readonly text: string }) {
      assertBeuserAccess(admitted, context.binding, context.principal, { kind: 'beuser-transcript', id: admitted.binding.transcriptId }, 'inspect');
      context.signal.throwIfAborted();
      assertBeuserAccess(admitted, event.binding, context.principal, { kind: 'beuser-transcript', id: admitted.binding.transcriptId }, 'inspect');
      if (sealed || rows.some(r => r.entry.evidenceRef === event.evidenceRef) || event.atMs > limits.maxWallMs
        || event.atMs < (rows.at(-1)?.entry.atMs ?? 0)
        || event.kind === 'action' && rows.filter(r => r.entry.kind === 'action').length >= limits.maxSteps) throw new Error('BEUSER_INPUT_INVALID');
      if (event.kind !== 'secret-step' && known.pendingStart(event.text) < event.text.length) throw new Error('BEUSER_INPUT_INVALID');
      const text = event.kind === 'secret-step' ? '' : redactForRecord(event.text, known);
      const entry = beuserTranscriptEntrySchema.parse({ schemaVersion: 1, binding: admitted.binding, sequence: rows.length + 1,
        atMs: event.atMs, kind: event.kind, evidenceRef: event.evidenceRef, digest: beuserDigest(text) });
      const row = Object.freeze({ entry, text });
      if (Buffer.byteLength(JSON.stringify([...rows, row])) > limits.maxTranscriptBytes) throw new Error('BEUSER_INPUT_INVALID');
      rows.push(row);
      return row;
    },
    inspect(context: BeuserContext) {
      assertBeuserAccess(admitted, context.binding, context.principal, { kind: 'beuser-transcript', id: admitted.binding.transcriptId }, 'inspect');
      context.signal.throwIfAborted();
      return Object.freeze([...rows]);
    },
    finalize(context: BeuserContext) {
      assertBeuserAccess(admitted, context.binding, context.principal, { kind: 'beuser-transcript', id: admitted.binding.transcriptId }, 'inspect');
      context.signal.throwIfAborted(); sealed = true;
      return Object.freeze({ binding: admitted.binding, transcriptDigest: beuserDigest(rows), evidenceRefs: Object.freeze(rows.map(r => r.entry.evidenceRef)), transcript: Object.freeze([...rows]) });
    },
  });
}

/** C4 receives metadata only after the controller captured/redacted the actual event. Uncaptured hashes are refused. */
export function createBeuserEvidencePort(admitted: BeuserContext, recorder: ReturnType<typeof createBeuserTranscript>,
  readVerdict: (context: BeuserContext) => Promise<BeuserVerdict | null>): EvidencePort {
  const access = (context: BeuserContext) => {
    assertBeuserAccess(admitted, context.binding, context.principal, { kind: 'beuser-transcript', id: admitted.binding.transcriptId }, 'inspect');
    context.signal.throwIfAborted();
  };
  return Object.freeze({
    async append(context: BeuserContext, input: BeuserTranscriptEntry) {
      access(context);
      const entry = beuserTranscriptEntrySchema.parse(input);
      // Captured metadata cannot introduce a second producer or new content.
      const captured = recorder.inspect(context).find(row => row.entry.sequence === entry.sequence);
      if (!captured || beuserDigest(captured.entry) !== beuserDigest(entry)) throw new Error('BEUSER_INPUT_INVALID');
    },
    async finalize(context: BeuserContext) { access(context); return recorder.finalize(context); },
    async readback(context: BeuserContext) {
      access(context);
      const result = await readVerdict(context);
      access(context);
      const verdict = result === null ? null : beuserVerdictSchema.parse(result);
      if (verdict) assertBeuserAccess(admitted, verdict.binding, context.principal, { kind: 'beuser-transcript', id: admitted.binding.transcriptId }, 'inspect');
      return { binding: admitted.binding, verdict };
    },
  });
}
