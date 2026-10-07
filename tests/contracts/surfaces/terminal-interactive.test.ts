import { afterEach, describe, expect, it } from 'vitest';
import type { WorklineProps } from '#surfaces/core/terminal/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';

// Owner report 2026-09-27: "/ shows the commands but Enter does not select one". Keystrokes go through the real Ink WorklineApp.
const HELP_NOTICE = 'info\n  /status';
const DOWN = '\u001b[B', ESC = '\u001b';
const views: Array<ReturnType<typeof mountWorkline>> = [];
afterEach(() => { for (const view of views.splice(0)) view.instance.unmount(); });

async function open(props: Partial<WorklineProps> = {}) {
  const view = mountWorkline(props);
  views.push(view);
  await until(() => view.stdout.text.includes('READY'), 'ready');
  // A lone Esc is held by Ink for 20 ms (it may start a sequence); a person never presses the next key sooner.
  const type = async (...chunks: string[]) => {
    for (const chunk of chunks) for (const char of chunk.startsWith(ESC) ? [chunk] : [...chunk]) { view.stdin.write(char); await settle(chunk === ESC ? 40 : 3); }
  };
  const after = (mark: number) => view.stdout.text.slice(mark);
  return { ...view, type, after };
}

describe('slash palette keys through the real workline', () => {
  it('Enter on the highlighted suggestion executes it instead of sending the typed prefix', async () => {
    const view = await open();
    await view.type('/hel');
    await until(() => view.stdout.text.includes('> /help'), 'palette shows /help');
    await view.type('\r');
    await until(() => view.stdout.text.includes(HELP_NOTICE), 'help executed');
    expect(view.stdout.text).not.toContain('UNKNOWN');
  });

  it('arrows move the highlight and Enter runs the highlighted command', async () => {
    const ledger = { workerHeartbeatMs: 60_000, inspectWorkers: async () => ({ schemaVersion: 1, scopeId: 's', sources: [] }) as never,
      listRunIds: async () => [] } as never;
    const view = await open({ ledger, pollMs: 60_000 });
    await view.type('/sta');
    await until(() => view.stdout.text.includes('> /status'), 'palette');
    await view.type('\r');
    await until(() => view.stdout.text.includes('STATUS-LINE'), 'status executed');
    // '/wa' offers watch-workers, watch-runs, watch-stop; Down highlights watch-runs and Enter runs exactly that one.
    await view.type('/wa', DOWN);
    await until(() => view.stdout.text.includes('> /watch-runs'), 'second row highlighted');
    await view.type('\r');
    await until(() => view.stdout.text.includes('RUNS-ON'), 'watch-runs executed');
    expect(view.stdout.text).not.toContain('WATCH-ON');
    expect(view.stdout.text).not.toContain('UNKNOWN');
  });

  it('Enter on a command that has a registry argument runs it at once; the palette never waits for typed text (SLASH-WINDOWS)', async () => {
    const inspected: string[] = [];
    const view = await open({ ledger: { workerHeartbeatMs: 60_000, inspectWorkers: async () => ({ schemaVersion: 1, scopeId: 's', sources: [] }) as never,
      inspectRun: async runId => { inspected.push(runId); return null; } } as never });
    await view.type('/ru');
    await until(() => view.stdout.text.includes('RUN-DESC') || view.stdout.text.includes('> /run'), 'palette');
    await view.type('\r');
    await until(() => view.stdout.text.includes('USAGE'), 'bare /run answered at once');
    expect(view.stdout.text).not.toContain('> /run |');
    expect(inspected).toEqual([]);
  });

  it('Tab completes, Esc closes the palette, and Enter without suggestions sends the text as typed', async () => {
    const view = await open();
    await view.type('/hel', '\t');
    await until(() => view.stdout.text.includes('> /help |'), 'tab completed');
    await view.type('\r');
    await until(() => view.stdout.text.includes(HELP_NOTICE), 'help executed');
    await view.type('/he', ESC, '\r');
    await until(() => view.stdout.text.includes('UNKNOWN: /he'), 'esc closed the palette; Enter sent the typed text');
    await view.type('/zzz\r');
    await until(() => view.stdout.text.includes('UNKNOWN: /zzz'), 'no suggestion: typed text sent');
  });

  it('typing filters by prefix first, then by fuzzy subsequence', async () => {
    const view = await open();
    await view.type('/wwk');
    await until(() => view.stdout.text.includes('> /watch-workers'), 'fuzzy match offered');
    await view.type('\r');
    await until(() => view.stdout.text.includes('NO-LEDGER'), 'watch-workers ran (no ledger wired)');
    expect(view.stdout.text).not.toContain('UNKNOWN');
  });
});

