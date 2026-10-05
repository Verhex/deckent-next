import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSlashLine, WORKLINE_SLASH_COMMANDS, type WorklineProps } from '#surfaces/core/terminal/index.js';
import { slashCommandRow, slashHelpText } from '#surfaces/core/terminal-kit/index.js';
import { terminalComposerLabels } from '#surfaces/core/terminal-labels/index.js';
import { snapshotKnownSecrets, t } from '#platform/index.js';
import { mountWorkline, settle, until as harnessUntil, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

const until = (check: () => boolean, label: string) => harnessUntil(check, label, 200);

async function type(view: ReturnType<typeof mountWorkline>, text: string) {
  for (const char of text) { view.stdin.write(char); await settle(2); }
}

// Simulate registry/handler drift without adding a product handler or mutating the frozen production registry.
vi.mock('#surfaces/core/terminal-kit/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('#surfaces/core/terminal-kit/index.js')>();
  return { ...original, WORKLINE_SLASH_COMMANDS: Object.freeze([...original.WORKLINE_SLASH_COMMANDS,
    { name: 'registered-unhandled', descriptionKey: 'terminal.slash.help', argumentKey: 'terminal.slash.resumeArgument' }]) };
});

const views: Array<ReturnType<typeof mountWorkline>> = [];
afterEach(() => { for (const view of views.splice(0)) view.instance.unmount(); });
async function open(props: Partial<WorklineProps> = {}) {
  const view = mountWorkline(props);
  views.push(view);
  await until(() => view.stdout.frame.includes('READY'), 'workline ready');
  return view;
}

