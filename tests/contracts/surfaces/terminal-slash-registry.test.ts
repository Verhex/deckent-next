import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSlashLine, WORKLINE_SLASH_COMMANDS, type WorklineProps } from '#surfaces/core/terminal/index.js';
import { movedSlashCommand, slashCommandRow, slashHelpText, SLASH_GROUPS, SLASH_HELP_TITLE_KEY, SLASH_MOVED, SLASH_RESERVED } from '#surfaces/core/terminal-kit/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { SLASH_WINDOW_TEST_LABELS } from '../support/slash-window-labels.js';
import { paletteCommand } from '#surfaces/core/terminal-composer/index.js';
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
    expect(WORKLINE_SLASH_COMMANDS.some(cmd => cmd.name === 'runs')).toBe(true);
    expect(WORKLINE_SLASH_COMMANDS.some(cmd => cmd.name === 'deliver')).toBe(true);
  });

  it('K1/K2/K8: one name registry — moved and reserved names are disjoint from live ones, every move lands on a live command, names are unique', () => {
    const live = new Set(WORKLINE_SLASH_COMMANDS.map(command => command.name));
    expect(live.size).toBe(WORKLINE_SLASH_COMMANDS.length);
    expect(Object.keys(SLASH_MOVED).sort()).toEqual(['cancel', 'quit', 'run', 'tasks', 'transcript', 'watch-runs', 'watch-stop', 'watch-workers', 'workers']);
    for (const [old, now] of Object.entries(SLASH_MOVED)) { expect(live.has(old)).toBe(false); expect(live.has(now)).toBe(true); expect(movedSlashCommand(old)).toBe(now); }
    for (const name of SLASH_RESERVED) { expect(live.has(name)).toBe(false); expect(movedSlashCommand(name)).toBeNull(); }
    expect(SLASH_RESERVED).toContain('plan');
    expect(movedSlashCommand('runs')).toBeNull(); expect(movedSlashCommand('constructor')).toBeNull(); expect(movedSlashCommand('__proto__')).toBeNull();
  });

  it('every slash name the terminal sources dispatch on is a registry name, a moved name, or a named internal one (no surface name outside the registry)', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const roots = ['src/surfaces/core/terminal/internal', 'src/surfaces/core/terminal-work/internal', 'src/surfaces/core/terminal-delivery/internal'];
    const names = new Set<string>();
    for (const root of roots) for (const file of await readdir(root)) {
      if (!/\.tsx?$/u.test(file)) continue;
      const text = await readFile(join(root, file), 'utf8');
      for (const match of text.matchAll(/(?:slash\.command|command) === '([a-z][a-z-]*)'/gu)) names.add(match[1]!);
      for (const match of text.matchAll(/performRef\.current\('\/([a-z][a-z-]*)'/gu)) names.add(match[1]!);
    }
    // The work surface's own card flow (`run('cancel', …)`, K4's `x`) is not a slash name.
    const internal = new Set(['cancel']), live = new Set(WORKLINE_SLASH_COMMANDS.map(command => command.name));
    expect([...names].filter(name => !live.has(name) && !internal.has(name)).sort()).toEqual([]);
    expect(names.has('runs')).toBe(true);
  });

  it.each(['en', 'tr'] as const)('%s labels cover exactly the registry description and argument keys, including mcp/config', locale => {
    const labels = terminalComposerLabels(locale).slash;
    const keys = [...new Set([...WORKLINE_SLASH_COMMANDS.flatMap(command => [command.descriptionKey, ...(command.argumentKey ? [command.argumentKey] : [])]), ...SLASH_GROUPS.map(group => group.labelKey), SLASH_HELP_TITLE_KEY])];
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
    expect(parseSlashLine(' /APPROVALS  a-1  extra ')).toEqual({ command: 'approvals', args: 'a-1  extra' });
    expect(parseSlashLine('/QuIt now')).toEqual({ command: 'quit', args: 'now' });
    const approvals = WORKLINE_SLASH_COMMANDS.find(command => command.name === 'approvals')!;
    expect(slashCommandRow(approvals, {})).toEqual({ name: '/approvals', detail: '' });
    const en = terminalComposerLabels('en').slash, tr = terminalComposerLabels('tr').slash;
    expect(slashCommandRow(approvals, en).name).toBe(`/approvals ${en['terminal.slash.approvalsArgument']}`);
    expect(slashCommandRow(approvals, tr).name).toBe(`/approvals ${tr['terminal.slash.approvalsArgument']}`);
    // K8: `/quit` left the registry (its row duplicated `/exit`); typed, it is a moved name.
    expect(WORKLINE_SLASH_COMMANDS.find(command => command.name === 'quit')).toBeUndefined();
    expect(approvals).toEqual({ name: 'approvals', group: 'approvals', descriptionKey: 'terminal.slash.approvals', argumentKey: 'terminal.slash.approvalsArgument' });
  });

  it.each(['en', 'tr'] as const)('%s actual palette and /help show the same registry rows', async locale => {
    const composer = terminalComposerLabels(locale);
    const view = await open({ labels: { ...WORKLINE_TEST_LABELS, composer } });
    // Every row is selected by its exact prefix through the real composer, including the injected unhandled row.
    for (const command of WORKLINE_SLASH_COMMANDS) {
      await type(view, `/${command.name}`);
      // The palette row carries no argument hint (SLASH-WINDOWS); /help keeps the registry's full row below.
      const row = slashCommandRow(paletteCommand(command), composer.slash);
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
    expect(help.split('\n')[0]).toBe(composer.slash['terminal.slash.helpTitle']);
    const listed = help.split('\n').filter(line => line.startsWith('  /')).map(line => line.trim().split(' ')[0]);
    expect([...listed].sort()).toEqual(WORKLINE_SLASH_COMMANDS.map(command => `/${command.name}`).sort());
    expect(help.split('\n').slice(1).join('\n').split('\n\n').map(section => section.split('\n')[0])).toEqual(['group.info', 'group.work', 'group.approvals', 'group.settings', 'group.session', 'group.other'].map(key => composer.slash[`terminal.slash.${key}`]));
  });

  it('a registered but unhandled command remains unknown and never reaches the chat producer', async () => {
    const completeTurn = vi.fn(async () => 'unexpected');
    const view = await open({ completeTurn });
    await type(view, '/registered-unhandled arg\r');
    await until(() => view.stdout.text.includes('UNKNOWN: /registered-unhandled'), 'unhandled refusal');
    expect(completeTurn).not.toHaveBeenCalled();
  });

  it.each(WORKLINE_SLASH_COMMANDS.filter(command => !['exit', 'registered-unhandled'].includes(command.name)))('existing /$name dispatch remains handled, even with unavailable ports', async command => {
    const completeTurn = vi.fn(async () => 'unexpected');
    const view = await open({ completeTurn });
    // A trailing space closes the palette, so arg-less commands submit literally rather than selecting a different row. A command that answers in
    // a window (SLASH-WINDOWS) holds the input line until Esc closes it; Esc on an empty composer changes nothing.
    await type(view, `/${command.name}${command.argumentKey ? ' fixture-id' : ' '}\r`);
    await settle(60); view.stdin.write('\u001B'); await settle(60);
    await type(view, '/status \r');
    await until(() => view.stdout.text.includes('STATUS-LINE'), `dispatch ${command.name} then status`);
    expect(view.stdout.text).not.toContain('UNKNOWN');
    if (command.name === 'do') {
      expect(view.stdout.text).toContain('NO-PORT do');
      expect(view.stdout.text).not.toContain('NO-PORT {part}');
    }
    expect(completeTurn).not.toHaveBeenCalled();
  });

});

