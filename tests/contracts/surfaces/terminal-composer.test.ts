import { PassThrough, Writable } from 'node:stream';
import { createElement } from 'react';
import { render, type Key } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { COMPOSER_LIMITS, Composer, EMPTY_COMPOSER, WorklinePaletteProvider, caretRow, composerKey, composerMenu, displayWidth, exitArmed,
  layoutRows, mentionAt, pendingArgument, reduceComposer, resolveWorklinePalette, searchMatches,
  type ComposerContext, type ComposerHistoryEntry, type ComposerKey, type ComposerLabels, type ComposerProps, type ComposerState } from '#surfaces/core/terminal/index.js';

const FAMILY = '👨‍👩‍👧';
const FLAG = '🇹🇷';
const context = (over: Partial<ComposerContext> = {}): ComposerContext => ({ now: 0, busy: false, pasteChip: '[Pasted {lines} lines]', ...over });
const text = (value: string): ComposerKey => ({ type: 'text', text: value });
const typed = (value: string): ComposerKey[] => [...value].map(text);
const K = {
  submit: { type: 'submit' }, newline: { type: 'newline' }, tab: { type: 'tab' }, esc: { type: 'escape' }, ctrlC: { type: 'interrupt' },
  ctrlD: { type: 'eof' }, ctrlR: { type: 'search' }, yank: { type: 'yank' }, tick: { type: 'tick' },
  left: { type: 'move', to: 'left' }, right: { type: 'move', to: 'right' }, up: { type: 'move', to: 'up' }, down: { type: 'move', to: 'down' },
  home: { type: 'move', to: 'home' }, end: { type: 'move', to: 'end' }, wordLeft: { type: 'move', to: 'wordLeft' }, wordRight: { type: 'move', to: 'wordRight' },
  back: { type: 'delete', span: 'back' }, del: { type: 'delete', span: 'forward' }, wordBack: { type: 'delete', span: 'wordBack' },
  ctrlW: { type: 'delete', span: 'spaceWordBack' }, ctrlU: { type: 'delete', span: 'toStart' }, ctrlK: { type: 'delete', span: 'toEnd' },
} satisfies Record<string, ComposerKey>;

function run(keys: readonly ComposerKey[], state: ComposerState = EMPTY_COMPOSER, ctx: ComposerContext = context()) {
  const intents: unknown[] = [];
  for (const key of keys) {
    const step = reduceComposer(state, key, ctx);
    state = step.state;
    intents.push(...step.intents);
  }
  return { state, intents };
}
const draft = (value: string, cursor = value.length): ComposerState => ({ ...EMPTY_COMPOSER, text: value, cursor });
const submitted = (intents: readonly unknown[]) => intents.flatMap(intent => ((intent as { type: string }).type === 'submit' ? [(intent as { text: string }).text] : []));

describe('composer text geometry', () => {
  it('measures clusters in terminal cells: wide, emoji, flags, combining marks and Turkish letters', () => {
    expect(displayWidth('世界')).toBe(4);
    expect(displayWidth(FAMILY)).toBe(2);
    expect(displayWidth(FLAG)).toBe(2);
    expect(displayWidth('e\u0301')).toBe(1);
    expect(displayWidth('ğüşıöçİ')).toBe(7);
  });

  it('wraps by cells without splitting a wide cluster and places the caret row', () => {
    const rows = layoutRows('世界世界世', 5);
    expect(rows.map(row => row.text)).toEqual(['世界', '世界', '世']);
    expect(caretRow(rows, 1)).toBe(0);
    expect(caretRow(rows, 2)).toBe(1);
    expect(layoutRows('ab\ncd', 10).map(row => [row.text, row.start])).toEqual([['ab', 0], ['cd', 3]]);
  });
});

