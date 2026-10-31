import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { clearConfigCache } from '#platform/index.js';

// C-DOCTOR (CLI review 2026-10-19 §terminal): chat-plan is readable text (JSON only with --json), snapshot without an inference_serving
// profile is one typed error with its next step, status says the chat model was not contacted and why the context window is unknown.
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const plan = { schemaVersion: 1, status: 'ready', reference: { providerId: 'local-vllm', providerVersion: 1, modelId: 'qwen-x', modelVersion: 1 }, source: 'project',
  tools: 'none', catalogRevision: 'c1', maxCompletionTokens: 4096, historyMessages: 40 };
async function run(argv: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'dn-terminal-info-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true }); await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') } }));
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, { root, env: { HOME: join(root, 'h') }, initialize() {}, stdout: { write(v: string) { out.push(v); } }, stderr: { write(v: string) { err.push(v); } },
    async describeTerminalChatPlan() { return plan; } } as never);
  return { code, out: out.join(''), err: err.join('') };
}

it('chat-plan is readable text for a person and the unchanged plan with --json', async () => {
  const human = await run(['terminal', 'chat-plan', '--lang', 'en']);
  expect(human.code).toBe(0);
  expect(human.out).toContain('Chat model: ready to use');
  expect(human.out).toContain('Model: local-vllm/qwen-x@1 (chosen by the project setting)');
  expect(human.out).toContain('Answer limit: 4096 tokens · history kept: 40 messages');
  expect(human.out).toContain('Chat model reachability: not tested');
  expect(() => JSON.parse(human.out)).toThrow();
  const tr = await run(['terminal', 'chat-plan', '--lang', 'tr']);
  expect(tr.out).toContain('Sohbet modeli: kullanıma hazır');
  expect(JSON.parse((await run(['terminal', 'chat-plan', '--json'])).out)).toEqual(plan);
});
it('negative: snapshot without an inference_serving profile is one typed error with the next step (no second CLI_USAGE)', async () => {
  const result = await run(['terminal', 'snapshot', '--lang', 'en']);
  expect(result.code).toBe(2);
  expect(result.err).toContain('TERMINAL_SNAPSHOT_NOT_CONFIGURED');
  expect(result.err).toContain('deckent config');
  expect(result.err).not.toContain('CLI_USAGE');
  expect(result.out).toBe('');
});
it('status adds chat-model reachability (not tested) and why the context window is unknown; --json is the terminal report unchanged', async () => {
  const human = await run(['terminal', 'status', '--lang', 'en']);
  expect(human.code).toBe(0);
  expect(human.out).toContain('Chat model: local-vllm/qwen-x@1');
  expect(human.out).toContain('Chat model reachability: not tested');
  expect(human.out).toContain('no tool calls');
  expect((await run(['terminal', 'status', '--lang', 'tr'])).out).toContain('araç');
  expect(human.out).toContain('Context window: unknown until the first answer is measured; with no inference_serving profile');
  const json = JSON.parse((await run(['terminal', 'status', '--json'])).out);
  expect(Object.keys(json).sort()).toEqual(['chat', 'identity', 'inference', 'installationId', 'projectId', 'schemaVersion', 'tty']);
});
