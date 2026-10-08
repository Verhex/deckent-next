import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SlashWindowLabels } from '#surfaces/core/terminal/index.js';
import { terminalPanelLabels, pickerLabels } from '#surfaces/core/work-labels/index.js';
import type { PermissionModeView } from '#domain/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

// SLASH-WINDOWS lane SW-3 (owner 2026-10-08): `/clear` really clears, `/reasoning`, `/mode`, `/resume`, `/scratch` and an unknown command open
// windows or pickers, the palette runs a command on Enter, and none of them writes slash output into the chat stream. Without window words
// (TERM=dumb, line mode) the text commands are unchanged.
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });
const ESC = '\u001B', DOWN = '\u001B[B', ENTER = '\r';
const WIN: SlashWindowLabels = { picker: pickerLabels('en'), position: '{from}-{to}/{total}', hints: 'WIN-HINTS', infoHints: 'WIN-INFO-HINTS',
  reasoning: { title: 'RZ-TITLE', thinkingOn: 'RZ-THINK-ON', thinkingOff: 'RZ-THINK-OFF', previewOn: 'RZ-PREVIEW-ON', previewOff: 'RZ-PREVIEW-OFF', current: 'RZ-CURRENT',
    thinkingOnDetail: 'rz-d1', thinkingOffDetail: 'rz-d2', previewOnDetail: 'rz-d3', previewOffDetail: 'rz-d4', statusOn: 'RZ-STATUS-ON', statusOnHidden: 'RZ-STATUS-HIDDEN', statusOff: 'RZ-STATUS-OFF' },
  scratch: { title: 'SC-TITLE', status: 'SC-STATUS {count} {bytes} {limit}', folder: 'SC-FOLDER', more: 'SC-MORE {count}', empty: 'SC-EMPTY', fileDetail: 'SC-BYTES {bytes}',
    clear: 'SC-CLEAR-ROW', clearDetail: 'sc-ask', clearTitle: 'SC-CONFIRM-TITLE', clearBody: 'SC-CONFIRM-BODY {count} {bytes} {path}', clearPrompt: 'SC-CONFIRM-PROMPT', pathTitle: 'SC-PATH-TITLE' },
  unknown: { title: 'UN-TITLE', body: 'UN-BODY {command}', closest: 'UN-CLOSEST', none: 'UN-NONE', all: 'UN-ALL', allDetail: 'un-all-detail' } };
const sessions = { started: 'NEW-SESSION', entry: 'SESSION {index} {session} {count} {preview}', none: 'NO-SESSIONS', notFound: 'NF', unavailable: 'NP', saveFailed: 'SF',
  resumed: 'RESUMED {count} {session}', context: 'CTX', contextNone: 'CTX-NONE {count}' };
const withWindows = { ...WORKLINE_TEST_LABELS, windows: WIN, sessions, composer: { ...WORKLINE_TEST_LABELS.composer, slash: { 'terminal.slash.clear': 'CLEAR-DESC' } } };
const frameOf = (view: ReturnType<typeof mountWorkline>) => view.stdout.frame;
const send = async (view: ReturnType<typeof mountWorkline>, text: string) => { for (const char of text) { view.stdin.write(char); await settle(3); } };
const ready = async (view: ReturnType<typeof mountWorkline>) => { mounted.push(view.instance); await until(() => frameOf(view).includes('READY'), 'ready'); await settle(40); };
function answering(seen: Array<readonly { role: string; content: string }[]>, options: Array<Record<string, unknown> | undefined> = []) {
  return async function* (messages: readonly { role: string; content: string }[], _signal: AbortSignal, turn?: Record<string, unknown>) {
    seen.push(messages); options.push(turn);
    const text = `ANSWER-${seen.length}`;
    yield { kind: 'message' as const, message: { role: 'assistant' as const, content: text, toolCalls: [] } };
    yield { kind: 'text' as const, text }; yield { kind: 'done' as const, finish: 'stop' as const };
  };
}
const earlier = { sessionId: '11111111-2222-4333-8444-555555555555', updatedAtMs: 0, messages: 2, preview: 'old question' };