describe('composer line editing', () => {
  it('moves and deletes whole grapheme clusters', () => {
    const value = `a${FAMILY}${FLAG}e\u0301`;
    let { state } = run([text(value)]);
    expect(state.cursor).toBe(value.length);
    state = run([K.left], state).state;
    expect(state.cursor).toBe(value.length - 2);
    state = run([K.left], state).state;
    expect(state.cursor).toBe(1 + FAMILY.length);
    state = run([K.back], state).state;
    expect(state.text).toBe(`a${FLAG}e\u0301`);
    expect(state.cursor).toBe(1);
    state = run([K.del], state).state;
    expect(state.text).toBe('ae\u0301');
  });

  it('inserts at the caret, jumps words (Turkish letters are word characters) and keeps Home/End line-local', () => {
    let { state } = run([text('İstanbul ğüşıöç yolu'), K.wordLeft, K.wordLeft]);
    expect(state.cursor).toBe('İstanbul '.length);
    state = run([K.wordRight, ...typed('!')], state).state;
    expect(state.text).toBe('İstanbul ğüşıöç! yolu');
    state = run([K.home], draft('ab\ncd\nef', 4)).state;
    expect(state.cursor).toBe(3);
    expect(run([K.end], draft('ab\ncd\nef', 4)).state.cursor).toBe(5);
  });

  it('kills words and line parts into the kill buffer and yanks them back', () => {
    let { state } = run([K.ctrlW], draft('run path/to-file'));
    expect(state.text).toBe('run ');
    expect(state.killed).toBe('path/to-file');
    state = run([K.yank], state).state;
    expect(state.text).toBe('run path/to-file');
    expect(run([K.wordBack], draft('run path/to-file')).state.text).toBe('run path/to-');
    state = run([K.ctrlU], draft('one\ntwo three', 'one\ntwo'.length)).state;
    expect(state.text).toBe('one\n three');
    state = run([K.ctrlK], draft('one\ntwo three', 'one\ntwo'.length)).state;
    expect([state.text, state.killed]).toEqual(['one\ntwo', ' three']);
    expect(run([K.ctrlK], draft('ab\ncd', 2)).state.text).toBe('abcd');
  });
});

describe('composer multiline, history and search', () => {
  it('inserts newlines, submits the whole draft and continues a trailing backslash', () => {
    const { state, intents } = run([...typed('one'), K.newline, ...typed('two'), K.submit]);
    expect(submitted(intents)).toEqual(['one\ntwo']);
    expect(state.text).toBe('');
    const continued = run([...typed('first\\'), K.submit]);
    expect(continued.intents).toEqual([]);
    expect(continued.state.text).toBe('first\n');
    expect(run([...typed('  '), K.newline, K.submit]).intents).toEqual([]);
  });

  it('moves between draft lines by cell column and walks history only at the edges, preserving the draft', () => {
    let { state } = run([...typed('first'), K.submit, ...typed('second'), K.submit, ...typed('ab'), K.newline, ...typed('cd')]);
    state = run([K.up], state).state;
    expect([state.text, state.cursor]).toEqual(['ab\ncd', 2]);
    state = run([K.up], state).state;
    expect(state.text).toBe('second');
    state = run([K.up, K.up], state).state;
    expect(state.text).toBe('first');
    state = run([K.down], state).state;
    expect(state.text).toBe('second');
    state = run([K.down], state).state;
    expect([state.text, state.browsing]).toEqual(['ab\ncd', null]);
    expect(run([K.up], draft(`a${FAMILY}b\ncd`, `a${FAMILY}b\nc`.length)).state.cursor).toBe(1);
  });

  it('skips consecutive duplicates and bounds in-session history', () => {
    let { state } = run([...typed('same'), K.submit, ...typed('same'), K.submit]);
    expect(state.history.map(entry => entry.text)).toEqual(['same']);
    state = run([{ type: 'history', entries: Array.from({ length: 600 }, (_, index) => ({ text: `h${index}`, pastes: [] })) }], state).state;
    expect(state.history).toHaveLength(COMPOSER_LIMITS.historyEntries);
    expect(state.history.at(-1)!.text).toBe('same');
  });

  it('Ctrl+R searches newest first, accent-insensitively; Enter takes the match without submitting and Esc restores', () => {
    const history: ComposerHistoryEntry[] = ['deploy staging', 'ağaç status', 'deploy prod'].map(value => ({ text: value, pastes: [] }));
    let { state } = run([{ type: 'history', entries: history }, ...typed('draft'), K.ctrlR, ...typed('dep')]);
    expect(searchMatches(state)[state.search!.skip]!.text).toBe('deploy prod');
    state = run([K.ctrlR], state).state;
    expect(searchMatches(state)[state.search!.skip]!.text).toBe('deploy staging');
    const taken = run([K.submit], state);
    expect([taken.state.text, taken.state.search, taken.intents]).toEqual(['deploy staging', null, []]);
    expect(run([K.esc], state).state.text).toBe('draft');
    const folded = run([K.ctrlR, ...typed('agac')], run([{ type: 'history', entries: history }]).state).state;
    expect(searchMatches(folded)[0]!.text).toBe('ağaç status');
  });
});

