import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearConfigCache, t } from '#platform/index.js';
import type { WorkLedgerEntry, WorklineLedgerPorts } from '#surfaces/core/terminal-ledger/index.js';
import { terminalAdminPorts } from '#surfaces/core/terminal-admin/index.js';
import { terminalComposerLabels } from '#surfaces/core/terminal-labels/index.js';
import { WORKLINE_SLASH_COMMANDS } from '#surfaces/core/terminal-kit/index.js';
import { pickerLabels, workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { helpInfoModel, type SlashWindowLabels, type WorklineProps } from '#surfaces/core/terminal/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

// SLASH-WINDOWS integration (owner 2026-10-08): the three lanes' windows on ONE real workline. Every closed window leaves exactly one framed
// system line (the one `LedgerEntryRow` render point, captured below), no `Info:` notice, and slash text never becomes a chat row.
const captured = vi.hoisted(() => ({ entries: [] as WorkLedgerEntry[], seen: new WeakSet<object>() }));
vi.mock('#surfaces/core/terminal-work/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('#surfaces/core/terminal-work/index.js')>();
  return { ...original, LedgerEntryRow(props: Parameters<typeof original.LedgerEntryRow>[0]) {
    if (!captured.seen.has(props.entry)) { captured.seen.add(props.entry); captured.entries.push(props.entry); }
    return createElement(original.LedgerEntryRow, props);
  } };
});

const ESC = '\u001B', MARK = '◆ Deckent system';
const words = (key: string) => t(key, {}, 'en');
const WINDOWS: SlashWindowLabels = { picker: pickerLabels('en'), position: '{from}-{to}/{total}', hints: words('terminal.window.hints'), infoHints: words('terminal.window.infoHints'),
  reasoning: { title: 'Reasoning', thinkingOn: 'on', thinkingOff: 'off', previewOn: 'shown', previewOff: 'hidden', current: 'current', thinkingOnDetail: '', thinkingOffDetail: '',
    previewOnDetail: '', previewOffDetail: '', statusOn: 'reasoning on', statusOnHidden: 'reasoning on · preview hidden', statusOff: 'reasoning off' },
  scratch: { title: 'Scratch', status: '{count} {bytes} {limit}', folder: 'Folder', more: '+{count}', empty: 'empty', fileDetail: '{bytes}', clear: 'Clear', clearDetail: '',
    clearTitle: 'Clear?', clearBody: '{count} {bytes} {path}', clearPrompt: 'y/n', pathTitle: 'Path' },
  unknown: { title: words('terminal.window.unknown.title'), body: words('terminal.window.unknown.body'), closest: words('terminal.window.unknown.closest'),
    none: words('terminal.window.unknown.none'), all: words('terminal.window.unknown.all'), allDetail: words('terminal.window.unknown.allDetail') } };
const SESSIONS = { started: 'New conversation started.', entry: '{index} {session} {count} {preview}', none: 'none', notFound: 'nf', unavailable: 'np', saveFailed: 'sf',
  resumed: 'resumed {count} {session}', context: 'ctx', contextNone: 'ctx {count}' };
const LEDGER: WorklineLedgerPorts = { scopeId: 's', async inspectRun() { return null; },
  async listWorkers() { return { schemaVersion: 1, observedAt: Date.now(), scopeId: 's', sources: [{ workers: [{ taskId: 'task-1', process: 'running', provider: 'claude', authority: 'next-ledger' }] }] } as never; } };