describe('/clear really clears', () => {
  it('wipes the screen and Ink\'s replay buffer, starts a new conversation and leaves one summary line', async () => {
    const seen: Array<readonly { role: string; content: string }[]> = [];
    const saved: string[] = [];
    const port = { async save(input: { sessionId: string }) { saved.push(input.sessionId); }, async list() { return [earlier]; }, async load() { return null; } };
    const view = mountWorkline({ labels: withWindows, streamTurn: answering(seen) as never, sessions: port });
    await ready(view);
    await send(view, 'first question\r');
    await until(() => frameOf(view).includes('ANSWER-1') && saved.length === 1, 'first answer saved');
    const before = view.stdout.text.length;
    await send(view, '/clear\r');
    await until(() => frameOf(view).includes('NEW-SESSION'), 'summary line');
    // The visible screen was erased (cursor home + ED 2) and the earlier conversation is no longer in the frame Ink would replay.
    expect(view.stdout.text.slice(before)).toContain('\u001b[H\u001b[2J');
    expect(frameOf(view)).not.toContain('first question');
    expect(frameOf(view)).not.toContain('ANSWER-1');
    expect(frameOf(view).match(/NEW-SESSION/gu)).toHaveLength(1);
    await send(view, 'fresh\r');
    await until(() => seen.length === 2, 'second turn');
    expect(seen[1]).toEqual([{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'fresh' }]);
    await until(() => saved.length === 2, 'saved');
    expect(saved[1]).not.toBe(saved[0]);
  });

  it('/exit leaves at once without a window or a line', async () => {
    const view = mountWorkline({ labels: withWindows });
    mounted.push(view.instance);
    await until(() => frameOf(view).includes('READY'), 'ready');
    await settle(40);
    await send(view, '/exit\r');
    await view.instance.waitUntilExit();
    expect(view.stdout.text).not.toContain('UN-TITLE');
  });
});

describe('/reasoning is a window', () => {
  it('opens a picker from the palette, sets the state, shows it in the status strip and writes nothing into the chat', async () => {
    const seen: Array<readonly { role: string; content: string }[]> = [], options: Array<Record<string, unknown> | undefined> = [];
    const view = mountWorkline({ labels: { ...withWindows, reasoning: { on: 'NOTICE-ON', off: 'NOTICE-OFF', usage: 'NOTICE-USAGE' } }, streamTurn: answering(seen, options) as never });
    await ready(view);
    expect(frameOf(view)).toContain('RZ-STATUS-ON');
    await send(view, '/reas\r'); // palette: Enter runs the highlighted command, no argument prompt
    await until(() => frameOf(view).includes('RZ-TITLE') && frameOf(view).includes('RZ-THINK-OFF') && frameOf(view).includes('RZ-PREVIEW-ON'), 'reasoning window');
    expect(frameOf(view)).toContain('RZ-THINK-ON · RZ-CURRENT');
    view.stdin.write(DOWN); await settle(30); view.stdin.write(ENTER);
    await until(() => frameOf(view).includes('RZ-STATUS-OFF') && !frameOf(view).includes('RZ-TITLE'), 'state changed, window closed');
    expect(view.stdout.text).not.toContain('NOTICE-OFF');
    await send(view, 'hello\r');
    await until(() => seen.length === 1, 'turn');
    expect(options[0]).toMatchObject({ reasoning: 'off' });
    // Preview hidden while thinking is on.
    await send(view, '/reasoning\r');
    await until(() => frameOf(view).includes('RZ-TITLE'), 'window again');
    for (let step = 0; step < 1; step++) { view.stdin.write(DOWN); await settle(30); }
    view.stdin.write(ENTER); await until(() => !frameOf(view).includes('RZ-TITLE'), 'closed');
  });

  it('a typed argument is not read in the rich terminal: it still opens the window and Esc changes nothing', async () => {
    const view = mountWorkline({ labels: { ...withWindows, reasoning: { on: 'NOTICE-ON', off: 'NOTICE-OFF', usage: 'NOTICE-USAGE' } } });
    await ready(view);
    await send(view, '/reasoning off\r');
    await until(() => frameOf(view).includes('RZ-TITLE'), 'window');
    view.stdin.write(ESC);
    await until(() => !frameOf(view).includes('RZ-TITLE'), 'closed');
    expect(frameOf(view)).toContain('RZ-STATUS-ON');
    expect(view.stdout.text).not.toContain('NOTICE-');
  });

  it('keeps the typed text command where no window words exist (line-style terminal)', async () => {
    const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, reasoning: { on: 'NOTICE-ON', off: 'NOTICE-OFF', usage: 'NOTICE-USAGE' } } });
    await ready(view);
    await send(view, '/reasoning off\r');
    await until(() => view.stdout.text.includes('NOTICE-OFF'), 'notice');
    expect(frameOf(view)).not.toContain('RZ-TITLE');
  });
});

