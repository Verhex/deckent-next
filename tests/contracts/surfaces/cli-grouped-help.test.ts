import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { main } from '#surfaces/core/cli/index.js';

it.each(['en', 'tr'] as const)('renders the detailed %s main help golden through main (owner 2026-10-19: 100–150 lines)', async language => {
  let output = ''; let errors = '';
  const code = await main(['--help', '--lang', language], {
    env: { DECKENT_LANG: language, NO_COLOR: '1' },
    stdout: { write: text => { output += text; } }, stderr: { write: text => { errors += text; } },
  });
  expect(code).toBe(0); expect(errors).toBe('');
  await expect(output).toMatchFileSnapshot(`../../fixtures/cli-help/top-${language}.txt`);
  const lines = output.trimEnd().split('\n').length;
  expect(lines).toBeGreaterThanOrEqual(100); expect(lines).toBeLessThanOrEqual(150);
  expect(output.split('\n').every(line => [...line].length <= 80)).toBe(true);
});

import { CLI_COMMANDS } from '#surfaces/core/cli/index.js';
import { CLI_CATALOG, HELP_GROUPS, renderTopHelp, renderCommandHelp, registerCliCommands, wrapHelp, catalogDispatch, hasCliAction, type CliCommandSpec } from '#surfaces/core/cli-kit/index.js';
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

it.each(['en', 'tr'] as const)('shows every command, its actions and synopsis in the %s main help; --all is retired and side-effect free', async language => {
  let output = '', plain = '';
  const context = (sink: (text: string) => void) => ({ env: { NO_COLOR: '1' }, stdout: { write: sink }, initialize: () => { throw new Error('initialized'); } });
  expect(await main(['--help', '--all', '--lang', language], context(text => { output += text; }))).toBe(0);
  expect(await main(['--help', '--lang', language], context(text => { plain += text; }))).toBe(0);
  expect(output).toBe(plain);
  const catalog = MESSAGE_REGISTRY.catalogs[language];
  for (const command of CLI_CATALOG as readonly CliCommandSpec[]) {
    expect(output).toContain(`  ${command.name.padEnd(12)}`);
    for (const child of command.children ?? []) if (!child.planned) expect(output, `${command.name} ${child.name}`).toMatch(new RegExp(`[ |]${child.name}(?=[ |\\n])`));
  }
  for (const heading of ['cli.help.group.developer', 'cli.help.top.surfaces', 'cli.help.top.options'] as const) expect(output).toContain(catalog[heading]!.split('\n')[0]);
  expect(output).toContain('deckent-mcp');
  expect(output).not.toContain('--help --all');
});

it('derives placement from registration metadata rather than a renderer command list', async () => {
  const added = { ...CLI_CATALOG[0], name: 'new-command', group: 'work' as const };
  const output = renderTopHelp('tr', [...CLI_CATALOG, added]);
  expect(output.indexOf('  new-command')).toBeGreaterThan(output.indexOf('İş yürütme:'));
  expect(output.indexOf('  new-command')).toBeLessThan(output.indexOf('Modeller:'));
  const calls: string[][] = [];
  const handlers = Object.fromEntries(CLI_CATALOG.map(command => [command.name, async (argv: readonly string[]) => { calls.push([...argv]); }]));
  const bound = registerCliCommands(handlers as Parameters<typeof registerCliCommands>[0]);
  // Every registered path reaches its own family handler with argv unchanged (a full action path is never rewritten).
  for (const entry of bound.filter(item => item.path.length > 1)) {
    calls.length = 0;
    await entry.run([...entry.path, '--json'], {});
    expect(calls, entry.path.join(' ')).toEqual([[...entry.path, '--json']]);
  }
});

it.each([{ argv: [] }, { argv: ['-h'] }, { argv: ['--help'] }])('honors the environment locale in piped help: %j', async ({ argv }) => {
  let output = '';
  expect(await main(argv, { env: { DECKENT_LANG: 'tr', TERM: 'dumb' }, stdout: { write: text => { output += text; } } })).toBe(0);
  expect(output).toContain('Kullanım: deckent');
});


it('enforces 80 display columns independently of golden matching', () => {
  for (const locale of ['en', 'tr'] as const) {
    for (const line of renderTopHelp(locale).split('\n')) expect(displayWidth(line), line).toBeLessThanOrEqual(80);
  }
});

