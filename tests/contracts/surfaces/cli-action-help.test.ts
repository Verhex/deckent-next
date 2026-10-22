import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { CLI_CATALOG, type CliCommandSpec } from '#surfaces/core/cli-kit/index.js';

const outputs: string[] = [];
afterEach(() => { outputs.length = 0; });

function context() {
  let initialized = 0;
  return { initialized: () => initialized, context: {
    // An empty project root: help language must not come from whatever project the suite is run in.
    root: mkdtempSync(join(tmpdir(), 'deckent-cli-help-')),
    env: { HOME: '/tmp/deckent-cli-help-test', NO_COLOR: '1' },
    stdout: { write(value: string) { outputs.push(value); } },
    stderr: { write(value: string) { outputs.push(value); } },
    initialize() { initialized++; },
    async createRun() { throw new Error('handler called'); },
    async reserveRunTasks() { throw new Error('handler called'); },
    async executeTask() { throw new Error('handler called'); },
    async evaluateTask() { throw new Error('handler called'); },
  } };
}

it.each([
  [['run', '--help'], 'Usage: deckent run', 'Run creation admits a graph'],
  [['run', '-h'], 'Usage: deckent run', 'Run creation admits a graph'],
  [['task', '--help'], 'Usage: deckent task', 'A terminal result alone is not acceptance'],
  [['task', '-h'], 'Usage: deckent task', 'A terminal result alone is not acceptance'],
] as const)('prints scoped English help without invoking handlers: %j', async (args, heading, detail) => {
  const f = context(); expect(await main(args, f.context)).toBe(0); expect(outputs.join('')).toContain(heading); expect(outputs.join('')).toContain(detail); expect(f.initialized()).toBe(0);
});

it('uses the environment locale for scoped Turkish help', async () => {
  const f = context(); f.context.env = { ...f.context.env, DECKENT_LANG: 'tr' };
  expect(await main(['task', '--help'], f.context)).toBe(0); expect(outputs.join('')).toContain('Kullanım: deckent task'); expect(outputs.join('')).toContain('Terminal sonucu tek başına kabul değildir.'); expect(f.initialized()).toBe(0);
});

it.each([
  [['run', '--help', '--lang', 'tr'], 'Kullanım: deckent run'],
  [['run', 'create', '--help'], 'Usage: deckent run <action>'],
  [['task', 'execute', '--help', '--lang', 'tr'], 'Kullanım: deckent task <eylem>'],
  [['secret', 'store', '--help', '--lang', 'en'], 'deckent secret store'],
  [['secret', 'store', '--help', '--lang', 'tr'], 'deckent secret store'],
] as const)('covers localized and action-scoped help: %j', async (args, heading) => {
  const f = context(); expect(await main(args, f.context)).toBe(0);
  const output = outputs.join(''); expect(output).toContain(heading);
  expect(output.split(/\r?\n/).every(line => line.length <= 80)).toBe(true);
  expect(f.initialized()).toBe(0);
});

it.each([['run', 'not-a-command'], ['task', 'not-a-command']] as const)('localizes invalid %s commands with an explicit language', async (family, action) => {
  const f = context(); expect(await main([family, action, '--lang', 'tr'], f.context)).toBe(2);
  expect(outputs.join('')).toContain('Kullanım: deckent'); expect(f.initialized()).toBe(1);
});

it('keeps extra help flags strict', async () => {
  const f = context(); expect(await main(['run', '--help', '--json'], f.context)).toBe(2); expect(f.initialized()).toBe(1);
});

