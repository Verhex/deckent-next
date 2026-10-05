import { afterEach, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';

const outputs: string[] = [];
afterEach(() => { outputs.length = 0; });

function context() {
  let initialized = 0;
  return { initialized: () => initialized, context: {
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
