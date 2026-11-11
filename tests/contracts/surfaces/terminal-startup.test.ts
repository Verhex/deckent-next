import { openingGate } from '#surfaces/core/terminal-kit/index.js';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CLEAR_VISIBLE_SCREEN, clearVisibleScreen, resolveWorklinePalette, startupFrame, STARTUP_BANNERS, TERMINAL_THEME_SETTINGS, writeStartup, type WorklineStartup } from '#surfaces/core/terminal/index.js';
import { terminalStartupLabels } from '#surfaces/core/terminal-labels/index.js';
import { terminalConfigSchema, TERMINAL_BANNERS, TERMINAL_THEMES } from '#adapters/index.js';
import { terminalScreen } from '../../fixtures/terminal-screen.js';
import { PassThrough, Writable } from 'node:stream';
import { createElement } from 'react';
import { Box, measureElement, Text, type DOMElement } from 'ink';
import { openTerminalHost, openTerminalShell } from '#surfaces/core/terminal-host/index.js';
import { displayWidth } from '#surfaces/core/terminal-composer/index.js';
import { useTerminalHandover } from '#surfaces/core/terminal-render-ink/index.js';
import { runTerminalWorkline } from '#surfaces/core/terminal/index.js';
import { worklineLabels } from '#surfaces/core/terminal-labels/index.js';
import { settle, until } from '../support/workline-harness.js';
// eslint-disable-next-line no-restricted-imports -- Existing streaming VT renderer supplies real resize and screen state.
import { BeuserScreenRenderer } from '#adapters/core/beuser-surface/internal/screen.js';

// T2 T-STARTUP (owner 2026-10-07): the rich surface clears the visible screen (never the scrollback) and starts with its banner at the top.
const facts = { version: '1.0.0-alpha.9', project: 'deckent-next', path: '~/deckent-next', model: 'local-openai/chat@1' };
const startup = (locale: 'en' | 'tr', options: Partial<WorklineStartup> = {}, ascii = false): WorklineStartup =>
  ({ clear: true, banner: 'full', ...terminalStartupLabels(locale, facts, ascii), ...options });
const plain = resolveWorklinePalette('none');
// Owner-approved mark-art.json, pasted here as an independent art oracle (B11-MARK).
const smallMark = [
  '      ⣿⣿',
  '⢀⣴⣾⠿⠿⣿⣿⣿',
  '⣾⡟⢀⡀  ⣿⣿',
  '⢿⣧⣿⠁  ⣿⣿',
  '⠈⠻⢿⣶⣶⣿⣿⣿',
];
const largeMark = [
  '            ⣿⣿⣿⡇',
  '            ⣿⣿⣿⡇',
  '    ⣀⣤⣴⣶⣶⣤⣄⡀⣿⣿⣿⡇',
  ' ⢀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇',
  '⢀⣾⣿⣿⡿⠋⠁  ⠈⠙⢿⣿⣿⣿⡇',
  '⢸⣿⣿⡿  ⣀⡀   ⠘⣿⣿⣿⡇',
  '⢸⣿⣿⣧ ⣼⣿⠁   ⣰⣿⣿⣿⡇',
  '⠘⣿⣿⣿⣦⡹⣿⣷⣤⣤⣾⣿⣿⣿⣿⡇',
  ' ⠘⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇',
  '   ⠉⠻⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇',
];
const asciiMark = ['      ##', '.o######', '##..  ##', '###.  ##', '.o######'];