describe('/mode and /resume open their picker on the first Enter', () => {
  function modePort() {
    const calls: unknown[] = [];
    const view: PermissionModeView = { schemaVersion: 1, scopeId: 'scope', supported: true, mode: 'standart', askEdits: false, revision: 'r0', eligible: true, fullAccess: false, fullAuto: true };
    return { calls, port: { async inspect() { return view; }, async set(mode: string, revision: string) { calls.push([mode, revision]); return { ...view, mode, previous: 'standart', changed: true }; } } };
  }
  it('/mode opens the mode window with its header even when an argument was typed; nothing is set by the argument', async () => {
    const { calls, port } = modePort();
    const view = mountWorkline({ labels: { ...withWindows, mode: { current: 'MODE-TEXT {mode}', changed: 'c', inert: '', unsupported: 'u', usage: 'MODE-USAGE' } },
      permissionMode: port as never, panels: { ports: {}, labels: terminalPanelLabels('en') } });
    await ready(view);
    await send(view, '/mode full-auto\r');
    await until(() => frameOf(view).includes('Permission mode') && frameOf(view).includes('Now:'), 'mode window with header');
    expect(calls).toEqual([]);
    expect(view.stdout.text).not.toContain('MODE-TEXT');
    view.stdin.write(ESC);
    await until(() => !frameOf(view).includes('Permission mode'), 'closed');
  });

  it('/resume lists the earlier conversations in a picker only; a typed reference is ignored; the choice leaves one summary line plus the replayed history', async () => {
    const load = vi.fn(async (id: string) => id === earlier.sessionId ? [{ role: 'user' as const, content: 'old question' }, { role: 'assistant' as const, content: 'old answer', toolCalls: [] }] : null);
    const port = { async save() { /* unused */ }, async list() { return [earlier]; }, load };
    const view = mountWorkline({ labels: withWindows, sessions: port });
    await ready(view);
    await send(view, '/resume 1\r');
    await until(() => frameOf(view).includes('SESSION 1 11111111'), 'picker');
    expect(load).not.toHaveBeenCalled();
    view.stdin.write(ENTER);
    await until(() => frameOf(view).includes('RESUMED 2 11111111'), 'summary line');
    expect(load).toHaveBeenCalledTimes(1);
    expect(frameOf(view)).toContain('old answer'); // conversation content, not slash output
  });
});