describe('composer paste and chunked input', () => {
  const body = 'l1\nl2\nl3\nl4\nl5';
  it('collapses a large paste into a chip, expands it on submit and keeps it atomic while editing', () => {
    let { state } = run([...typed('see'), { type: 'paste', text: `${body}\n` }]);
    expect(state.text).toBe('see [Pasted 5 lines]');
    state = run([K.left], state).state;
    expect(state.cursor).toBe(4);
    state = run([K.end, { type: 'paste', text: body }], state).state;
    expect(state.text).toBe('see [Pasted 5 lines] [Pasted 5 lines] (#2)');
    state = run([K.back], state).state;
    expect(state.text).toBe('see [Pasted 5 lines] ');
    const { intents, state: after } = run([...typed('ok'), K.submit], state);
    expect(submitted(intents)).toEqual([`see ${body} ok`]);
    expect(after.history.at(-1)).toEqual({ text: 'see [Pasted 5 lines] ok', pastes: [{ chip: '[Pasted 5 lines]', body }] });
  });

  it('keeps a small paste inline, strips control bytes and never submits a paste by itself', () => {
    const inline = run([{ type: 'paste', text: 'a\r\nb\u001b[2J\n' }]);
    expect([inline.state.text, inline.intents]).toEqual(['a\nb[2J', []]);
    expect(run([{ type: 'paste', text: 'x'.repeat(600) }]).state.text).toBe('[Pasted 1 lines]');
  });

  it('submits one line plus a trailing Enter in one chunk; a multi-line chunk is a paste', () => {
    expect(submitted(run([text('hello there, one chunk\r')]).intents)).toEqual(['hello there, one chunk']);
    const pasted = run([text('first line\nsecond line\r')]);
    expect([pasted.state.text, pasted.intents]).toEqual(['first line\nsecond line', []]);
    expect(submitted(run([K.submit], pasted.state).intents)).toEqual(['first line\nsecond line']);
  });

  it('restores a Ctrl+C-cleared chip with its body through Ctrl+Y', () => {
    const { state } = run([{ type: 'paste', text: body }, K.ctrlC, K.yank, K.submit]);
    expect(state.text).toBe('');
    expect(submitted(run([{ type: 'paste', text: body }, K.ctrlC, K.yank, K.submit]).intents)).toEqual([body]);
  });
});