// Owner report 2026-09-27: "@ does not reference files". Candidates and content come from ports (the service in production).
const FILES = ['README.md', 'src/app.ts', 'src/a.ts', 'src/cli/main.ts', 'docs/only.md'];
function filePorts() {
  const queries: string[] = [], attached: Array<{ text: string; paths: readonly string[] }> = [], sent: string[] = [];
  const mentions = async (query: string) => { queries.push(query); return FILES.filter(path => path.toLowerCase().includes(query.toLowerCase())); };
  const attachMentions = async (text: string, paths: readonly string[]) => {
    attached.push({ text, paths });
    return { content: `${text}\n\n${paths.map(path => `--- attached file ${path} ---\nBODY(${path})\n--- end of ${path} ---`).join('\n\n')}`,
      notes: paths.map(path => path === '.env' ? { path, status: 'refused' as const, reason: 'path-denied' }
        : { path, status: 'attached' as const, bytes: 20, totalBytes: 20, truncated: false }) };
  };
  const streamTurn = async function* (messages: readonly { role: string; content: string }[]) {
    sent.push(messages.at(-1)!.content);
    yield { kind: 'text' as const, text: 'ok' };
    yield { kind: 'done' as const, finish: 'stop' as const, note: null };
  };
  return { queries, attached, sent, props: { mentions, attachMentions, streamTurn: streamTurn as never, mentionDelayMs: 0 } };
}

describe('@file picker keys through the real workline', () => {
  it('typing @ opens the picker from the port; arrows and Enter insert the chosen path; a single match is offered, not typed', async () => {
    const ports = filePorts();
    const view = await open(ports.props);
    await view.type('look @sr');
    await until(() => view.stdout.text.includes('> @src/app.ts') && view.stdout.text.includes('  @src/a.ts'), 'picker with candidates');
    expect(ports.queries).toContain('sr');
    await view.type(DOWN);
    await until(() => view.stdout.text.includes('> @src/a.ts'), 'second candidate highlighted');
    await view.type('\r');
    await until(() => view.stdout.text.includes('> look @src/a.ts |'), 'path inserted');
    expect(ports.sent).toEqual([]);
    const mark = view.stdout.text.length;
    await view.type('and @onl');
    await until(() => view.after(mark).includes('> @docs/only.md'), 'single candidate offered');
    await settle(20);
    expect(view.after(mark)).toContain('> look @src/a.ts and @onl|');
    await view.type('\t');
    await until(() => view.stdout.text.includes('> look @src/a.ts and @docs/only.md |'), 'tab inserts');
  });

  it('Esc closes the picker for good (a late answer does not reopen it) and Enter then sends the text', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ports = filePorts();
    const view = await open({ ...ports.props, mentions: async (query: string) => { await gate; return ports.props.mentions(query); } });
    await view.type('see @RE');
    await settle(20);
    await view.type(ESC);
    release();
    await settle(60);
    expect(view.stdout.text).not.toContain('> @README.md');
    await view.type('\r');
    await until(() => ports.sent.length === 1, 'sent');
  });

  it('on submit the mentioned files are attached through the port: the model gets the labelled content, the ledger the typed text and one notice per file', async () => {
    const ports = filePorts();
    const view = await open(ports.props);
    view.stdin.write('[paste]');
    await view.type('explain @src/a.ts, @.env and @src/a.ts\r');
    await until(() => ports.sent.length === 1, 'turn sent');
    expect(ports.attached).toEqual([{ text: '[paste]explain @src/a.ts, @.env and @src/a.ts', paths: ['src/a.ts', '.env'] }]);
    expect(ports.sent[0]).toContain('--- attached file src/a.ts ---\nBODY(src/a.ts)');
    await until(() => view.stdout.text.includes('@src/a.ts · 20 B') && view.stdout.text.includes('@.env · path-denied'), 'attachment notices');
  });

  it('never treats an @name inside pasted content as a file to attach', async () => {
    const ports = filePorts();
    const view = await open(ports.props);
    view.stdin.write('\u001b[200~line1 @src/a.ts\nline2\nline3\nline4\u001b[201~');
    await settle(30);
    await view.type(' see @README.md\r');
    await until(() => ports.sent.length === 1, 'turn sent');
    expect(ports.attached.map(entry => entry.paths)).toEqual([['README.md']]);
    expect(ports.sent[0]).toContain('line1 @src/a.ts');
  });
});
