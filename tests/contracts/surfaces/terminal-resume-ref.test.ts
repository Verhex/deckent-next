import { createElement } from 'react';
import { render, Text } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useConversationSession, type ConversationSessionSummary } from '#surfaces/core/terminal/index.js';
import { terminalSessionLabels } from '#surfaces/core/terminal-labels/index.js';
import { mountWorkline, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

const first = { sessionId: 'aaaaaaaa-1111-4111-8111-111111111111', updatedAtMs: 10, messages: 1, preview: 'first' };
const second = { ...first, sessionId: 'aaaaaaaa-2222-4222-8222-222222222222', preview: 'second' };
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });

function open(locale: 'en' | 'tr' = 'en') {
  let summaries: readonly ConversationSessionSummary[] = [first, second];
  const messages = [{ role: 'user' as const, content: 'saved' }];
  const port = { save: vi.fn(async () => {}), list: vi.fn(async () => summaries), load: vi.fn(async () => messages) };
  const history = { current: [{ role: 'system' as const, content: 'system' }, { role: 'user' as const, content: 'current' }] };
  let session!: ReturnType<typeof useConversationSession>;
  const labels = terminalSessionLabels(locale);
  function App() { session = useConversationSession(port, labels); return createElement(Text, null, 'hook'); }
  mounted.push(render(createElement(App), { debug: true, patchConsole: false }));
  return { port, history, labels, session: () => session, change: (next: readonly ConversationSessionSummary[]) => { summaries = next; },
    run: (arg: string) => session.run('resume', arg, history) };
}

describe('TC-0 exact resume references', () => {
  it.each(['aaaaaaaa', 'aaaaaaaa-1', '../escape', 'AAAAAAAA-1111-4111-8111-111111111111'])('refuses %s without loading or changing context', async ref => {
    const view = open(), before = view.history.current, id = view.session().id();
    const result = await view.run(ref);
    expect(result).toMatchObject({ refusal: 'SESSION_REFERENCE_EXACT_REQUIRED' });
    expect(view.port.load).not.toHaveBeenCalled(); expect(view.history.current).toBe(before); expect(view.session().id()).toBe(id);
  });
  it('accepts an exact id even without a cached list', async () => {
    const view = open(); await view.run(first.sessionId);
    expect(view.port.load).toHaveBeenCalledExactlyOnceWith(first.sessionId);
    expect(view.history.current.map(row => row.content)).toEqual(['system', 'saved']);
  });
  it('accepts only an index from the list shown, rechecking freshness', async () => {
    const view = open(); await view.run(''); await view.run('2');
    expect(view.port.load).toHaveBeenCalledExactlyOnceWith(second.sessionId);
    expect(view.port.list).toHaveBeenCalledTimes(2);
  });
  it.each(['1', '0', '9', '01', '9007199254740992'])('refuses unshown/invalid index %s', async ref => {
    const view = open(); const result = await view.run(ref);
    expect(result).toMatchObject({ refusal: 'SESSION_LIST_STALE' }); expect(view.port.load).not.toHaveBeenCalled();
  });
  it.each(['reordered', 'deleted', 'updated'] as const)('refuses a %s list, clears it and requires showing it again', async change => {
    const view = open(); await view.run(''); const before = view.history.current, id = view.session().id();
    view.change(change === 'reordered' ? [second, first] : change === 'deleted' ? [second] : [{ ...first, updatedAtMs: 11 }, second]);
    const result = await view.run('1');
    expect(result).toMatchObject({ refusal: 'SESSION_LIST_STALE' }); expect(view.port.load).not.toHaveBeenCalled();
    expect(view.history.current).toBe(before); expect(view.session().id()).toBe(id);
    await view.run('1'); expect(view.port.load).not.toHaveBeenCalled();
    await view.run(''); await view.run('1'); expect(view.port.load).toHaveBeenCalledTimes(1);
  });
  it('invalidates shown indices when starting a new conversation', async () => {
    const view = open(); await view.run(''); await view.session().run('clear', '', view.history);
    expect(await view.run('1')).toMatchObject({ refusal: 'SESSION_LIST_STALE' }); expect(view.port.load).not.toHaveBeenCalled();
  });
  it('invalidates indices after saving, and reports a missing exact id without replacing history', async () => {
    const view = open(); await view.run(''); await view.session().save(view.history.current);
    expect(await view.run('1')).toMatchObject({ refusal: 'SESSION_LIST_STALE' }); expect(view.port.load).not.toHaveBeenCalled();
    view.port.load.mockResolvedValueOnce(null as never); const before = view.history.current;
    expect(await view.run(first.sessionId)).toMatchObject({ refusal: 'SESSION_NOT_FOUND' }); expect(view.history.current).toBe(before);
  });
  it('rechecks the displayed picker before Enter, refusing a changed snapshot', async () => {
    let summaries = [first, second]; const load = vi.fn(async () => null), labels = terminalSessionLabels('tr');
    const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, sessions: labels },
      sessions: { async save() {}, async list() { return summaries; }, load } });
    mounted.push(view.instance); await until(() => view.stdout.text.includes('READY'), 'ready');
    view.stdin.write('/resume\r'); await until(() => view.stdout.text.includes('aaaaaaaa'), 'picker');
    await view.instance.waitUntilRenderFlush(); summaries = [second, first]; view.stdin.write('\r');
    await until(() => view.stdout.text.includes(labels.listStale!), 'picker refusal'); expect(load).not.toHaveBeenCalled();
  });
  it.each(['en', 'tr'] as const)('shows the catalog refusal on the real workline (%s)', async locale => {
    const labels = terminalSessionLabels(locale), load = vi.fn(async () => null);
    const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, sessions: labels },
      sessions: { async save() {}, async list() { return [first, second]; }, load } });
    mounted.push(view.instance); await until(() => view.stdout.text.includes('READY'), 'ready');
    view.stdin.write('/resume aaaaaaaa\r');
    await until(() => view.stdout.text.includes(labels.exactRequired!), 'exact refusal');
    view.stdin.write('/resume 1\r'); await until(() => view.stdout.text.includes(labels.listStale!), 'list refusal');
    expect(load).not.toHaveBeenCalled();
  });
});