describe('composer completion, shortcuts panel and mentions', () => {
  it('opens the slash popup on a bare prefix; arrows select, Tab completes, Enter submits what was typed', () => {
    let { state } = run(typed('/wa'));
    expect(composerMenu(state)!.items.map(command => command.name)).toEqual(['watch-workers', 'watch-runs', 'watch-stop']);
    state = run([K.down, K.tab], state).state;
    expect(state.text).toBe('/watch-runs ');
    expect(composerMenu(state)).toBeNull();
    expect(submitted(run([...typed('/ru'), K.submit]).intents)).toEqual(['/ru']);
    expect(pendingArgument(run([...typed('/ru'), K.tab]).state.text)?.name).toBe('run');
    const dismissed = run([...typed('/wa'), K.esc]).state;
    expect(composerMenu(dismissed)).toBeNull();
    expect(composerMenu(run(typed('tch-w'), dismissed).state)!.items.map(command => command.name)).toEqual(['watch-workers']);
  });

  it('toggles the shortcuts panel with ? only on an empty draft', () => {
    let { state } = run(typed('?'));
    expect([state.shortcuts, state.text]).toEqual([true, '']);
    state = run(typed('?'), state).state;
    expect(state.shortcuts).toBe(false);
    expect(run(typed('why?')).state.text).toBe('why?');
    const closedByTyping = run([...typed('?'), ...typed('x')]).state;
    expect([closedByTyping.shortcuts, closedByTyping.text]).toEqual([false, 'x']);
  });

  it('detects @mention tokens and completes from port results for the same token only', () => {
    expect(mentionAt('see @src/ma', 11)).toEqual({ start: 4, query: 'src/ma' });
    expect(mentionAt('mail a@b.c', 10)).toBeNull();
    expect(mentionAt('@@literal', 9)).toBeNull();
    const { state, intents } = run([...typed('see @sr'), K.tab]);
    expect(intents).toEqual([{ type: 'mention', start: 4, query: 'sr' }]);
    expect(run([{ type: 'mentions', start: 4, query: 'sr', items: ['src/a.ts'] }], state).state.text).toBe('see @src/a.ts ');
    const menu = run([{ type: 'mentions', start: 4, query: 'sr', items: ['src/a.ts', 'src/b.ts'] }, K.down, K.tab], state).state;
    expect(menu.text).toBe('see @src/b.ts ');
    expect(run([...typed('c'), { type: 'mentions', start: 4, query: 'sr', items: ['src/a.ts'] }], state).state.text).toBe('see @src');
  });
});

describe('composer exit and interrupt policy (injected clock)', () => {
  it('clears a draft first, arms exit on an empty draft and exits on a second Ctrl+C inside the window', () => {
    const cleared = run([...typed('draft'), K.ctrlC]);
    expect([cleared.state.text, cleared.state.armedAt, cleared.intents]).toEqual(['', null, []]);
    const armed = run([K.ctrlC], cleared.state, context({ now: 1_000 }));
    expect(armed.intents).toEqual([]);
    expect(exitArmed(armed.state, 2_500)).toBe(true);
    expect(run([K.ctrlC], armed.state, context({ now: 1_000 + COMPOSER_LIMITS.exitWindowMs })).intents).toEqual([{ type: 'exit' }]);
    const late = run([K.ctrlC], armed.state, context({ now: 1_001 + COMPOSER_LIMITS.exitWindowMs }));
    expect([late.intents, late.state.armedAt]).toEqual([[], 1_001 + COMPOSER_LIMITS.exitWindowMs]);
    expect(run([K.tick], armed.state, context({ now: 5_000 })).state.armedAt).toBeNull();
  });

  it('while busy, Ctrl+C and Esc cancel the turn without arming; Esc closes an open popup first', () => {
    const busy = context({ busy: true });
    expect(run([...typed('queued'), K.ctrlC], EMPTY_COMPOSER, busy)).toMatchObject({ intents: [{ type: 'cancel' }], state: { text: 'queued', armedAt: null } });
    expect(run([K.esc], EMPTY_COMPOSER, busy).intents).toEqual([{ type: 'cancel' }]);
    expect(run([...typed('/he'), K.esc], EMPTY_COMPOSER, busy).intents).toEqual([]);
  });

  it('Ctrl+D exits on an empty idle draft, deletes forward otherwise and does nothing while busy', () => {
    expect(run([K.ctrlD]).intents).toEqual([{ type: 'exit' }]);
    expect(run([K.ctrlD], draft('ab', 0)).state.text).toBe('b');
    expect(run([K.ctrlD], EMPTY_COMPOSER, context({ busy: true })).intents).toEqual([]);
  });
});

