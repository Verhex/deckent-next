import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { main } from '#surfaces/core/cli/index.js';

it.each(['en', 'tr'] as const)('renders the approved compact %s golden through main', async language => {
  let output = ''; let errors = '';
  const code = await main(['--help', '--lang', language], {
    env: { DECKENT_LANG: language, NO_COLOR: '1' },
    stdout: { write: text => { output += text; } }, stderr: { write: text => { errors += text; } },
  });
  expect(code).toBe(0); expect(errors).toBe('');
  expect(output).toBe(readFileSync(new URL(`../../fixtures/cli-help/top-${language}.txt`, import.meta.url), 'utf8'));
  expect(output.trimEnd().split('\n').length).toBeLessThanOrEqual(30);
  expect(output.split('\n').every(line => [...line].length <= 80)).toBe(true);
});

import { CLI_COMMANDS } from '#surfaces/core/cli/index.js';
import { CLI_CATALOG, HELP_GROUPS, renderTopHelp, renderCommandHelp, registerCliCommands, wrapHelp } from '#surfaces/core/cli-kit/index.js';
import { MESSAGE_REGISTRY } from '#platform/index.js';
import { displayWidth } from '#surfaces/core/terminal-composer/index.js';

it('requires a purpose group, en/tr summary and detail for every dispatch registration', () => {
  expect(new Set(CLI_COMMANDS.map(command => command.path.join(' '))).size).toBe(CLI_COMMANDS.length);
  for (const command of CLI_COMMANDS) {
    expect(HELP_GROUPS, command.path.join(' ')).toContain(command.group);
    expect(command.run).toBeTypeOf('function');
    for (const locale of ['en', 'tr'] as const) {
      const catalog = MESSAGE_REGISTRY.catalogs[locale];
      expect(catalog[command.summary], command.path.join(' ')).toBeTypeOf('string');
      expect(catalog[command.summary]!.trim()).not.toBe('');
      expect(catalog[command.summary]).not.toMatch(/[\n\r]/);
      expect(catalog[command.summary]).not.toContain(String.fromCharCode(27));
      expect(catalog[command.detail]?.trim(), command.path.join(' ')).toBeTruthy();
      expect(catalog[`cli.help.group.${command.group}`]).toBeTypeOf('string');
    }
  }
});

it.each(['en', 'tr'] as const)('every registered command has side-effect-free %s sub-help and a golden', async language => {
  const golden: Record<string, string> = {};
  for (const command of CLI_COMMANDS) {
    let output = ''; let initialized = false;
    const code = await main([...command.path, '--help', '--lang', language], {
      env: { DECKENT_LANG: language, NO_COLOR: '1' },
      initialize: () => { initialized = true; throw new Error('help initialized execution'); },
      stdout: { write: text => { output += text; } },
      stderr: { write: () => { throw new Error('help wrote an error'); } },
    });
    expect(code, command.path.join(' ')).toBe(0);
    expect(initialized).toBe(false);
    expect(output).not.toContain(String.fromCharCode(27));
    expect(output).toContain(MESSAGE_REGISTRY.catalogs[language][command.summary]);
    for (const line of output.split('\n')) expect(displayWidth(line), `${command.path.join(' ')}: ${line}`).toBeLessThanOrEqual(80);
    golden[command.path.join(' ')] = output;
  }
  await expect(JSON.stringify(golden, null, 2) + '\n').toMatchFileSnapshot(`../../fixtures/cli-help/commands-${language}.json`);
});

