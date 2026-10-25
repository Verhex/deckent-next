import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminalSessionLabels } from '#surfaces/core/terminal-labels/index.js';
import { bindSessionScope } from '#surfaces/core/terminal-kit/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

// T5 (alpha.54): `/rename <title>` names the open conversation through the session port; the `/resume` picker shows the title and narrows by typed text.
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });
const ENTER = '\r', DOWN = '\u001B[B', BACKSPACE = '\u007F';
const sessions = { ...WORKLINE_TEST_LABELS.sessions!, entry: 'SESSION {index} {session} {preview}', rename: { usage: 'RENAME-USAGE', done: 'RENAME-DONE', nothingSaved: 'RENAME-NOTHING' },
  filter: { prompt: 'FILTER[{text}]', none: 'FILTER-NONE' } };
const labels = { ...WORKLINE_TEST_LABELS, sessions };
const frameOf = (view: ReturnType<typeof mountWorkline>) => view.stdout.frame;
const send = async (view: ReturnType<typeof mountWorkline>, text: string) => { for (const char of text) { view.stdin.write(char); await settle(3); } };
const ready = async (view: ReturnType<typeof mountWorkline>) => { mounted.push(view.instance); await until(() => frameOf(view).includes('READY'), 'ready'); await settle(40); };
const row = (n: number, preview: string, title?: string) => ({ sessionId: `0000000${n}-2222-4333-8444-555555555555`, updatedAtMs: n, messages: 2, preview, ...(title ? { title } : {}) });

describe('/rename', () => {
  it('names the open conversation through the port and says so', async () => {
    const rename = vi.fn(async () => true);
    const view = mountWorkline({ labels, sessions: { async save() { /* unused */ }, async list() { return []; }, async load() { return null; }, rename } });
    await ready(view);
    await send(view, '/rename release notes\r');
    await until(() => frameOf(view).includes('RENAME-DONE'), 'renamed');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename.mock.calls[0]![1]).toBe('release notes');
  });

  it('without a title shows the usage and writes nothing; a conversation that is not saved yet says so', async () => {
    const rename = vi.fn(async () => false);
    const view = mountWorkline({ labels, sessions: { async save() { /* unused */ }, async list() { return []; }, async load() { return null; }, rename } });
    await ready(view);
    await send(view, '/rename\r');
    await until(() => frameOf(view).includes('RENAME-USAGE'), 'usage');
    expect(rename).not.toHaveBeenCalled();
    await send(view, '/rename later\r');
    await until(() => frameOf(view).includes('RENAME-NOTHING'), 'not saved');
  });

  it('is listed in /help and the real catalog carries both languages', () => {
    for (const locale of ['en', 'tr'] as const) {
      const words = terminalSessionLabels(locale);
      expect(words.rename?.usage).toBeTruthy(); expect(words.filter?.prompt).toContain('{text}');
    }
  });

  it('bindSessionScope offers rename only when the store can name sessions', async () => {
    const base = { async save() { /* unused */ }, async list() { return []; }, async load() { return null; } };
    expect(bindSessionScope(base, 'scope').rename).toBeUndefined();
    const calls: unknown[] = [];
    const port = bindSessionScope({ ...base, async rename(scope: string, id: string, title: string) { calls.push([scope, id, title]); return true; } }, 'scope');
    expect(await port.rename!('id', 'name')).toBe(true); expect(calls).toEqual([['scope', 'id', 'name']]);
  });
});