it('keeps one startup mark and help region through width and height changes on the production terminal host', async () => {
  class Tty extends Writable {
    isTTY = true; rows = 30; columns = 110; text = '';
    holdFlush = false; releaseFlush: (() => void) | undefined;
    override _write(chunk: Buffer, _encoding: string, done: () => void) {
      this.text += chunk.toString('utf8');
      if (this.holdFlush && chunk.length === 0) { this.holdFlush = false; this.releaseFlush = () => { this.releaseFlush = undefined; done(); }; } else done();
    }
  }
  for (const banner of ['full', 'off'] as const) {
    const stdout = new Tty(), stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
      setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const screen = new BeuserScreenRenderer({ columns: 110, rows: 30, scrollback: 100 }, 1_000_000);
    const controller = new AbortController(), labels = worklineLabels('en', '');
    let resumeStream!: () => void, finishTurn!: () => void;
    const streamed = new Promise<void>(resolve => { resumeStream = resolve; });
    const decided = new Promise<void>(resolve => { finishTurn = resolve; });
    let finishEditor!: () => void, finishSetup!: () => void, editorOpen = false, setupOpen = false;
    const editor = new Promise<void>(resolve => { finishEditor = resolve; }), setup = new Promise<void>(resolve => { finishSetup = resolve; });
    const decisions: string[] = [];
    let offset = 0;
    const replay = async () => {
      // Replay every emitted byte once, with the PTY's ONLCR line discipline; retain screen state across resizes.
      const text = stdout.text.slice(offset); offset = stdout.text.length;
      await screen.write(Buffer.from(text.replaceAll('\n', '\r\n')));
      return screen.snapshot().text;
    };
    const resize = (columns: number, rows: number) => {
      screen.resize(columns, rows); Object.assign(stdout, { columns, rows }); stdout.emit('resize');
    };
    const sizes = [[60, 30], [110, 30], [110, 40], [110, 30]] as const;
    const markSizes = [[60, 30, false], [100, 30, true], [99, 30, false], [100, 29, false], [100, 30, true], [110, 40, true], [110, 30, true]] as const;
    const checkMark = (text: string, large: boolean) => {
      const expected = large ? largeMark : smallMark, width = large ? 16 : 8;
      const markColumns = text.split('\n').map(line => line.slice(0, width).trimEnd()).join('\n');
      expect(markColumns.split(expected.join('\n')).length - 1, `${banner}\n${text}`).toBe(banner === 'full' ? 1 : 0);
      if (banner === 'off') expect(text).not.toMatch(/[\u2800-\u28ff]/u);
    };
    const checkResizes = async (tokens: readonly string[]) => {
      for (const [columns, rows] of sizes) {
        resize(columns, rows); await settle(160);
        const text = await replay();
        for (const token of tokens) expect(text.split(token).length - 1, `${banner} ${columns}x${rows}\n${text}`).toBe(1);
      }
    };
    const shell = await openTerminalShell({ palette: plain, startup: startup('en', { banner }),
      stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, signal: controller.signal,
      labels: { composer: labels.composer, prompt: labels.prompt, banner: labels.banner, hint: labels.hint,
        status: 'preparing', queued: '{count}', dropped: '{count}' } });
    try {
      await settle(120); checkMark(await replay(), true);
      for (const [columns, rows, large] of markSizes) {
        resize(columns, rows); await settle(160); checkMark(await replay(), large);
      }
    } catch (error) { await shell.host.close(); screen.dispose(); throw error; }
    const running = runTerminalWorkline({ labels, shell, startup: startup('en', { banner }), palette: plain,
      stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, signal: controller.signal,
      context: { installationId: 'i', projectId: 'p', scopeId: 's' }, target: 'scope', systemPrompt: 'system', historyMessages: 40,
      completeTurn: async () => 'unused', errorText: String, decisionArmMs: 0,
      externalEditor: { edit: async () => { editorOpen = true; await editor; return { kind: 'unchanged' }; } },
      onboarding: { modelDraft: 'unused', open: async () => { setupOpen = true; await setup; return null; } },
      streamTurn: async function* (_messages, _signal, turn) {
        turn?.onTurnBound?.({ scopeId: 's', sessionId: turn.sessionId ?? null, turnId: 'resize-turn', phase: 'command-generated' });
        yield { kind: 'text', text: 'STREAM-BEFORE\n' }; await streamed;
        yield { kind: 'text', text: 'STREAM-AFTER\n' };
        yield { kind: 'approval', phase: 'requested', callId: 'c1', approvalId: 'resize-card', revision: 0,
          summary: 'RESIZE-CARD', preview: 'preview survives', expiresAt: Date.now() + 600_000 };
        await decided;
        yield { kind: 'approval', phase: 'settled', callId: 'c1', approvalId: 'resize-card', outcome: 'deny' };
        yield { kind: 'text', text: 'STREAM-DONE' }; yield { kind: 'done', finish: 'stop' };
      },
      ledger: { scopeId: 's', async listWorkers() { return { schemaVersion: 1, scopeId: 's', sources: [] }; }, async inspectRun() { return null; },
        async decideApproval(approval, decision) { decisions.push(decision); finishTurn();
          return { approvalId: approval.approvalId, runId: '-', taskId: '-', summary: '', requester: '-', revision: 1, status: 'decided', decision, expiresAt: 0 }; } } });
    try {
      await until(() => stdout.text.includes('Enter send'), 'startup help'); await settle(120);
      stdin.write('DRAFT-SURVIVES'); await until(() => stdout.text.includes('DRAFT-SURVIVES'), 'draft'); await settle(120);
      const snapshots = [{ size: '110x30', large: true, text: await replay() }];
      for (const [columns, rows, large] of markSizes) {
        resize(columns, rows); await settle(160);
        snapshots.push({ size: `${columns}x${rows}`, large, text: await replay() });
      }
      for (const { size, large, text } of snapshots) {
        const at = `${banner} ${size}\n${text}`;
        checkMark(text, large);
        expect.soft(text.split('/help · Shift+Tab mode · ? shortcuts').length - 1, at).toBe(banner === 'full' ? 1 : 0);
        expect.soft(text.split('deckent workline.').length - 1, at).toBe(1);
        expect.soft(text.split('Ctrl+C twice when idle quits.').length - 1, at).toBe(1);
        expect.soft(text.split('Enter send').length - 1, at).toBe(1);
        expect.soft(text.split('DRAFT-SURVIVES').length - 1, at).toBe(1);
        expect.soft(text, at).toContain('DRAFT-SURVIVES|');
      }
      stdin.write('\u001b[D'); await settle(40);
      await checkResizes(['DRAFT-SURVIVE|S']);
      stdin.write('X'); await settle(40);
      expect(await replay()).toContain('DRAFT-SURVIVEX|S');
      stdin.write('\r'); await until(() => stdout.text.includes('STREAM-BEFORE'), 'stream started');
      stdin.write('BUSY-DRAFT'); await settle(80);
      await checkResizes(['STREAM-BEFORE', 'BUSY-DRAFT|']);
      resumeStream(); await until(() => stdout.text.includes('RESIZE-CARD'), 'open card'); await settle(80);
      await checkResizes(['Approval needed', 'RESIZE-CARD', 'STREAM-AFTER']);
      expect(decisions).toEqual([]);
      // The card still owns keys after resizing; move to the still-mounted composer and back.
      stdin.write('\u000f'); await settle(60);
      expect(await replay()).toContain('BUSY-DRAFT|');
      stdin.write('-KEPT'); await settle(40); stdin.write('\u000f'); await settle(60);
      const burstStart = stdout.text.length;
      resize(60, 30); resize(110, 40); resize(110, 30); await settle(160);
      expect(stdout.text.slice(burstStart).split(CLEAR_VISIBLE_SCREEN)).toHaveLength(2);
      expect((await replay()).split('RESIZE-CARD')).toHaveLength(2);
      stdin.write('n'); await until(() => stdout.text.includes('STREAM-DONE'), 'stream finished'); await settle(80);
      const final = await replay(); expect(final).toContain('BUSY-DRAFT-KEPT|'); expect(final).toContain('STREAM-DONE');
      expect(final).not.toContain('RESIZE-CARD'); expect(decisions).toEqual(['deny']);
      expect(stdout.text.split('\u001b[?1049h')).toHaveLength(2);
      // Real editor and /setup callers must bracket the whole Ink suspension, including its async resume.
      for (const kind of ['editor', 'setup'] as const) {
        if (kind === 'editor') stdin.write('\u0007');
        else { stdin.write('\u0015'); await settle(40); stdin.write('/setup\r'); }
        await until(() => kind === 'editor' ? editorOpen : setupOpen, `${kind} handed over`);
        const held = stdout.text.length;
        resize(60, 30); resize(110, 40); await settle(160);
        expect(stdout.text.slice(held), `${kind} owns the screen`).toBe('');
        const returned = stdout.text.length;
        if (kind === 'editor') finishEditor(); else finishSetup();
        await until(() => stdout.text.slice(returned).includes(CLEAR_VISIBLE_SCREEN), `${kind} repaint after return`); await settle(120);
        expect(stdout.text.slice(returned).split(CLEAR_VISIBLE_SCREEN)).toHaveLength(2);
        const text = await replay(); expect(text.split('Enter send')).toHaveLength(2);
        if (kind === 'editor') expect(text.split('BUSY-DRAFT-KEPT|')).toHaveLength(2);
      }
    } finally {
      resumeStream(); finishTurn(); finishEditor(); finishSetup();
      resize(60, 30); controller.abort(); await running; await settle(40);
      expect(stdout.listenerCount('resize')).toBe(0);
      const closed = stdout.text; stdout.emit('resize'); await settle(40); expect(stdout.text).toBe(closed);
      screen.dispose();
    }
  }
  // Exercise the public handover hook on the same production host, including a flush held after the hidden frame.
  for (const pending of [false, true]) {
    const stdout = new Tty(), stdin = Object.assign(new PassThrough(), { isTTY: true,
      setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const screen = new BeuserScreenRenderer({ columns: 110, rows: 30, scrollback: 100 }, 1_000_000);
    let handover!: ReturnType<typeof useTerminalHandover>, finish!: () => void, entered = false, offset = 0, frame: DOMElement | null = null;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    function View() { handover = useTerminalHandover(); return createElement(Box, { ref: node => { frame = node; } }, createElement(Text, null, 'OWNED-FRAME')); }
    const host = await openTerminalHost({ palette: plain, view: () => createElement(View),
      stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream });
    const replay = async () => {
      const text = stdout.text.slice(offset); offset = stdout.text.length;
      await screen.write(Buffer.from(text.replaceAll('\n', '\r\n'))); return screen.snapshot().text;
    };
    const resize = (columns: number, rows: number) => {
      screen.resize(columns, rows); Object.assign(stdout, { columns, rows }); stdout.emit('resize');
    };
    let handed: Promise<unknown> | undefined;
    try {
      await host.flushed(); expect(await replay()).toContain('OWNED-FRAME');
      if (pending) {
        stdout.holdFlush = true; resize(60, 30);
        await until(() => Boolean(stdout.releaseFlush), 'hidden-frame flush held');
        expect(measureElement(frame!).height, 'subtree hidden before the clear').toBe(0);
      }
      handed = handover('OTHER-SURFACE', async () => { entered = true; await gate; });
      await until(() => entered, 'terminal handed over');
      await replay();
      if (pending) stdout.releaseFlush?.();
      const start = stdout.text.length, heldInput = stdin.listenerCount('data');
      // Astra 3069 R3: a second, refused handover must not hand input or reporting back while the first one still owns the terminal.
      let second = false;
      expect(await handover('SECOND-SURFACE', async () => { second = true; })).toBeNull();
      expect.soft(second, 'the overlapping handover is refused').toBe(false);
      expect.soft(stdin.listenerCount('data'), 'input stays with the first handover').toBe(heldInput);
      resize(60, 30); resize(110, 40); await settle(160);
      expect.soft(stdout.text.slice(start), `no repaint or reporting bytes while handed over (pending=${pending})`).toBe('');
      const returned = stdout.text.length; finish(); await handed; await settle(160);
      expect.soft(stdout.text.slice(returned).split('\u001b[?1000h'), 'mouse reporting returns once, with the last holder').toHaveLength(2);
      expect.soft(stdin.listenerCount('data'), 'input returns after the first handover ends').toBeGreaterThan(heldInput);
      expect.soft(stdout.text.slice(returned).split(CLEAR_VISIBLE_SCREEN), `one repaint after return (pending=${pending})`).toHaveLength(2);
      expect.soft((await replay()).split('OWNED-FRAME'), stdout.text.slice(returned)).toHaveLength(2);
      // Ink re-enters once on resume; ResizeFrame must never add another alternate-screen entry.
      expect(stdout.text.split('\u001b[?1049h')).toHaveLength(3);
    } finally {
      stdout.releaseFlush?.(); finish(); await handed; await host.close();
      expect(stdout.listenerCount('resize')).toBe(0);
      const closed = stdout.text; stdout.emit('resize'); await settle(40); expect(stdout.text).toBe(closed);
      screen.dispose();
    }
  }
});

describe('opening frame (T2 T-STARTUP)', () => {
  it('scrolls the visible rows into the scrollback, homes and clears the screen, and never sends ED 3', () => {
    expect(clearVisibleScreen(5)).toBe(`\n\n\n\n\n${CLEAR_VISIBLE_SCREEN}`);
    expect(CLEAR_VISIBLE_SCREEN).toBe('\u001b[H\u001b[2J');
    for (const banner of ['full', 'compact', 'off'] as const) for (const locale of ['en', 'tr'] as const) {
      const frame = startupFrame(startup(locale, { banner }), resolveWorklinePalette('truecolor'), 100, 30);
      expect(frame).not.toContain('\u001b[3J');
      expect(frame.startsWith(`${'\n'.repeat(30)}${CLEAR_VISIBLE_SCREEN}`)).toBe(true);
    }
    // Earlier output survives in the replayed scrollback; the banner is the first row of the cleared screen.
    const before = 'old line 1\r\nold line 2\r\n';
    const frame = startupFrame(startup('en'), plain, 100, 10).replace(/\n/gu, '\r\n');
    const screen = terminalScreen(before + frame, 100, 10);
    expect(screen).toContain('old line 1');
    expect(screen.slice(screen.indexOf('      ⣿⣿'))).toContain('deckent 1.0.0-alpha.9');
    expect(screen.indexOf('old line 2')).toBeLessThan(screen.indexOf('      ⣿⣿'));
  });

  it('prints the mark beside version, project, model and the hint without stale mode — EN, TR, NO_COLOR and ASCII', () => {
    const en = stripVTControlCharacters(startupFrame(startup('en', { clear: false }), plain, 99, 30));
    expect(en.split('\n').slice(0, 5).map(line => line.trimEnd())).toEqual([
      '      ⣿⣿',
      '⢀⣴⣾⠿⠿⣿⣿⣿  deckent 1.0.0-alpha.9',
      '⣾⡟⢀⡀  ⣿⣿  Project deckent-next · ~/deckent-next',
      '⢿⣧⣿⠁  ⣿⣿  Model: local-openai/chat@1',
      '⠈⠻⢿⣶⣶⣿⣿⣿  /help · Shift+Tab mode · ? shortcuts',
    ]);
    const tr = stripVTControlCharacters(startupFrame(startup('tr', { clear: false }), plain, 100, 30));
    expect(tr).toContain('Proje deckent-next · ~/deckent-next');
    expect(tr).toContain('Model: local-openai/chat@1');
    expect(tr).toContain('/help · Shift+Tab mod · ? kısayollar');
    expect(en).not.toContain('standard'); expect(tr).not.toContain('standart');
    // NO_COLOR: the `none` palette leaves no escape at all in the banner.
    expect(startupFrame(startup('tr', { clear: false }), plain, 100, 30)).not.toContain('\u001b');
    const ascii = stripVTControlCharacters(startupFrame(startup('en', { clear: false }, true), plain, 100, 30));
    expect(ascii.split('\n').slice(0, 5).map(line => line.slice(0, 8).trimEnd())).toEqual(asciiMark);
    for (const locale of ['en', 'tr'] as const) {
      const unicode = startup(locale), ascii = startup(locale, {}, true);
      expect(unicode.logo).toEqual(smallMark); expect(unicode.logoLarge).toEqual(largeMark);
      expect(ascii.logo).toEqual(asciiMark); expect(ascii.logoLarge).toEqual(asciiMark);
      for (const [art, count, width] of [[unicode.logo, 5, 8], [unicode.logoLarge, 10, 16], [ascii.logo, 5, 8]] as const) {
        expect(art).toHaveLength(count);
        for (const row of art) { expect(displayWidth(row)).toBe(width); expect(row).toBe(row.trimEnd()); }
      }
      expect(unicode.logo.join('') + unicode.logoLarge.join('')).toMatch(/^[ \u2801-\u28ff]+$/u);
      expect(ascii.logo.join('')).toMatch(/^[ -~]+$/u);
    }
    for (const [columns, height, large] of [[60, 30, false], [100, 30, true], [99, 30, false], [100, 29, false], [120, 40, true]] as const)
      for (const locale of ['en', 'tr'] as const) for (const ascii of [false, true]) {
      const labels = startup(locale, { clear: false }, ascii), rendered = stripVTControlCharacters(startupFrame(labels, plain, columns, height));
      const rows = rendered.trimEnd().split('\n');
      const expected = ascii ? asciiMark : large ? largeMark : smallMark;
      expect(rows).toHaveLength(expected.length);
      expect(rows[expected.length - 4]).toContain('deckent 1.0.0-alpha.9');
      expect(rows.map(row => row.slice(0, ascii || !large ? 8 : 16).trimEnd())).toEqual(expected);
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(columns);
      for (const line of labels.lines) expect(rendered).toContain(line);
    }
  });

  it('is one line below 60 columns or when compact, nothing but the clear when off, and nothing at all to a pipe or redirect', () => {
    const narrow = stripVTControlCharacters(startupFrame(startup('en', { clear: false }), plain, 59, 30));
    // One row, cut at the window width so the facts that matter (version and project) stay first.
    expect(narrow.trimEnd().split('\n')).toEqual(['deckent 1.0.0-alpha.9 · deckent-next · /help · ? shortcuts']);
    expect(stripVTControlCharacters(startupFrame(startup('tr', { clear: false, banner: 'compact' }), plain, 120, 30)).trimEnd())
      .toBe('deckent 1.0.0-alpha.9 · deckent-next · /help · ? kısayollar');
    expect(startupFrame(startup('en', { banner: 'off' }), plain, 100, 3)).toBe(`\n\n\n${CLEAR_VISIBLE_SCREEN}`);
    expect(startupFrame(startup('en', { banner: 'off', clear: false }), plain, 100, 3)).toBe('');
    // A pipe or redirect gets nothing at all (no clear sequence, no banner).
    const written: string[] = [];
    const sink = (isTTY: boolean) => ({ isTTY, columns: 100, rows: 30, write: (chunk: string) => { written.push(chunk); return true; } });
    writeStartup(sink(false) as never, startup('en'), plain);
    expect(written).toEqual([]);
    writeStartup(sink(true) as never, startup('en'), plain);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(CLEAR_VISIBLE_SCREEN);
  });

  it('registers theme, banner and clearOnStart in the terminal section with the workline\'s own vocabulary', () => {
    expect([...TERMINAL_THEMES]).toEqual([...TERMINAL_THEME_SETTINGS]);
    expect([...TERMINAL_BANNERS]).toEqual([...STARTUP_BANNERS]);
    for (const theme of TERMINAL_THEME_SETTINGS) expect(terminalConfigSchema.parse({ theme }).theme).toBe(theme);
    expect(terminalConfigSchema.parse({})).toMatchObject({ theme: 'auto', banner: 'full', clearOnStart: true });
    expect(terminalConfigSchema.safeParse({ banner: 'loud' }).success).toBe(false);
    expect(terminalConfigSchema.safeParse({ theme: 'solarized' }).success).toBe(false);
  });
});


it('local windows bypass pending startup; a real turn still waits and can be cancelled', async () => {
  let release: (() => void) | undefined;
  const gate = openingGate(new Promise<void>(resolve => { release = resolve; }));
  const abort = new AbortController(); let waiting = 0;
  for (const line of ['/model', '/provider', '/help', '/tasks', '/exit', '/quit']) {
    expect(await gate(line, abort.signal, () => waiting++)).toBe(true);
  }
  expect(waiting).toBe(0);
  let proceeded = false;
  const send = gate('hello', abort.signal, () => waiting++).then(result => { proceeded = result; });
  await Promise.resolve(); expect(proceeded).toBe(false); expect(waiting).toBe(1);
  abort.abort(); await send; expect(proceeded).toBe(false);
  release!();
  expect(await gate('hello', new AbortController().signal, () => waiting++)).toBe(true);
});
