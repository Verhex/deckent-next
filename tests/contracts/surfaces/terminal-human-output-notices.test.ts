import { afterEach, describe, expect, it } from 'vitest';
import { ErrorRegistry, type Locale } from '#platform/index.js';
import { terminalAdminPorts } from '#surfaces/core/terminal-admin/index.js';
import { EMPTY_SESSION_USAGE } from '#surfaces/core/terminal-kit/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { WORKLINE_TEST_LABELS, mountWorkline, settle, until } from '../support/workline-harness.js';

// TUI2 L3: notices start with Info / Warning / Error in words (not colour alone) and an error shows its human message first, the code second.
const views: Array<ReturnType<typeof mountWorkline>> = [];
afterEach(() => { for (const view of views.splice(0)) view.instance.unmount(); });
async function open(locale: Locale, props: Record<string, unknown> = {}) {
  const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, work: workSurfaceLabels(locale) }, ...props } as never);
  views.push(view);
  await until(() => view.stdout.frame.includes('READY'), 'ready');
  return view;
}
const type = async (view: ReturnType<typeof mountWorkline>, text: string) => { for (const char of text) { view.stdin.write(char); await settle(2); } };

describe.each([['en', 'Info: ', 'Warning: ', 'Error: ', '(code: POLICY_DENIED)'], ['tr', 'Bilgi: ', 'Uyarı: ', 'Hata: ', '(kod: POLICY_DENIED)']] as const)('notices (%s)', (locale, info, warning, error, code) => {
  it('prefixes every level in words', async () => {
    const view = await open(locale, { openingNotices: [{ level: 'info', text: 'INFO-BODY' }, { level: 'warning', text: 'WARN-BODY' }, { level: 'error', text: 'ERR-BODY' }] });
    await until(() => view.stdout.text.includes('ERR-BODY'), 'notices');
    for (const line of [`${info}INFO-BODY`, `${warning}WARN-BODY`, `${error}ERR-BODY`]) expect(view.stdout.text).toContain(line);
    await type(view, '/nosuch \r');
    await until(() => view.stdout.text.includes('UNKNOWN: /nosuch'), 'unknown command');
    expect(view.stdout.text).toContain(`${error}UNKNOWN: /nosuch`);
  });
  it('shows the human message first and the code on its own second line', async () => {
    const typed = ErrorRegistry.createError('POLICY_DENIED' as never);
    const { inspect } = terminalAdminPorts({ root: '/unused', scopeId: 's', installationId: 'i', projectId: 'p', options: {}, locale, status: async () => '', doctor: async () => undefined,
      context: { inspectModelCatalog: async () => { throw typed; } } });
    const lines = (await inspect.model!('', { usage: EMPTY_SESSION_USAGE })).join('\n').split('\n');
    const at = lines.findIndex(line => line.includes(code));
    expect(at).toBeGreaterThan(0); expect(lines[at]).toBe(code); expect(lines[at - 1]).not.toContain('POLICY_DENIED');
  });
});