describe('/scratch is a list window', () => {
  function scratchPort(files: number) {
    const cleared: string[] = [];
    const view = () => ({ schemaVersion: 1 as const, path: '/tmp/scratch-area', exists: true, bytes: files * 10, truncated: false,
      files: Array.from({ length: files }, (_, index) => ({ path: `/tmp/scratch-area/f${index}.txt`, bytes: 10, modifiedAtMs: 0 })), limits: { writeMaxBytes: 1, sessionMaxBytes: 1000, retentionDays: 1 } });
    return { cleared, port: { async inspect() { return view(); }, async clear(sessionId: string) { cleared.push(sessionId); files = 0; return { schemaVersion: 1 as const, path: '/tmp/scratch-area', removedFiles: 2, removedBytes: 20 }; } } };
  }
  const scratchLabels = { ...withWindows, scratch: { summary: 's', empty: 'e', entry: 'ENTRY {path}', more: 'm', path: 'p', cleared: 'CLEARED {count} {bytes}', usage: 'u' } };

  it('lists the files in a window, names a file\'s path, clears only after a confirmation and leaves one summary line', async () => {
    const { cleared, port } = scratchPort(2);
    const view = mountWorkline({ labels: scratchLabels, scratch: port });
    await ready(view);
    await send(view, '/scratch\r');
    await until(() => frameOf(view).includes('SC-TITLE') && frameOf(view).includes('f0.txt') && frameOf(view).includes('SC-CLEAR-ROW'), 'scratch window');
    expect(frameOf(view)).toContain('SC-FOLDER');
    expect(frameOf(view)).toContain('SC-STATUS 2 20 1000');
    view.stdin.write(ENTER); // Enter on the first file names its full path
    await until(() => frameOf(view).includes('SC-PATH-TITLE'), 'path window');
    await settle(80);
    view.stdin.write(ENTER);
    await until(() => !frameOf(view).includes('SC-PATH-TITLE') && frameOf(view).includes('SC-TITLE'), 'back to the list');
    for (let step = 0; step < 2; step++) { view.stdin.write(DOWN); await settle(30); }
    view.stdin.write(ENTER);
    await until(() => frameOf(view).includes('SC-CONFIRM-TITLE'), 'confirmation');
    expect(cleared).toEqual([]);
    await settle(80);
    view.stdin.write('n'); // keeps the files: the confirmation and the list both close, nothing is removed
    await until(() => !frameOf(view).includes('SC-CONFIRM-TITLE') && !frameOf(view).includes('SC-TITLE'), 'kept');
    expect(cleared).toEqual([]);
    await send(view, '/scratch\r');
    await until(() => frameOf(view).includes('SC-TITLE'), 'window again');
    for (let step = 0; step < 2; step++) { view.stdin.write(DOWN); await settle(30); }
    view.stdin.write(ENTER);
    await until(() => frameOf(view).includes('SC-CONFIRM-TITLE'), 'confirmation again');
    await settle(80);
    view.stdin.write('y');
    await until(() => cleared.length === 1 && frameOf(view).includes('CLEARED 2 20'), 'cleared with its summary');
    expect(frameOf(view)).not.toContain('SC-TITLE');
    expect(frameOf(view)).not.toContain('f0.txt'); // no file notices in the chat stream
    expect(frameOf(view).match(/CLEARED/gu)).toHaveLength(1);
  });

  it('Esc closes the window and nothing reaches the chat stream', async () => {
    const { port } = scratchPort(1);
    const view = mountWorkline({ labels: scratchLabels, scratch: port });
    await ready(view);
    await send(view, '/scratch\r');
    await until(() => frameOf(view).includes('SC-TITLE'), 'window');
    view.stdin.write(ESC);
    await until(() => !frameOf(view).includes('SC-TITLE'), 'closed');
    expect(frameOf(view)).not.toContain('f0.txt');
    expect(frameOf(view)).not.toContain('ENTRY');
  });
});

describe('an unknown command is a small window, not an error line', () => {
  it('shows the closest commands to pick, writes no error into the chat and runs the picked one', async () => {
    const view = mountWorkline({ labels: withWindows, sessions: { async save() { /* unused */ }, async list() { return []; }, async load() { return null; } } });
    await ready(view);
    await send(view, '/clea \r'); // a trailing space closes the palette so the literal text is submitted
    await until(() => frameOf(view).includes('UN-TITLE') && frameOf(view).includes('/clear'), 'unknown window');
    expect(frameOf(view)).toContain('UN-BODY /clea');
    expect(view.stdout.text).not.toContain('UNKNOWN');
    view.stdin.write(ENTER); // the first match is /clear: it runs
    await until(() => frameOf(view).includes('NEW-SESSION') && !frameOf(view).includes('UN-TITLE'), 'picked command ran');
  });

  it('with no close match the window says so and Esc closes it', async () => {
    const view = mountWorkline({ labels: withWindows });
    await ready(view);
    await send(view, '/qqqqzzzz \r');
    await until(() => frameOf(view).includes('UN-NONE'), 'none');
    view.stdin.write(ESC);
    await until(() => !frameOf(view).includes('UN-TITLE'), 'closed');
    expect(view.stdout.text).not.toContain('UNKNOWN');
  });

  it('always offers every command: the last row opens /help (SLASH-WINDOWS integration)', async () => {
    const view = mountWorkline({ labels: withWindows });
    await ready(view);
    await send(view, '/qqqqzzzz \r');
    await until(() => frameOf(view).includes('UN-NONE') && frameOf(view).includes('UN-ALL'), 'all-commands row');
    view.stdin.write(ENTER); // the only row: every command
    await until(() => !frameOf(view).includes('UN-TITLE') && view.stdout.text.includes('/status'), '/help answered');
    expect(view.stdout.text).not.toContain('UNKNOWN');
  });

  it('without window words (line-style terminal) the error notice is unchanged', async () => {
    const view = mountWorkline({});
    await ready(view);
    await send(view, '/qqqqzzzz \r');
    await until(() => view.stdout.text.includes('UNKNOWN: /qqqqzzzz'), 'notice');
  });
});