describe('terminal slash registry', () => {
  it('parses slash lines', () => {
    expect(parseSlashLine('/status')).toEqual({ command: 'status', args: '' });
    expect(parseSlashLine('  /help  ')).toEqual({ command: 'help', args: '' });
    expect(parseSlashLine('/exit now')).toEqual({ command: 'exit', args: 'now' });
    expect(parseSlashLine('hello')).toBeNull();
  });

  it('lists core commands', () => {
    expect(WORKLINE_SLASH_COMMANDS.some(cmd => cmd.name === 'help')).toBe(true);
    expect(WORKLINE_SLASH_COMMANDS.some(cmd => cmd.name === 'workers')).toBe(true);
    expect(WORKLINE_SLASH_COMMANDS.some(cmd => cmd.name === 'run')).toBe(true);
    expect(WORKLINE_SLASH_COMMANDS.some(cmd => cmd.name === 'runs')).toBe(true);
  });

  it.each(['en', 'tr'] as const)('%s labels cover exactly the registry description and argument keys, including mcp/config', locale => {
    const labels = terminalComposerLabels(locale).slash;
    const keys = [...new Set(WORKLINE_SLASH_COMMANDS.flatMap(command => [command.descriptionKey, ...(command.argumentKey ? [command.argumentKey] : [])]))];
    expect(Object.keys(labels).sort()).toEqual(keys.sort());
    for (const key of keys) {
      expect(labels[key]).toBe(t(key, {}, locale));
      expect(labels[key]).not.toBe(key);
      expect(labels[key]!.length).toBeGreaterThan(0);
      expect(labels[key]).not.toMatch(/\{\w+\}/u);
    }
    expect(labels['config.surface.slashDescription']).toBe(locale === 'en' ? 'Inspect configuration, sources and bindings' : 'Ayarları, kaynakları ve bağları incele');
    expect(labels['terminal.slash.mcp']).toBeTruthy();
  });

  it('formats presentation only: arguments and aliases retain their registry identity', () => {
    expect(parseSlashLine(' /RUN  r-1  extra ')).toEqual({ command: 'run', args: 'r-1  extra' });
    expect(parseSlashLine('/QuIt now')).toEqual({ command: 'quit', args: 'now' });
    const run = WORKLINE_SLASH_COMMANDS.find(command => command.name === 'run')!;
    expect(slashCommandRow(run, {})).toEqual({ name: '/run', detail: '' });
    const en = terminalComposerLabels('en').slash, tr = terminalComposerLabels('tr').slash;
    expect(slashCommandRow(run, en).name).toBe('/run <runId>');
    expect(slashCommandRow(run, tr).name).toBe('/run <run-kimliği>');
    for (const locale of ['en', 'tr'] as const) {
      const labels = terminalComposerLabels(locale).slash;
      const exit = slashCommandRow(WORKLINE_SLASH_COMMANDS.find(command => command.name === 'exit')!, labels);
      const quit = slashCommandRow(WORKLINE_SLASH_COMMANDS.find(command => command.name === 'quit')!, labels);
      expect(quit.detail).toBe(exit.detail);
      expect(quit.name).toBe('/quit');
    }
    expect(run).toEqual({ name: 'run', descriptionKey: 'terminal.slash.run', argumentKey: 'terminal.slash.runArgument' });
  });

  it.each(['en', 'tr'] as const)('%s actual palette and /help show the same registry rows', async locale => {
    const composer = terminalComposerLabels(locale);
    const view = await open({ labels: { ...WORKLINE_TEST_LABELS, composer } });
    // Every row is selected by its exact prefix through the real composer, including the injected unhandled row.
    for (const command of WORKLINE_SLASH_COMMANDS) {
      await type(view, `/${command.name}`);
      const row = slashCommandRow(command, composer.slash);
      await until(() => view.stdout.frame.includes(`> ${row.name}`) && view.stdout.frame.includes(row.detail), `palette ${locale}/${command.name}`);
      await type(view, '\u0015');
      await until(() => !view.stdout.frame.includes(`> ${row.name}`), 'clear draft');
    }
    const mark = view.stdout.text.length;
    await type(view, '/help\r');
    await until(() => view.stdout.text.slice(mark).includes(slashHelpText(composer.slash, WORKLINE_SLASH_COMMANDS)), 'complete help notice');
    for (const command of WORKLINE_SLASH_COMMANDS) {
      const row = slashCommandRow(command, composer.slash);
      expect(view.stdout.text.slice(mark)).toContain(`${row.name}  ${row.detail}`);
    }
    const help = slashHelpText(composer.slash, WORKLINE_SLASH_COMMANDS);
    expect(help.split('\n').map(line => line.split(' ')[0])).toEqual(WORKLINE_SLASH_COMMANDS.map(command => `/${command.name}`));
  });

  it('a registered but unhandled command remains unknown and never reaches the chat producer', async () => {
    const completeTurn = vi.fn(async () => 'unexpected');
    const view = await open({ completeTurn });
    await type(view, '/registered-unhandled arg\r');
    await until(() => view.stdout.text.includes('UNKNOWN: /registered-unhandled'), 'unhandled refusal');
    expect(completeTurn).not.toHaveBeenCalled();
  });

  it.each(WORKLINE_SLASH_COMMANDS.filter(command => !['exit', 'quit', 'registered-unhandled'].includes(command.name)))('existing /$name dispatch remains handled, even with unavailable ports', async command => {
    const completeTurn = vi.fn(async () => 'unexpected');
    const view = await open({ completeTurn });
    // A trailing space closes the palette, so arg-less commands submit literally rather than selecting a different row.
    await type(view, `/${command.name}${command.argumentKey ? ' fixture-id' : ' '}\r/status \r`);
    await until(() => view.stdout.text.includes('STATUS-LINE'), `dispatch ${command.name} then status`);
    expect(view.stdout.text).not.toContain('UNKNOWN');
    expect(completeTurn).not.toHaveBeenCalled();
  });

  it.each(['exit', 'quit'])('/%s closes through the existing exit handler without a chat turn', async command => {
    const completeTurn = vi.fn(async () => 'unexpected');
    const view = await open({ completeTurn });
    await type(view, `/${command}\r`);
    await view.instance.waitUntilExit();
    expect(completeTurn).not.toHaveBeenCalled();
  });

  it('argument completion waits and /config and /mcp forward their original arguments once', async () => {
    const config = vi.fn(async (args: string) => [`CONFIG-READ ${args}`]), mcp = vi.fn(async (args: string) => [`MCP-READ ${args}`]);
    const inspectRun = vi.fn(async (runId: string) => { expect(runId).toBe('r-1'); return null; });
    const view = await open({ config, mcp, labels: { ...WORKLINE_TEST_LABELS, composer: terminalComposerLabels('tr') },
      ledger: { scopeId: 's', async listWorkers() { return { schemaVersion: 1, scopeId: 's', sources: [] } as never; }, inspectRun } });
    await type(view, '/ru\r');
    await until(() => view.stdout.frame.includes('/run |<run-kimliği>'), 'argument hint after completion');
    expect(inspectRun).not.toHaveBeenCalled();
    await type(view, 'r-1\r');
    await until(() => inspectRun.mock.calls.length === 1, 'run with argument');
    expect(inspectRun.mock.calls[0]).toEqual(['r-1']);
    await type(view, '/config terminal.chat\r/mcp reconnect server-1\r');
    await until(() => config.mock.calls.length === 1 && mcp.mock.calls.length === 1, 'config/mcp args');
    expect(config.mock.calls[0]).toEqual(['terminal.chat']);
    expect(mcp.mock.calls[0]).toEqual(['reconnect server-1']);
  });

  it.each([200, 55])('palette, pending argument and help project complete labels before display cuts (%s columns)', async columns => {
    const canary = 'fictitious-s08-known-0123456789';
    const split = `${canary.slice(0, 12)}\u001b[31m${canary.slice(12)}`;
    const raw = `LABEL ${split} \u202e \u2066`;
    const composer = { ...terminalComposerLabels('tr'), slash: { ...terminalComposerLabels('tr').slash,
      'terminal.slash.help': raw, 'terminal.slash.runArgument': raw } };
    const props = { labels: { ...WORKLINE_TEST_LABELS, composer }, knownSecrets: snapshotKnownSecrets([{ name: 'S08_TEST', value: canary }]) };
    const view = mountWorkline(props, columns); views.push(view);
    await until(() => view.stdout.frame.includes('READY'), 'ready');
    await type(view, '/hel');
    await until(() => view.stdout.frame.includes('‹secret:S08_TEST›'), 'palette redacted');
    if (columns === 200) expect(view.stdout.frame).toContain('<U+202E> <U+2066>');
    await type(view, '\u0015/run ');
    await until(() => view.stdout.frame.includes('/run |LABEL ‹secret:S08_TEST›'), 'pending argument projected');
    await type(view, '\u0015/help\r');
    await until(() => view.stdout.text.includes('/help  LABEL ‹secret:S08_TEST›'), 'help projected');
    expect(view.stdout.text).toContain('<U+202E>');
    expect(view.stdout.text).toContain('<U+2066>');
    expect(view.stdout.text).not.toContain(canary);
    expect(view.stdout.text).not.toContain('\u202e');
    expect(view.stdout.text).not.toContain('\u2066');
    expect(view.stdout.text).not.toContain('\u001b[31m');
    expect(composer.slash['terminal.slash.help']).toBe(raw);
    await settle();
  });
});