it.each(['en', 'tr'] as const)('keeps developer commands discoverable in %s with --all', async language => {
  let output = '';
  expect(await main(['--help', '--all', '--lang', language], {
    stdout: { write: text => { output += text; } }, initialize: () => { throw new Error('initialized'); },
  })).toBe(0);
  const ordinary = renderTopHelp(language);
  for (const command of CLI_CATALOG) {
    expect(output).toContain(`  ${command.name.padEnd(12)}`);
    if (command.group === 'developer') expect(ordinary).not.toContain(`  ${command.name.padEnd(12)}`);
  }
  for (const line of output.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  await expect(output).toMatchFileSnapshot(`../../fixtures/cli-help/all-${language}.txt`);
});

it('derives placement from registration metadata rather than a renderer command list', () => {
  const added = { ...CLI_CATALOG[0], name: 'new-command', group: 'work' as const };
  const output = renderTopHelp('tr', false, [...CLI_CATALOG, added]);
  expect(output.indexOf('  new-command')).toBeGreaterThan(output.indexOf('İş yürütme:'));
  expect(output.indexOf('  new-command')).toBeLessThan(output.indexOf('Modeller:'));
  const handlers = Object.fromEntries(CLI_CATALOG.map(command => [command.name, async () => undefined]));
  const bound = registerCliCommands(handlers as Parameters<typeof registerCliCommands>[0]);
  for (const entry of bound) expect(entry.run).toBe(handlers[entry.path[0]!]);
});

it.each([{ argv: [] }, { argv: ['-h'] }, { argv: ['--help'] }])('honors the environment locale in piped help: %j', async ({ argv }) => {
  let output = '';
  expect(await main(argv, { env: { DECKENT_LANG: 'tr', TERM: 'dumb' }, stdout: { write: text => { output += text; } } })).toBe(0);
  expect(output).toContain('Kullanım: deckent');
});


it('enforces 80 display columns independently of golden matching', () => {
  for (const locale of ['en', 'tr'] as const) for (const all of [false, true]) {
    for (const line of renderTopHelp(locale, all).split('\n')) expect(displayWidth(line), line).toBeLessThanOrEqual(80);
  }
});

it.each(['run', 'task'])('preserves existing %s unknown-action help and extra-flag refusal', async family => {
  let output = '';
  const context = { stdout: { write: (text: string) => { output += text; } }, stderr: { write: () => undefined } };
  expect(await main([family, 'unknown-action', '--help'], context)).toBe(0);
  expect(output).toContain('Usage: deckent ' + family);
  expect(await main([family, '--help', '--json'], context)).toBe(2);
});

it('keeps the same command inventory in both localized golden sets', () => {
  const load = (locale: string) => JSON.parse(readFileSync(new URL(`../../fixtures/cli-help/commands-${locale}.json`, import.meta.url), 'utf8')) as Record<string, string>;
  expect(Object.keys(load('en'))).toEqual(Object.keys(load('tr')));
  expect(Object.keys(load('en'))).toEqual(CLI_COMMANDS.map(command => command.path.join(' ')));
});

it.each(['en', 'tr'] as const)('keeps %s syntax whole and creates no short wrapping orphans', language => {
  const catalog = MESSAGE_REGISTRY.catalogs[language];
  for (const command of CLI_COMMANDS) {
    // Original short headings, summaries and complete command lines are intentional.
    const sourceLines = new Set([
      ...catalog[command.detail]!.split('\n').map(line => line.replace(/ ?\[--(?:json|no-color|lang [^\]]+)\]/g, '').trim()),
      catalog[command.summary], catalog['cli.help.heading.commands'],
      ...(command.parent ? [`deckent ${command.path.join(' ')}`, catalog[command.parent.summary]] : []),
      ...(command.children ?? []).map(child => `${child.name} ${catalog[child.summary]}`),
    ]);
    for (const line of renderCommandHelp(command, language).split('\n')) {
      const label = `${language} ${command.path.join(' ')}: ${line}`;
      expect(line, label).not.toMatch(/\[[^\]]*$|<[^>]*$/);
      // Complete syntax-only continuations (e.g. [--reason <text>]) are not prose orphans.
      const syntaxOnly = /^(?:\[[^\]]+\]|--[\w-]+|<[^>]+>)(?:\s+(?:\[[^\]]+\]|--[\w-]+|<[^>]+>))*$/.test(line.trim());
      if (!syntaxOnly && line.trim() && line.trim().split(/[\s|]+/).length <= 3) expect(sourceLines.has(line.trim().replace(/\s+/g, ' ')), label).toBe(true);
    }
  }
});

it('preserves intentional blank lines and list items while keeping tokens and prose readable', () => {
  expect(wrapHelp('First paragraph.\n\n  - First item\n  - Second item')).toBe('First paragraph.\n\n  - First item\n  - Second item');
  const output = wrapHelp('Use the pool with [--reason <some text>] to explain why it should pause.', 45);
  expect(output).toContain('[--reason <some text>]');
  expect(output.split('\n').every(line => line.trim().split(/\s+/).length > 3)).toBe(true);
  expect(output.split(/\s+/).join(' ')).toBe('Use the pool with [--reason <some text>] to explain why it should pause.');
});

it.each(['cli.help.modelsCatalog', 'cli.help.modelsBinding'] as const)('keeps en/tr synopsis syntax in parity for %s', key => {
  const syntax = (text: string) => text.split('\n').filter(line => line.includes('deckent '))
    .map(line => line.replace(/^[^:]+: /, '').trim().replace(/<[^>]+>/g, '<value>'));
  expect(syntax(MESSAGE_REGISTRY.catalogs.tr[key]!)).toEqual(syntax(MESSAGE_REGISTRY.catalogs.en[key]!));
});

it.each(['en', 'tr'] as const)('uses only command-specific examples in %s sub-help', language => {
  for (const command of CLI_COMMANDS) expect(renderCommandHelp(command, language)).not.toContain(MESSAGE_REGISTRY.catalogs[language]['cli.help.examples']);
});

it.each(['en', 'tr'] as const)('shows the terminal-specific example in %s and omits absent examples', language => {
  const terminal = CLI_COMMANDS.find(command => command.path.join(' ') === 'terminal')!;
  expect(renderCommandHelp(terminal, language)).toContain('deckent terminal status');
  const pool = CLI_COMMANDS.find(command => command.path.join(' ') === 'pool')!;
  expect(renderCommandHelp(pool, language)).not.toMatch(/Examples:|Örnekler:/);
});

it('removes unused help headings in both locales', () => {
  for (const language of ['en', 'tr'] as const) for (const heading of ['arguments', 'global_options', 'options', 'usage']) {
    expect(MESSAGE_REGISTRY.catalogs[language]).not.toHaveProperty(`cli.help.heading.${heading}`);
  }
});
