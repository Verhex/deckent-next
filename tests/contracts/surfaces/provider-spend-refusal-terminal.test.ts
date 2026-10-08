import { afterEach, expect, it } from 'vitest';
import { ProviderSpendError } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { WORKLINE_TEST_LABELS, mountWorkline, until } from '../support/workline-harness.js';
const views: ReturnType<typeof mountWorkline>[] = [];
afterEach(() => { for (const view of views.splice(0)) view.instance.unmount(); });
it.each([
  ['PROVIDER_SPEND_EXHAUSTED', 'models.revise-budget', 'models revise-budget'],
  ['PROVIDER_SPEND_FROZEN', 'models.reconcile-spending', 'models reconcile-spending'],
  ['PROVIDER_SPEND_TARIFF_UNVERIFIED', 'config.write-tariff', 'v2'],
] as const)('shows %s through the existing system line, returns ready and accepts another turn', async (code, action, text) => {
  const refusal = queryFailure(new ProviderSpendError(code));
  expect(refusal).toMatchObject({ code, params: { nextAction: action } });
  let calls = 0;
  const view = mountWorkline({ labels: WORKLINE_TEST_LABELS, completeTurn: async () => { calls++; throw refusal; },
    errorText: error => ErrorRegistry.get((error as typeof refusal).code, 'tr', (error as typeof refusal).params ?? {})!.message });
  views.push(view); await until(() => view.stdout.frame.includes('READY'), 'ready');
  view.stdin.write('hello\r'); await until(() => calls === 1 && view.stdout.text.includes(text) && view.stdout.frame.includes('READY'), 'visible refusal and ready');
  view.stdin.write('again\r'); await until(() => calls === 2 && view.stdout.frame.includes('READY'), 'retry after refusal');
  expect(view.stdout.text).toContain(text);
});
