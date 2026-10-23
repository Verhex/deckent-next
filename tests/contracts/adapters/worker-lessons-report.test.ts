import { expect, it } from 'vitest';
import { workerFinalReportSchema, workerReportLimits } from '#domain/index.js';
import { validateFinalReport } from '#adapters/core/native-connection/index.js';
// The standalone bridge's schema and collector are mounted-file internals with no package export (no host imports there).
// eslint-disable-next-line no-restricted-imports
import { createCodexState, createFinalReportJsonSchema, createNativeLineObserver, createNormalizerState, finalReportCollector } from '#adapters/core/native-connection/internal/worker.js';

// S4B-2: the standalone worker bootstrap mirrors the domain `lessons` claim: same bounds (injected registry limits), secrets redacted before retention,
// strict-schema transport nulls become absence, and a malformed claim is dropped and marked (lessons: 'invalid'), never a report rejection.
const base = { schemaVersion: 1, summary: 'Done', changedFiles: [], checks: [], openIssues: [] };
const lesson = { kind: 'lesson', title: 'Masraf merkezi', body: 'Boş geçilemez.', cause: 'Alan boştu', correction: 'Onaya gönder' };
const fact = { kind: 'fact', title: 'Not', body: 'Tek satır.' };

it('accepts the same lessons as the domain schema and keeps older reports valid', () => {
  for (const value of [base, { ...base, lessons: [] }, { ...base, lessons: [fact, lesson] }]) {
    expect(validateFinalReport(value, [])).toEqual({ status: 'reported', report: value });
    expect(workerFinalReportSchema.safeParse(value).success).toBe(true);
  }
});
it('negative: count, length, incomplete, extra-key and wrong-shape lessons are dropped and marked, never reject the report; a structural defect stays invalid', () => {
  const l = workerReportLimits;
  for (const lessons of [Array.from({ length: l.lessons + 1 }, () => fact), [{ ...fact, title: 'a'.repeat(l.lessonTitleChars + 1) }], [{ ...fact, body: 'a'.repeat(l.lessonBodyChars + 1) }],
    [{ ...lesson, cause: 'a'.repeat(l.lessonFieldChars + 1) }], [{ kind: 'lesson', title: 't', body: 'b', cause: 'c' }], [{ ...fact, cause: 'c' }], [{ ...fact, grant: 'x' }],
    [{ ...fact, title: ' ' }], [{ ...fact, kind: 'rule' }], 'text', [null], [[]]]) {
    expect(validateFinalReport({ ...base, lessons }, [])).toEqual({ status: 'reported', report: base, lessons: 'invalid' });
  }
  expect(validateFinalReport({ ...base, summary: 1, lessons: [{ kind: 'x' }] }, [])).toEqual({ status: 'unavailable', reason: 'invalid' });
});
it('redacts a known or token-shaped secret in every lesson text before the report is retained', () => {
  const secret = 'fixture-secret';
  const final = validateFinalReport({ ...base, lessons: [{ ...fact, title: secret, body: 'Bearer abc.def.ghi' }, { ...lesson, cause: secret, correction: secret }] }, [secret]);
  const bytes = JSON.stringify(final);
  expect(bytes).not.toContain(secret); expect(bytes).not.toContain('abc.def.ghi'); expect(bytes).toContain('[REDACTED]');
  expect(final.status === 'reported' && workerFinalReportSchema.safeParse(final.report).success).toBe(true);
});
it('the structured-output schemas carry lessons with the registry bounds; the strict variant makes them nullable transport fields', () => {
  const l = workerReportLimits;
  const loose = createFinalReportJsonSchema(l, false) as { required: string[]; properties: { lessons: { maxItems: number; items: { required: string[]; properties: Record<string, { maxLength: number }> } } } };
  expect(loose.properties.lessons.maxItems).toBe(l.lessons); expect(loose.required).not.toContain('lessons');
  expect(loose.properties.lessons.items.required).toEqual(['kind', 'title', 'body']);
  expect(loose.properties.lessons.items.properties.body!.maxLength).toBe(l.lessonBodyChars);
  const strict = createFinalReportJsonSchema(l, true) as unknown as { required: string[]; properties: { lessons: { anyOf: { items?: { required: string[] } }[] } } };
  expect(strict.required).toContain('lessons'); expect(strict.properties.lessons.anyOf[1]).toEqual({ type: 'null' });
  expect(strict.properties.lessons.anyOf[0]!.items!.required).toEqual(['kind', 'title', 'body', 'cause', 'correction']);
});
it('strict-schema transport nulls become absence before validation, and an invalid lessons claim from the channel is dropped and marked', () => {
  const collect = (lessons: unknown) => {
    const collector = finalReportCollector('codex', [], workerReportLimits);
    const observer = createNativeLineObserver('codex-exec-json', createNormalizerState([]), createCodexState(), () => {}, collector);
    observer.observe(Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ ...base, handoff: null, exit: null, lessons }) } }) + '\n'));
    return collector.finish();
  };
  expect(collect(null)).toEqual({ status: 'reported', report: base });
  expect(collect([{ ...fact, cause: null, correction: null }, lesson])).toEqual({ status: 'reported', report: { ...base, lessons: [fact, lesson] } });
  expect(collect([{ ...lesson, correction: null }])).toEqual({ status: 'reported', report: base, lessons: 'invalid' });
});