it.each(['run', 'task'])('preserves existing %s unknown-action help and extra-flag refusal', async family => {
  let output = '';
  // Isolated from the host project and environment: the default (English) help is what is asserted.
  const context = { root: mkdtempSync(join(tmpdir(), 'deckent-cli-help-')), env: { NO_COLOR: '1' },
    stdout: { write: (text: string) => { output += text; } }, stderr: { write: () => undefined } };
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
      // S2: an action's "Required: …" line is an intentional heading of its own, however short.
      const required = ['cli.help.action.requires', 'cli.help.action.requiresOffTerminal'].some(key => line.startsWith(catalog[key]!.split('{')[0]!));
      if (!syntaxOnly && !required && line.trim() && line.trim().split(/[\s|]+/).length <= 3) expect(sourceLines.has(line.trim().replace(/\s+/g, ' ')), label).toBe(true);
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

/* Help = behaviour (owner 2026-10-19). Each family's handler sources, read for the action words they dispatch on. */
const HANDLER_SOURCES: Readonly<Record<string, readonly string[]>> = {
  audit: ['cli-admin/internal/audit.ts'], backup: ['cli-admin/internal/backup.ts'], terminal: ['cli-terminal/internal/terminal.ts'],
  init: ['cli-installation/internal/init.ts'], workers: ['cli-observe/internal/workers.ts'], run: ['cli-run/internal/run.ts', 'cli-run/internal/run-proposal.ts'],
  task: ['cli-task/internal/task.ts', 'delivery-queue/internal/cli.ts'], pool: ['cli-admin/internal/pool.ts'], decide: ['cli-decision/internal/command.ts'], memory: ['cli-memory/internal/command.ts'],
  models: ['cli-models/internal/models.ts', 'cli-models/internal/model-catalog.ts'], approval: ['cli-approval/internal/approvals.ts'],
  identity: ['cli-identity/internal/command.ts', 'cli-identity/internal/distribution.ts'],
  policy: ['cli/internal/entry.ts', 'cli-approval/internal/policy-grants.ts', 'cli-approval/internal/policy-delegations.ts', 'cli-approval/internal/policy-mcp.ts', 'cli-observe/internal/policy-vocabulary.ts'],
  config: ['config/internal/command.ts'], mcp: ['cli/internal/mcp.ts#mcpCommand'], secret: ['cli-admin/internal/secret.ts'], toolchains: ['cli-admin/internal/toolchains.ts'],
  runtime: ['cli-admin/internal/runtime.ts'], coding: ['cli-admin/internal/coding.ts', 'cli-admin/internal/worker-instructions.ts'], inference: ['cli-models/internal/inference.ts'], operation: ['cli-admin/internal/operation.ts'],
};
/** Action words a handler source dispatches on: `argv[1]|action|verb === 'x'`, `[...].includes(argv[1]|action)` and an `ACTIONS` list.
 * `file#name` reads only that exported function (a file that also holds a terminal slash handler with its own verbs). */
function handlerActions(family: string): Set<string> {
  const words = new Set<string>();
  for (const entry of HANDLER_SOURCES[family]!) {
    const [file, only] = entry.split('#') as [string, string | undefined];
    const whole = readFileSync(new URL(`../../../src/surfaces/core/${file}`, import.meta.url), 'utf8');
    const from = only ? whole.indexOf(`function ${only}(`) : 0, to = only ? whole.indexOf('\nexport ', from) : -1;
    expect(from, entry).toBeGreaterThanOrEqual(0);
    const source = whole.slice(from, to < 0 ? undefined : to);
    const lists = [...source.matchAll(/\[([^[\]]*)\]\.includes\((?:argv\[1\]|action|verb)/g), ...source.matchAll(/ACTIONS[^=]*=\s*\[([^\]]*)\]/g)].map(match => match[1]!);
    const compared = [...source.matchAll(/(?:argv\[1\]|\baction|\bverb|\.action)\s*[!=]==\s*('[^']*')/g)].map(match => match[1]!);
    for (const text of [...lists, ...compared]) for (const [, word] of text.matchAll(/'([a-z][a-z-]*)'/g)) words.add(word!);
  }
  return words;
}
const catalogActions = (spec: CliCommandSpec): string[] => (spec.children ?? []).filter(child => !child.planned).flatMap(child => [child.name, ...catalogActions(child)]);

it.each(CLI_CATALOG.filter(command => command.children).map(command => command.name))('dispatches exactly the catalog actions of %s (both directions)', family => {
  const spec = CLI_CATALOG.find(command => command.name === family)! as CliCommandSpec;
  expect([...handlerActions(family)].sort(), `${family}: handler actions not in the catalog, or catalog actions no handler reads`).toEqual([...new Set(catalogActions(spec))].sort());
});

it('passes an action word to its handler unchanged and refuses a bare family by naming the missing argument (exit 2)', async () => {
  for (const spec of CLI_CATALOG.filter(command => command.children) as CliCommandSpec[]) {
    expect(catalogDispatch(spec, [spec.name, 'not-an-action'])).toEqual({ argv: [spec.name, 'not-an-action'] });
    for (const child of spec.children!.filter(item => !item.planned)) expect(catalogDispatch(spec, [spec.name, child.name, '--json'])).toEqual({ argv: [spec.name, child.name, '--json'] });
  }
  let errors = '';
  const context = { root: mkdtempSync(join(tmpdir(), 'deckent-cli-gate-')), env: { NO_COLOR: '1', DECKENT_LANG: 'en' }, stdout: { write: () => undefined }, stderr: { write: (text: string) => { errors += text; } } };
  // C-ADMIN: bare `backup` now lists the sets (handler-owned); `run` is a family that still has no runnable default.
  expect(await main(['run', '--json'], context)).toBe(2);
  expect(errors).toContain('Missing argument: <action>.');
  // J1b lead decision: a typed CLI_ARGUMENT_MISSING (usage category, exit 2), not the generic CLI_USAGE "Invalid … for …".
  expect(JSON.parse(errors)).toMatchObject({ code: 'CLI_ARGUMENT_MISSING' }); expect(errors).toContain('Incomplete command: deckent run.'); expect(errors).not.toContain('CLI_USAGE');
  expect(errors).toContain('Actions: list | create | propose');
  expect(errors).toContain('Details: deckent run --help');
});

it('keeps exactly the reviewed planned names out of dispatch and help until their slice implements them', async () => {
  const planned = (CLI_CATALOG as readonly CliCommandSpec[]).flatMap(spec => (spec.children ?? []).filter(child => child.planned).map(child => `${spec.name} ${child.name}`));
  expect(planned).toEqual([]);
  // C-APPROVE (alpha.48): `policy scopes` is implemented and dispatches.
  expect(hasCliAction('policy', 'scopes')).toBe(true); expect(CLI_COMMANDS.map(command => command.path.join(' '))).toContain('policy scopes');
  // C-RUN (alpha.48): `run list` is implemented (the CLI counterpart of `/runs`) and dispatches.
  expect(hasCliAction('run', 'list')).toBe(true); expect(CLI_COMMANDS.map(command => command.path.join(' '))).toContain('run list');
  for (const name of planned) {
    const [family, child] = name.split(' ') as [string, string];
    const spec = CLI_CATALOG.find(command => command.name === family)! as CliCommandSpec;
    expect(CLI_COMMANDS.map(command => command.path.join(' '))).not.toContain(name);
    expect(renderTopHelp('en', [spec])).not.toMatch(new RegExp(`[ |]${child}(?=[ |\\n]|$)`));
    expect(renderCommandHelp(CLI_COMMANDS.find(command => command.path.join(' ') === family)!, 'en')).not.toMatch(new RegExp(`^  ${child} `, 'm'));
  }
});

/** The reviewed read-only defaults (owner 2026-10-19 CLI review): a new default needs the same review (stop: a default would mutate). */
const READ_DEFAULTS = { audit: 'verify', workers: 'list', pool: 'status', policy: 'status', approval: 'list', secret: 'list', runtime: 'describe' };

it('runs only the reviewed read action when a family is called without one', async () => {
  const reads = Object.fromEntries((CLI_CATALOG as readonly CliCommandSpec[]).flatMap(spec => spec.bare && spec.bare !== 'handler' && spec.bare.read ? [[spec.name, spec.bare.read]] : []));
  expect(reads).toEqual(READ_DEFAULTS);
  const calls: string[][] = [];
  const handlers = Object.fromEntries(CLI_CATALOG.map(command => [command.name, async (argv: readonly string[]) => { calls.push([...argv]); }]));
  const bound = registerCliCommands(handlers as Parameters<typeof registerCliCommands>[0]);
  const family = (name: string) => bound.find(entry => entry.path.join(' ') === name)!;
  for (const [name, read] of Object.entries(READ_DEFAULTS)) {
    const flags = name === 'workers' ? ['--scope', 'live'] : [];
    calls.length = 0; await family(name).run([name, ...flags, '--lang', 'tr'], {});
    expect(calls, name).toEqual([[name, read, ...flags, '--lang', 'tr']]);
  }
  // A family that acts on its own keeps its argv; flags with values never turn into a default action.
  for (const argv of [['terminal'], ['init'], ['models', '--json'], ['identity'], ['mcp'], ['config'], ['doctor'], ['monitor', '--once'], ['policy', '--json', 'vocabulary'], ['inventory', '--scope', 'live']]) {
    calls.length = 0; await family(argv[0]!).run(argv, {});
    expect(calls, argv.join(' ')).toEqual([argv]);
  }
});

it.each(['en', 'tr'] as const)('names the missing argument for every family without a runnable default (%s, exit 2, never the bare usage)', async language => {
  // C-RUN: bare `report` and `inventory` are handler-owned reads (default scope; off a terminal without one: CLI_SCOPE_REQUIRED, below).
  // C-DOCTOR: bare `workers` reads the default scope (no `--scope` required by the catalog).
  const runnable = new Set([...Object.keys(READ_DEFAULTS), 'terminal', 'init', 'models', 'identity', 'mcp', 'config', 'monitor', 'doctor', 'paths',
    'coding', 'inference', 'operation', 'report', 'inventory', 'decide', 'memory', 'backup', 'toolchains']);
  const catalog = MESSAGE_REGISTRY.catalogs[language];
  for (const spec of (CLI_CATALOG as readonly CliCommandSpec[]).filter(item => !runnable.has(item.name))) {
    let errors = '';
    const code = await main([spec.name], { root: mkdtempSync(join(tmpdir(), 'deckent-cli-bare-')), env: { NO_COLOR: '1', DECKENT_LANG: language },
      initialize: () => undefined, stdout: { write: () => undefined }, stderr: { write: (text: string) => { errors += text; } } });
    expect(code, spec.name).toBe(2);
    const missing = spec.bare && spec.bare !== 'handler' && spec.bare.requires?.length ? spec.bare.requires[0]!.split(' ')[0]! : `<${catalog['cli.help.placeholder.action']}>`;
    expect(errors, spec.name).toContain(catalog['cli.help.bare.missing']!.split('{')[0]!);
    expect(errors, spec.name).toContain(missing);
    expect(errors, spec.name).toContain(`deckent ${spec.name} --help`);
  }
});

it('J1b: the composition signal list and the usage echo read the one catalog (no hand-kept action inventory drifts from help)', async () => {
  const { SIGNAL_COMMANDS } = await import('#composition/core/cli/index.js');
  const { cliUsage } = await import('#surfaces/core/cli-kit/internal/usage.js');
  for (const [family, action] of [...SIGNAL_COMMANDS, ['runtime', 'serve'] as const]) {
    expect(CLI_CATALOG.some(spec => spec.name === family), family).toBe(true);
    if (action !== undefined) expect(hasCliAction(family as Parameters<typeof hasCliAction>[0], action), `${family} ${action}`).toBe(true);
  }
  // A catalog action is echoed in the usage error; any other word never is (only protocol names reach diagnostics).
  expect(cliUsage('task', 'integration-adopt', 'en').params).toMatchObject({ command: 'deckent task integration-adopt' });
  expect(cliUsage('run', 'cancel', 'en').params).toMatchObject({ command: 'deckent run cancel' });
  expect(cliUsage('run', 'secret-value', 'en').params).toMatchObject({ command: 'deckent run' });
  expect(cliUsage('run', 'list', 'en').params).toMatchObject({ command: 'deckent run list' }); // C-RUN: an action now
});

it.each(['report', 'inventory'])('C-RUN: bare %s off a terminal with no scope and no configured default names the valid scopes (CLI_SCOPE_REQUIRED, exit 2)', async family => {
  let errors = '';
  const root = mkdtempSync(join(tmpdir(), 'deckent-cli-bare-read-'));
  const code = await main([family, '--json'], { root, env: { NO_COLOR: '1', DECKENT_LANG: 'en', HOME: root, USERPROFILE: root }, initialize: () => undefined,
    stdout: { write: () => undefined }, stderr: { write: (text: string) => { errors += text; } } });
  expect(code).toBe(2); expect(JSON.parse(errors)).toMatchObject({ code: 'CLI_SCOPE_REQUIRED' });
});