describe('composer key mapping (Ink key events)', () => {
  const none: Key = { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false,
    return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false,
    capsLock: false, numLock: false } as Key;
  const key = (over: Partial<Key>): Key => ({ ...none, ...over });
  it('maps readline bindings, modified Enter and modified arrows', () => {
    expect(composerKey('', key({ return: true }))).toEqual({ type: 'submit' });
    expect(composerKey('', key({ return: true, meta: true }))).toEqual({ type: 'newline' });
    expect(composerKey('', key({ return: true, shift: true }))).toEqual({ type: 'newline' });
    expect(composerKey('\n', none)).toEqual({ type: 'newline' });
    expect(composerKey('w', key({ ctrl: true }))).toEqual({ type: 'delete', span: 'spaceWordBack' });
    expect(composerKey('', key({ backspace: true, meta: true }))).toEqual({ type: 'delete', span: 'wordBack' });
    expect(composerKey('', key({ leftArrow: true, ctrl: true }))).toEqual({ type: 'move', to: 'wordLeft' });
    expect(composerKey('b', key({ meta: true }))).toEqual({ type: 'move', to: 'wordLeft' });
    expect(composerKey('', key({ delete: true }))).toEqual({ type: 'delete', span: 'forward' });
    expect(composerKey('r', key({ ctrl: true }))).toEqual({ type: 'search' });
    expect(composerKey('x', key({ ctrl: true }))).toBeNull();
    expect(composerKey('ğ', none)).toEqual({ type: 'text', text: 'ğ' });
  });
});

const labels: ComposerLabels = { pasteChip: '[PASTE {lines}]', search: 'SEARCH', exitArmed: 'EXIT-ARMED', shortcuts: 'KEYS\nENTER-SENDS',
  slash: { 'terminal.slash.watchRuns': 'WATCH-RUNS-DESC', 'terminal.slash.run': 'RUN-DESC', 'terminal.slash.runArgument': '<RUN-ID>' } };
class Screen extends Writable {
  text = '';
  readonly isTTY = true; readonly rows = 60;
  constructor(readonly columns = 120) { super(); }
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.text += chunk.toString('utf8'); done(); }
}
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await settle(10); }
  throw new Error(`timed out waiting for ${label}`);
}
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });

function mount(props: Partial<ComposerProps> = {}, columns = 120) {
  const stdout = new Screen(columns);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const sent: string[] = [], calls = { exit: 0, cancel: 0 };
  const instance = render(createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'), children: createElement(Composer, {
    prompt: '> ', labels, busy: false, onSubmit: value => sent.push(value), onCancel: () => calls.cancel++, onExit: () => calls.exit++, ...props,
  }) }), { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  mounted.push(instance);
  const keys = async (...chunks: string[]) => { for (const chunk of chunks) { stdin.write(chunk); await settle(4); } };
  return { stdout, sent, calls, keys, type: (value: string) => keys(...value) };
}