describe('/resume picker', () => {
  it('U7 can widen an empty current-folder list and load a session from all folders', async () => {
    const list = vi.fn(async (all?: boolean) => all ? [row(2, 'another folder')] : []);
    const load = vi.fn(async () => [{ role: 'user' as const, content: 'q' }]);
    const view = mountWorkline({ labels: { ...labels, sessions: { ...sessions, folders: { all: 'ALL-FOLDERS', current: 'THIS-FOLDER' } } },
      sessions: { async save() { /* unused */ }, list, load } });
    await ready(view); await send(view, '/resume\r');
    await until(() => frameOf(view).includes('ALL-FOLDERS'), 'widen choice');
    view.stdin.write(ENTER);
    await until(() => frameOf(view).includes('another folder') && frameOf(view).includes('THIS-FOLDER'), 'all folders');
    view.stdin.write(DOWN); await settle(30); view.stdin.write(ENTER);
    await until(() => frameOf(view).includes('ALL-FOLDERS') && !frameOf(view).includes('another folder'), 'current folder again');
    view.stdin.write(ENTER);
    await until(() => frameOf(view).includes('another folder'), 'all folders again');
    view.stdin.write(ENTER);
    await until(() => load.mock.calls.length === 1, 'resumed');
    expect(list.mock.calls.map(call => call[0])).toEqual([false, true, false, true, true]);
    expect(load.mock.calls[0]![0]).toBe(row(2, '').sessionId);
  });
  const list = [row(1, 'alpha question'), row(2, 'beta question', 'My Release Notes'), row(3, 'gamma question')];
  const port = (load = vi.fn(async () => [{ role: 'user' as const, content: 'q' }])) => ({ async save() { /* unused */ }, async list() { return list; }, load });

  it('shows the title in place of the first message', async () => {
    const view = mountWorkline({ labels, sessions: port() });
    await ready(view);
    await send(view, '/resume\r');
    await until(() => frameOf(view).includes('SESSION 2 00000002 My Release Notes'), 'picker');
    expect(frameOf(view)).not.toContain('beta question');
  });

  it('typing narrows the list, Enter loads the ORIGINAL row, Backspace widens it, no match says so and Enter does nothing', async () => {
    const load = vi.fn(async () => [{ role: 'user' as const, content: 'q' }]);
    const view = mountWorkline({ labels, sessions: port(load) });
    await ready(view);
    await send(view, '/resume\r');
    await until(() => frameOf(view).includes('FILTER[]') && frameOf(view).includes('SESSION 3'), 'picker');
    await send(view, 'GAMMA');
    await until(() => frameOf(view).includes('FILTER[GAMMA]') && !frameOf(view).includes('SESSION 1'), 'narrowed');
    expect(frameOf(view)).toContain('SESSION 3');
    await send(view, 'zz');
    await until(() => frameOf(view).includes('FILTER-NONE'), 'no match');
    view.stdin.write(ENTER); await settle(40);
    expect(load).not.toHaveBeenCalled();
    for (let i = 0; i < 4; i++) { view.stdin.write(BACKSPACE); await settle(10); }
    await until(() => frameOf(view).includes('FILTER[GAM]') && frameOf(view).includes('SESSION 3'), 'widened');
    for (let i = 0; i < 3; i++) { view.stdin.write(BACKSPACE); await settle(10); }
    await until(() => frameOf(view).includes('SESSION 1') && frameOf(view).includes('SESSION 3'), 'all back');
    await send(view, 'release');
    await until(() => !frameOf(view).includes('SESSION 1'), 'title match only');
    view.stdin.write(ENTER);
    await until(() => load.mock.calls.length === 1, 'loaded');
    expect((load.mock.calls[0] as unknown as [string])[0]).toBe(list[1]!.sessionId);
  });

  it('Down then Enter still picks the second visible row of an unfiltered list', async () => {
    const load = vi.fn(async () => [{ role: 'user' as const, content: 'q' }]);
    const view = mountWorkline({ labels, sessions: port(load) });
    await ready(view);
    await send(view, '/resume\r');
    await until(() => frameOf(view).includes('SESSION 2'), 'picker');
    view.stdin.write(DOWN); await settle(30); view.stdin.write(ENTER);
    await until(() => load.mock.calls.length === 1, 'loaded');
    expect((load.mock.calls[0] as unknown as [string])[0]).toBe(list[1]!.sessionId);
  });
});