it.each(['en', 'tr'] as const)('distinguishes each qualified resume and its owning family in %s', async language => {
  const summaries = language === 'en' ? {
    init: 'Resume an interrupted installation', run: 'Resume a parked Run', pool: 'Allow new pool task reservations',
  } : { init: 'Kesilen kurulumu sürdür', run: "Bekletilen Run'ı sürdür", pool: 'Havuzda yeni görev rezervasyonlarını aç' };
  for (const family of ['init', 'run', 'pool'] as const) {
    for (const alias of ['--help', '-h']) {
      let stdout = '', stderr = '', initialized = 0;
      const code = await main([family, 'resume', alias, '--lang', language], {
        env: { TERM: 'dumb', NO_COLOR: '1' },
        stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
        initialize: () => { initialized++; },
        resumeInstallation: async () => { throw new Error('installation handler called'); },
        applyRunLifecycle: async () => { throw new Error('Run handler called'); },
        applyPoolHold: async () => { throw new Error('pool handler called'); },
      });
      expect(code).toBe(0); expect(stderr).toBe(''); expect(initialized).toBe(0);
      expect(stdout.split('\n')[0]).toBe(`deckent ${family} resume`);
      expect(stdout).toContain(summaries[family]);
      for (const other of ['init', 'run', 'pool'] as const) if (other !== family) expect(stdout).not.toContain(summaries[other]);
      expect(stdout).toContain(language === 'en' ? `Command family: deckent ${family} <action>` : `Komut ailesi: deckent ${family} <eylem>`);
      expect(stdout).not.toContain(String.fromCharCode(27));
      expect(stdout.split('\n').every(line => [...line].length <= 80)).toBe(true);
    }
  }
});

it.each(['en', 'tr'] as const)('keeps nested catalog help qualified and execution flags strict in %s', async language => {
  let stdout = '', stderr = '', initialized = 0;
  const ctx = { env: { TERM: 'dumb', NO_COLOR: '1' }, stdout: { write: (text: string) => { stdout += text; } },
    stderr: { write: (text: string) => { stderr += text; } }, initialize: () => { initialized++; } };
  expect(await main(['models', 'catalog', 'activate', '-h', '--lang', language], ctx)).toBe(0);
  expect(stdout.split('\n')[0]).toBe('deckent models catalog activate');
  expect(stdout).toContain(language === 'en' ? 'Activate a catalog channel or model' : 'Katalog kanalını veya modelini etkinleştir');
  expect(stdout).toContain(language === 'en' ? 'Command family: deckent models catalog <action>' : 'Komut ailesi: deckent models catalog <eylem>');
  expect(stderr).toBe(''); expect(initialized).toBe(0);
  stdout = ''; expect(await main(['run', 'unknown-action', '-h', '--lang', language], ctx)).toBe(0);
  expect(stdout).not.toContain('deckent run unknown-action'); expect(initialized).toBe(0);
  stdout = ''; expect(await main(['run', 'resume', '--help', '--json', '--lang', language], ctx)).toBe(2);
  expect(stdout).toBe(''); expect(stderr).not.toBe(''); expect(initialized).toBe(1);
});

// S2 (CLI-INSAN alpha.53): an action called without an argument its catalog entry `requires` is refused by name (CLI_ARGUMENT_MISSING, exit 2)
// in the caller's language, never as "invalid arguments"; the handler still decides (a picker on a person's terminal is unchanged).
function offTerminal(language: 'en' | 'tr') {
  const out: string[] = [], err: string[] = [];
  return { out, err, context: { root: mkdtempSync(join(tmpdir(), 'deckent-cli-requires-')), env: { HOME: '/tmp/deckent-cli-help-test', NO_COLOR: '1', TERM: 'dumb', CI: '1', DECKENT_LANG: language },
    stdout: { write(value: string) { out.push(value); } }, stderr: { write(value: string) { err.push(value); } }, initialize() {} } };
}
const MISSING = [
  [['models', 'catalog', 'activate'], { en: '--channel <id>, --command-id <id>, --expected-revision <n>', tr: '--channel <id>, --command-id <id>, --expected-revision <n>' }],
  [['models', 'binding', '--provider', 'p'], { en: '--provider-version <n>, --model <id>, --model-version <n>', tr: '--provider-version <n>, --model <id>, --model-version <n>' }],
  [['decide', 'inspect'], { en: '--input <file|-> | --schema', tr: '--input <dosya|-> | --schema' }],
  [['task', 'inspect', '--scope', 's'], { en: '--run <id>, --task <id>', tr: '--run <id>, --task <id>' }],
  [['config', 'unset'], { en: '<key>', tr: '<anahtar>' }],
  [['secret', 'delete'], { en: '<name>', tr: '<ad>' }],
  [['operation', 'inspect'], { en: '--command-id <id>', tr: '--command-id <id>' }],
] as const;
it.each((['en', 'tr'] as const).flatMap(language => MISSING.map(([argv, missing]) => [language, argv, missing[language]] as const)))(
  'names the missing argument of an action off a terminal (%s %j)', async (language, argv, missing) => {
    const f = offTerminal(language);
    expect(await main([...argv], f.context)).toBe(2);
    const text = f.err.join('') + f.out.join('');
    expect(text).toContain(`${language === 'en' ? 'Missing argument' : 'Eksik argüman'}: ${missing}.`);
    expect(text).toContain(`deckent ${argv.filter(word => !word.startsWith('-') && !['p', 's'].includes(word)).join(' ')}`);
    expect(text).toContain('[CLI_ARGUMENT_MISSING]'); expect(text).not.toContain('CLI_USAGE');
  });