const roots: string[] = [], views: Array<ReturnType<typeof mountWorkline>> = [];
beforeEach(() => { captured.entries = []; captured.seen = new WeakSet(); });
afterEach(async () => { for (const view of views.splice(0)) view.instance.unmount(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function type(view: ReturnType<typeof mountWorkline>, text: string) { for (const char of text) { view.stdin.write(char); await settle(2); } }
async function open(extra: Partial<WorklineProps> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-slash-int-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') } }));
  const info = terminalAdminPorts({ root, scopeId: 's', installationId: '7d1e2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b', projectId: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d',
    options: { env: { HOME: join(root, 'h') } }, locale: 'en', context: {}, status: async () => 'Terminal: stdin yes', doctor: async sink => { sink.write('DOCTOR\n'); },
    principalName: 'alperen' }).info;
  const completeTurn = vi.fn(async () => 'unexpected');
  const view = mountWorkline({ info, ledger: LEDGER, pollMs: 60_000, completeTurn,
    sessions: { async save() { /* kept in memory by the view */ }, async list() { return []; }, async load() { return null; } },
    labels: { ...WORKLINE_TEST_LABELS, work: workSurfaceLabels('en'), windows: WINDOWS, sessions: SESSIONS,
      composer: { ...WORKLINE_TEST_LABELS.composer, slash: terminalComposerLabels('en').slash } }, ...extra });
  views.push(view);
  await until(() => view.stdout.frame.includes('READY'), 'workline ready'); await settle(40);
  return { view, completeTurn, info };
}
const summaries = () => captured.entries.filter(entry => entry.kind === 'notice' && entry.id === 'system-summary');

describe('slash windows integrated on one workline', () => {
  it('/status → close → /workers → close → /clear leaves exactly three framed system lines and nothing in the chat stream', async () => {
    const { view, completeTurn } = await open();
    await type(view, '/status\r');
    await until(() => view.stdout.frame.includes('▸ Runtime service'), 'status window');
    expect(captured.entries).toEqual([]);
    view.stdin.write(ESC); await until(() => summaries().length === 1, 'status summary');
    await settle(40); await type(view, '/workers\r');
    await until(() => view.stdout.frame.includes('worker 1'), 'workers window');
    expect(summaries()).toHaveLength(1);
    view.stdin.write(ESC); await until(() => summaries().length === 2, 'workers summary');
    await settle(40); await type(view, '/clear\r');
    await until(() => summaries().length === 3, 'clear summary');
    await settle(60);
    // Exactly the three closed-window lines, in order, and no other scrollback row at all: no `Info:` notice, no chat row, no card.
    expect(captured.entries.map(entry => entry.kind === 'notice' ? `${entry.id}:${entry.level}:${entry.text}` : entry.kind)).toEqual([
      expect.stringMatching(/^system-summary:info:Status: /u), 'system-summary:info:Workers (live, worker-reported activity): 1', 'system-summary:info:New conversation started.']);
    expect(view.stdout.text).not.toContain('Info:');
    expect(view.stdout.frame).toContain(`${MARK} · New conversation started.`);
    expect(completeTurn).not.toHaveBeenCalled();
  });

  it('a typed argument is ignored in the rich terminal: /status extra opens the same window (integration D1)', async () => {
    const { view } = await open();
    await type(view, '/status extra words\r');
    await until(() => view.stdout.frame.includes('▸ Runtime service'), 'status window despite the argument');
    expect(view.stdout.text).not.toContain('Terminal: stdin yes\n');
    view.stdin.write(ESC); await until(() => summaries().length === 1, 'one summary');
  });

  it('an unknown command offers every command; picking it opens the /help window, which lists the whole registry', async () => {
    const { view, info } = await open();
    await type(view, '/qqqqzzzz \r');
    await until(() => view.stdout.frame.includes(WINDOWS.unknown.all), 'all-commands row');
    view.stdin.write('\r');
    await until(() => view.stdout.frame.includes(terminalComposerLabels('en').slash['terminal.slash.helpTitle']!) && !view.stdout.frame.includes(WINDOWS.unknown.title), '/help window');
    view.stdin.write(ESC); await until(() => summaries().length === 1, 'help summary');
    expect(summaries()[0]).toMatchObject({ text: `Help: ${WORKLINE_SLASH_COMMANDS.length} commands` });
    // The window's model lists every registry command once, the commands SW-3 turned into windows included.
    const model = helpInfoModel(terminalComposerLabels('en').slash, info.labels);
    const listed = model.sections.flatMap(section => section.choices?.map(choice => choice.id) ?? []);
    expect([...listed].sort()).toEqual(WORKLINE_SLASH_COMMANDS.map(command => command.name).sort());
    for (const name of ['clear', 'reasoning', 'mode', 'resume', 'scratch']) expect(listed, name).toContain(name);
  });
});