describe('terminal slash registry: exit and moved names (K2/K8)', () => {
  it('/exit closes through the existing exit handler without a chat turn', async () => {
    const completeTurn = vi.fn(async () => 'unexpected');
    const view = await open({ completeTurn });
    await type(view, '/exit\r');
    await view.instance.waitUntilExit();
    expect(completeTurn).not.toHaveBeenCalled();
  });

  it.each([['quit', 'exit'], ['tasks', 'runs'], ['cancel', 'runs']])('K2 without window words: /%s names its new command, never runs and never reaches the chat producer', async (old, now) => {
    const completeTurn = vi.fn(async () => 'unexpected');
    const view = await open({ completeTurn });
    let exited = false; void view.instance.waitUntilExit().then(() => { exited = true; });
    await type(view, `/${old}\r`);
    await until(() => view.stdout.text.includes(`MOVED /${old} /${now}`), 'moved notice');
    await settle(60); expect(exited).toBe(false); expect(completeTurn).not.toHaveBeenCalled();
  });

  it.each([['tasks', 'runs', 'Runs (live)'], ['quit', 'exit', null]])('K2 rich terminal: /%s opens the unknown window with "Moved: /%s" as the selected first row; Enter runs it', async (old, now, opened) => {
    const completeTurn = vi.fn(async () => 'unexpected');
    const view = await open({ completeTurn, labels: { ...WORKLINE_TEST_LABELS, windows: SLASH_WINDOW_TEST_LABELS, work: workSurfaceLabels('en'),
      composer: { ...WORKLINE_TEST_LABELS.composer, slash: terminalComposerLabels('en').slash } },
      ledger: { scopeId: 's', async listWorkers() { return { schemaVersion: 1, scopeId: 's', sources: [] } as never; }, async inspectRun() { return null; } } });
    let exited = false; void view.instance.waitUntilExit().then(() => { exited = true; });
    await type(view, `/${old}\r`);
    await until(() => view.stdout.frame.includes(`/${old} moved to /${now}.`) && view.stdout.frame.includes(`Moved: /${now}`), 'moved window');
    expect(view.stdout.frame).toMatch(new RegExp(`[›>]\\s+Moved: /${now}`, 'u'));
    await settle(60); view.stdin.write('\r');
    if (opened) await until(() => view.stdout.frame.includes(opened), 'the new command ran');
    else await until(() => exited, 'the new command ran');
    expect(completeTurn).not.toHaveBeenCalled();
  });

  it('Enter on a bare /runs runs it at once (no typed argument) and /config and /mcp still forward typed arguments in text mode', async () => {
    const config = vi.fn(async (args: string) => [`CONFIG-READ ${args}`]), mcp = vi.fn(async (args: string) => [`MCP-READ ${args}`]);
    const inspectRun = vi.fn(async () => null);
    const view = await open({ config, mcp, labels: { ...WORKLINE_TEST_LABELS, composer: terminalComposerLabels('tr') },
      ledger: { scopeId: 's', async listWorkers() { return { schemaVersion: 1, scopeId: 's', sources: [] } as never; }, inspectRun } });
    await type(view, '/ru\r');
    // SW-2/K1: the bare command answers at once in its window (its runs tab says "not wired": this ledger cannot list runs); Esc closes it.
    await until(() => view.stdout.frame.includes('UNWIRED'), 'bare /runs runs at once and answers in its window');
    expect(view.stdout.frame).not.toContain('<run-kimliği>');
    expect(inspectRun).not.toHaveBeenCalled();
    await settle(40); view.stdin.write('\u001B'); await settle(60);
    await type(view, '/config terminal.chat\r/mcp reconnect server-1\r');
    await until(() => config.mock.calls.length === 1 && mcp.mock.calls.length === 1, 'config/mcp args');
    expect(config.mock.calls[0]).toEqual(['terminal.chat']);
    expect(mcp.mock.calls[0]).toEqual(['reconnect server-1']);
  });

  it.each([200, 55])('palette and help project complete labels before display cuts (%s columns)', async columns => {
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
