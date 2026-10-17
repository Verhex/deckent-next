import { PassThrough, Writable } from 'node:stream';
import { createElement, useState } from 'react';
import { Box, render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionModeKeys } from '#surfaces/core/terminal/index.js';
import { WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { span } from '#surfaces/core/terminal-render/index.js';
import { Window, WindowOpeningContext, WindowStackProvider } from '#surfaces/core/terminal-window/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';

// T2 T-MODE-CYCLE on the real interactive workline (in-memory TTY): Shift+Tab and Alt+M step the mode through the port only while the composer
// owns the keyboard and no turn runs; a running turn keeps its mode (as a queued `/mode` does), so the status row never disagrees with it.
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });

const view = { schemaVersion: 1 as const, scopeId: 'scope', supported: true, mode: 'standart' as const, askEdits: false, revision: 'r0', eligible: true, fullAccess: true, fullAuto: true };
type Mode = 'standart' | 'full-auto' | 'full-access';
function port() {
  const calls: unknown[] = [];
  let current: typeof view = view;
  return { calls, port: { async inspect() { return current; },
    async set(mode: Mode, expectedRevision: string, askEdits?: boolean) {
      calls.push([mode, expectedRevision, askEdits]);
      const previous = current.mode;
      current = { ...current, mode, askEdits: askEdits ?? current.askEdits, revision: `r${calls.length}` };
      return { ...current, previous, changed: true };
    } } };
}

describe('Shift+Tab / Alt+M ownership (T2 T-MODE-CYCLE)', () => {
  it('steps the mode when idle; Alt+M does the same', async () => {
    const { calls, port: permissionMode } = port();
    const mountedView = mountWorkline({ permissionMode });
    mounted.push(mountedView.instance);
    await settle(40);
    mountedView.stdin.write('\u001b[Z');
    await until(() => calls.length === 1, 'first step');
    mountedView.stdin.write('\u001bm');
    await until(() => calls.length === 2, 'Alt+M step');
    expect(calls).toEqual([['standart', 'r0', true], ['full-auto', 'r1', false]]);
  });

  it('does nothing while a turn runs; the mode changes only after the turn', async () => {
    const { calls, port: permissionMode } = port();
    let release!: (value: string) => void;
    const mountedView = mountWorkline({ permissionMode, completeTurn: () => new Promise<string>(resolve => { release = resolve; }) });
    mounted.push(mountedView.instance);
    await settle(40);
    mountedView.stdin.write('hello\r');
    await until(() => mountedView.stdout.text.includes('BUSY'), 'turn running');
    mountedView.stdin.write('\u001b[Z');
    await settle(60);
    expect(calls).toEqual([]);
    release('done');
    await until(() => mountedView.stdout.text.includes('READY'), 'turn finished');
    await settle(30);
    mountedView.stdin.write('\u001b[Z');
    await until(() => calls.length === 1, 'step after the turn');
  });
});

// T2 integration (TS-WINDOW x T-MODE-CYCLE): the window stack owns Shift+Tab while any window is open, not only a card or picker.
class Sink extends Writable {
  readonly isTTY = true; readonly columns = 80; readonly rows = 30;
  override _write(_chunk: Buffer, _encoding: string, done: () => void) { done(); }
}
function PlainWindow({ cycled }: { readonly cycled: string[] }) {
  const [open, setOpen] = useState(true);
  return createElement(Box, { flexDirection: 'column' },
    createElement(PermissionModeKeys, { active: true, onCycle: () => { cycled.push(open ? 'cycled-with-window' : 'cycled'); } }),
    open ? createElement(Window, { title: [span('PLAIN')], hints: 'HINTS', position: '{from}-{to}/{total}', body: [{ spans: [span('body')] }],
      onClose: () => setOpen(false) }) : null);
}

describe('Shift+Tab and the window stack (T2 integration)', () => {
  it('an open plain window (neither card nor picker) owns Shift+Tab and Alt+M; after Esc closes it the mode steps', async () => {
    const cycled: string[] = [];
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const instance = render(createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'),
      children: createElement(WindowStackProvider, null, createElement(PlainWindow, { cycled })) }),
    { stdout: new Sink() as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
    mounted.push(instance);
    await settle(40);
    stdin.write('\u001b[Z'); await settle(40);
    stdin.write('\u001bm'); await settle(40);
    expect(cycled).toEqual([]);
    stdin.write('\u001b'); await settle(80);
    stdin.write('\u001b[Z');
    await until(() => cycled.length === 1, 'step after the window closed');
    expect(cycled).toEqual(['cycled']);
  });

  it('on the real workline, the /service-restart confirm window owns Shift+Tab; after n the mode steps', async () => {
    const { calls, port: permissionMode } = port();
    const mountedView = mountWorkline({ permissionMode, restartService: async () => 'RESTARTED' });
    mounted.push(mountedView.instance);
    await settle(40);
    mountedView.stdin.write('/service-restart\r');
    await until(() => mountedView.stdout.frame.includes('Restart the runtime service?'), 'confirm window open');
    mountedView.stdin.write('\u001b[Z');
    await settle(60);
    expect(calls).toEqual([]);
    mountedView.stdin.write('n');
    await until(() => !mountedView.stdout.frame.includes('Restart the runtime service?'), 'confirm window closed');
    await settle(30);
    mountedView.stdin.write('\u001b[Z');
    await until(() => calls.length === 1, 'step after the window');
  });
});

// K7 (owner 2026-10-14): the Runs window stays open in the background, so a passive (decision-free) window behind the focused composer must not
// lock the mode cycle; any other window — a card waiting behind the composer, or the passive window once focused (Ctrl+O) — still owns Shift+Tab.
describe('Shift+Tab with a background passive window (K7, /runs open)', () => {
  function mountStack(passive: boolean) {
    const cycled: string[] = [];
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const tree = createElement(Box, { flexDirection: 'column' },
      createElement(PermissionModeKeys, { active: true, onCycle: () => { cycled.push('cycled'); } }),
      createElement(WindowOpeningContext.Provider, { value: 'background' },
        createElement(Window, { title: [span('BACKGROUND')], hints: 'HINTS', position: '{from}-{to}/{total}', body: [{ spans: [span('body')] }], passive, onClose: () => undefined })));
    const instance = render(createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'),
      children: createElement(WindowStackProvider, { composerDefault: true }, tree) }),
    { stdout: new Sink() as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
    mounted.push(instance);
    return { cycled, stdin };
  }
  it('a passive window behind the focused composer leaves Shift+Tab and Alt+M to the mode; Ctrl+O focusing it takes them', async () => {
    const { cycled, stdin } = mountStack(true);
    await settle(40);
    stdin.write('\u001b[Z'); await until(() => cycled.length === 1, 'step with the passive window in the background');
    stdin.write('\u001bm'); await until(() => cycled.length === 2, 'Alt+M step');
    stdin.write('\u000f'); await settle(40);
    stdin.write('\u001b[Z'); await settle(60);
    expect(cycled).toHaveLength(2);
    stdin.write('\u000f'); await settle(40);
    stdin.write('\u001b[Z'); await until(() => cycled.length === 3, 'step after focus returns to the composer');
  });
  it('a non-passive window (a card) waiting behind the focused composer still owns Shift+Tab: the mode never changes behind a decision', async () => {
    const { cycled, stdin } = mountStack(false);
    await settle(40);
    stdin.write('\u001b[Z'); await settle(60);
    stdin.write('\u001bm'); await settle(60);
    expect(cycled).toEqual([]);
  });
});
