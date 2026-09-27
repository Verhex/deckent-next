import { afterEach, describe, expect, it } from 'vitest';
import type { WorklineProps } from '#surfaces/core/terminal/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';

// Owner report 2026-09-27: "/ shows the commands but Enter does not select one". Keystrokes go through the real Ink WorklineApp.
const HELP_NOTICE = '/watch-runs · /watch-stop';
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

  it('a command that takes an argument completes to "/cmd " and waits; the next Enter runs it with the argument', async () => {
    const inspected: string[] = [];
    const view = await open({ ledger: { workerHeartbeatMs: 60_000, inspectWorkers: async () => ({ schemaVersion: 1, scopeId: 's', sources: [] }) as never,
      inspectRun: async runId => { inspected.push(runId); return null; } } as never });
    await view.type('/ru');
    await until(() => view.stdout.text.includes('RUN-DESC') || view.stdout.text.includes('> /run'), 'palette');
    await view.type('\r');
    await until(() => view.stdout.text.includes('> /run |'), 'completed, waiting');
    await settle(30);
    expect(view.stdout.text).not.toContain('UNKNOWN');
    expect(view.stdout.text).not.toContain('USAGE');
    expect(inspected).toEqual([]);
    await view.type('r-1\r');
    await until(() => inspected.length === 1, 'run inspected');
    expect(inspected).toEqual(['r-1']);
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