describe('composer rendered by Ink (no colour tier)', () => {
  it('shows a visible caret marker that follows arrows, Home/End and word jumps', async () => {
    const view = mount();
    await view.type('hello world');
    await view.keys('\u001b[D', '\u001b[D');
    await until(() => view.stdout.text.includes('> hello wor|ld'), 'caret after left arrows');
    await view.keys('\u001b[1;5D');
    await until(() => view.stdout.text.includes('> hello |world'), 'ctrl+left word jump');
    await view.keys('\u001b[H', 'X', '\u001b[F', '\u007f', '\u001b[3~');
    await until(() => view.stdout.text.includes('> Xhello worl|'), 'home insert, end backspace');
  });

  it('builds a multiline draft with Alt+Enter and Ctrl+J and submits it as one message', async () => {
    const view = mount();
    await view.type('one');
    await view.keys('\u001b\r');
    await view.type('two');
    await view.keys('\n');
    await view.type('three');
    await until(() => view.stdout.text.includes('  three|'), 'indented continuation row');
    await view.keys('\r');
    await until(() => view.sent.length === 1, 'submit');
    expect(view.sent[0]).toBe('one\ntwo\nthree');
  });

  it('collapses a bracketed paste into a chip and sends the full text on Enter', async () => {
    const view = mount();
    await view.keys('\u001b[200~l1\nl2\nl3\nl4\u001b[201~');
    await until(() => view.stdout.text.includes('[PASTE 4]'), 'chip');
    await view.keys('\r');
    await until(() => view.sent.length === 1, 'submit');
    expect(view.sent[0]).toBe('l1\nl2\nl3\nl4');
  });

  it('lists slash commands with descriptions and argument hints, and Tab completes the selection', async () => {
    const view = mount();
    await view.type('/ru');
    await until(() => view.stdout.text.includes('> /run <RUN-ID>') && view.stdout.text.includes('RUN-DESC'), 'popup with argument hint');
    await view.keys('\t');
    await until(() => view.stdout.text.includes('> /run |<RUN-ID>'), 'completed with argument hint');
    await view.type('r-1\r');
    await until(() => view.sent.length === 1, 'submit');
    expect(view.sent[0]).toBe('/run r-1');
  });

  it('recalls history with Up, searches with Ctrl+R and wires the history port', async () => {
    const appended: ComposerHistoryEntry[] = [];
    const view = mount({ history: { load: async () => [{ text: 'from disk', pastes: [] }], append: entry => { appended.push(entry); } } });
    await settle(20);
    await view.type('fresh\r');
    await until(() => appended.length === 1, 'append');
    await view.keys('\u001b[A', '\u001b[A');
    await until(() => view.stdout.text.includes('> from disk|'), 'loaded history recalled');
    await view.keys('\u001b[B', '\u001b[B', '\u0012');
    await view.type('dis');
    await until(() => view.stdout.text.includes("SEARCH 'dis': from disk"), 'reverse search line');
    await view.keys('\r', '\r');
    await until(() => view.sent.length === 2, 'taken match submitted by the next Enter');
    expect(view.sent).toEqual(['fresh', 'from disk']);
  });

  it('toggles the shortcuts panel, arms exit on Ctrl+C and exits on Ctrl+D', async () => {
    const view = mount();
    await view.type('?');
    await until(() => view.stdout.text.includes('ENTER-SENDS'), 'shortcuts panel');
    await view.keys('\u0003', '\u0003');
    await until(() => view.stdout.text.includes('EXIT-ARMED'), 'armed notice');
    expect(view.calls.exit).toBe(0);
    await view.keys('\u0004');
    await until(() => view.calls.exit === 1, 'ctrl+d exits');
  });

  it('completes an @mention through the port and cancels a busy turn with Esc', async () => {
    const queries: string[] = [];
    const view = mount({ busy: true, mentions: async query => { queries.push(query); return ['src/app.ts']; } });
    await view.type('open @sr');
    await view.keys('\t');
    await until(() => view.stdout.text.includes('> open @src/app.ts |'), 'mention completed');
    expect(queries).toEqual(['sr']);
    await view.keys('\u001b');
    await until(() => view.calls.cancel === 1, 'esc cancels while busy');
  });

  it('wraps a long draft of wide characters inside a narrow terminal', async () => {
    const view = mount({}, 16);
    await view.keys('世界世界世界世界');
    // 16 columns - border/padding (4) - prompt (2) - caret reserve (1) = 9 cells: four wide characters per row.
    await until(() => view.stdout.text.includes('│ > 世界世界') && view.stdout.text.includes('│   世界世界|'), 'wrapped wide rows');
  });
});