it('keeps CLI_USAGE for a present but invalid value, a strict help call and a missing --scope (the scope rule owns it)', async () => {
  for (const argv of [['models', 'binding', '--provider', 'p', '--provider-version', 'x', '--model', 'm', '--model-version', '1'],
    ['run', 'hold', '--scope', 's', '--id', 'r', '--command-id', 'c', '--expected-revision', 'zz', '--reason', 'r'],
    ['models', 'invoke', '--help', '--json'], ['run', 'cancel', '--id', 'r', '--command-id', 'c', '--expected-revision', '1']]) {
    const f = offTerminal('en');
    expect(await main(argv, f.context), argv.join(' ')).toBe(2);
    const text = f.err.join('') + f.out.join('');
    expect(text, argv.join(' ')).toContain('CLI_USAGE'); expect(text, argv.join(' ')).not.toContain('CLI_ARGUMENT_MISSING');
  }
});

it.each(['en', 'tr'] as const)('shows the required arguments in action help (%s) and declares only flag or positional syntax, never --scope', async language => {
  const help = async (argv: readonly string[]) => { const f = offTerminal(language); expect(await main([...argv, '--help', '--lang', language], f.context)).toBe(0); return f.out.join('').split('\n\n')[0]!.split('\n').slice(2).join(' '); };
  expect(await help(['operation', 'inspect'])).toBe(`${language === 'en' ? 'Required' : 'Gerekli'}: --command-id <id>`);
  // A person on a terminal picks the channel and model; the list holds for AI, scripts and pipes.
  expect(await help(['models', 'catalog', 'activate'])).toBe(`${language === 'en' ? 'Required without a terminal' : 'Terminal dışında gerekli'}: --channel <id>, --command-id <id>, --expected-revision <n>`);
  const actions = (CLI_CATALOG as readonly CliCommandSpec[]).flatMap(function walk(spec): CliCommandSpec[] { return [spec, ...(spec.children ?? []).flatMap(walk)]; });
  for (const spec of actions) for (const item of spec.requires ?? []) {
    for (const form of item.split(' | ')) expect(form, spec.name).toMatch(/^(--[a-z-]+( \S+)?|<[a-z]+>)$/);
    expect(item, spec.name).not.toContain('--scope');
  }
});

it.each(['en', 'tr'] as const)('run inspect with a scope and no --id off a terminal names --id (%s)', async language => {
  const f = offTerminal(language);
  const context = { ...f.context, async inspectRun() { throw new Error('handler reached the read'); } };
  expect(await main(['run', 'inspect', '--scope', 's'], context)).toBe(2);
  const text = f.err.join('') + f.out.join('');
  expect(text).toContain(`${language === 'en' ? 'Missing argument' : 'Eksik argüman'}: --id <id>.`); expect(text).toContain('[CLI_ARGUMENT_MISSING]');
});
