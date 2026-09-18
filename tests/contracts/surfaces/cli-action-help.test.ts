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
