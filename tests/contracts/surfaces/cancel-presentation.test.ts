import { expect, it } from 'vitest';
import { main } from '#surfaces/index.js';
import { resolveProductPaths } from '#platform/index.js';
import type { RunCancellationOutcome } from '#engine/index.js';
const states: RunCancellationOutcome['status'][] = ['terminal', 'not-dispatched', 'unresolved', 'denied', 'unavailable'];
it.each(['en', 'tr'])('makes partial cancellation visible in %s without changing JSON or command success', async language => {
  const outcomes: RunCancellationOutcome[] = states.map((status, index) => ({ taskId: 't' + index, attemptId: 'a' + index, status }));
  outcomes[2] = { ...outcomes[2]!, delivery: { state: 'exhausted', attempts: 3, nextEligibleAt: 10 } };
  const response = { schemaVersion: 1 as const, layout: resolveProductPaths('/fixture/project', { env: { HOME: '/fixture/home' } }),
    delivery: { schemaVersion: 2 as const, runId: 'r', scopeId: 's', cancellationRequested: true as const, outcomes } };
  const args = ['run', 'cancel', '--scope', 's', '--id', 'r', '--command-id', 'c', '--expected-revision', '1', '--lang', language];
  let text = ''; const context = { env: { NO_COLOR: '1', TERM: 'dumb' }, stdout: { write(value: string) { text += value; } }, async deliverRunCancellation() { return response; } };
  expect(await main(args, context)).toBe(0);
  expect(text).toContain(language === 'en' ? 'termination not confirmed for 3 of 5 attempts' : '5 Attempt içinden 3 tanesinde sonlanma doğrulanmadı');
  for (const item of outcomes) { expect(text).toContain(item.taskId); expect(text).toContain(item.attemptId); }
  expect(text).toContain(language === 'en' ? 'retry limit reached' : 'tekrar sınırına ulaşıldı'); expect(text).not.toContain('Teslim Attempt sayısı');
  expect(text).toContain(language === 'en' ? 'Delivery attempts: 3' : 'Teslim tekrarı: 3');
  expect(text).not.toContain('\u001b');
  text = ''; expect(await main([...args, '--json'], context)).toBe(0); expect(JSON.parse(text)).toEqual(response);
  response.delivery.outcomes = outcomes.slice(0, 2); text = ''; await main(args, context);
  expect(text).not.toContain(language === 'en' ? 'Attention:' : 'Dikkat:');
  response.delivery.outcomes = []; text = ''; await main(args, context);
  expect(text).toContain(language === 'en' ? 'No recorded attempts' : 'kayıtlı Attempt yok');
});
