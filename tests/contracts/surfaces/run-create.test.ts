import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { runCommand } from '../../../src/surfaces/core/cli/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'selected', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
const command = ['run', 'create', '--scope', 's', '--id', 'r', '--command-id', 'c', '--graph'] as const;
async function fixture(cli: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-run-create-')); roots.push(root); await mkdir(join(root, '.deckent'), { recursive: true });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ cli }));
  const output: string[] = []; const calls: unknown[] = [];
  const result = { schemaVersion: 1 as const, layout: { fixture: true }, admission: { schemaVersion: 1 as const, commandId: 'c',
    run: { runId: 'r', revision: 0, scopeId: 's', layoutRevision: 'layout', cancellationRequested: false, tasks: [], criteria: [] } } };
  return { root, output, calls, result, context: {
    root, env: { HOME: join(root, 'home') }, stdout: { write(value: string) { output.push(value); } },
    async createRun(_root: string, received: unknown) { calls.push(received); return result as never; },
  } };
}

it('passes the same validated graph from a file or pipe to admission and emits the exact JSON result', async () => {
  const f = await fixture(); const file = join(f.root, 'graph.json'); await writeFile(file, JSON.stringify(graph));
  await runCommand([...command, file, '--json'], f.context);
  expect(f.calls).toEqual([{ schemaVersion: 1, commandId: 'c', scopeId: 's', runId: 'r', graph }]);
  expect(JSON.parse(f.output.pop()!)).toEqual(f.result);
  f.calls.length = 0;
  await runCommand([...command, '-', '--json'], { ...f.context, stdin: Readable.from([JSON.stringify(graph)]) });
  expect(f.calls).toEqual([{ schemaVersion: 1, commandId: 'c', scopeId: 's', runId: 'r', graph }]);
  expect(JSON.parse(f.output.pop()!)).toEqual(f.result);
});

it('rejects unknown or duplicate flags, invalid graphs, and oversized input before calling admission', async () => {
  const f = await fixture({ graphInputMaxBytes: 8 }); const invalid = join(f.root, 'invalid.json'); const large = join(f.root, 'large.json');
  await writeFile(invalid, '{}'); await writeFile(large, JSON.stringify(graph));
  await expect(runCommand([...command, invalid, '--extra'], f.context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  await expect(runCommand([...command, invalid, '--scope', 's'], f.context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  await expect(runCommand([...command, invalid], f.context)).rejects.toMatchObject({ code: 'CLI_GRAPH_INPUT_INVALID' });
  await expect(runCommand([...command, large], f.context)).rejects.toMatchObject({ code: 'CLI_GRAPH_INPUT_LIMIT' });
  expect(f.calls).toEqual([]);
});

it('reports contextual usage parameters without leaking supplied values', async () => {
  const f = await fixture(); let text = '';
  expect(await (await import('#surfaces/index.js')).main(['run', 'reserve', '--scope', 'secret-scope'], {
    env: f.context.env, stderr: { write(value: string) { text += value; } }, async reserveRunTasks() { throw new Error('handler called'); },
  })).toBe(2);
  expect(text).toContain('deckent run reserve'); expect(text).toContain('--command-id'); expect(text).toContain('Usage:'); expect(text).not.toContain('secret-scope');
});

it('reports missing criterion definitions with a safe graph path and reason before admission', async () => {
  const f = await fixture(); const file = join(f.root, 'missing-criterion.json');
  await writeFile(file, JSON.stringify({ ...graph, tasks: [{ ...graph.tasks[0], id: 'private-secret-task' }], criterionDefinitions: [] }));
  await expect(runCommand([...command, file], f.context)).rejects.toMatchObject({ code: 'CLI_GRAPH_INPUT_INVALID', params: {
    path: 'graph.tasks.0.acceptanceCriteria.0', reason: 'TASK_CRITERION_DEFINITION_MISSING',
  } });
  expect(f.calls).toEqual([]); expect(JSON.stringify(f.output)).not.toContain('private-secret-task');
});

it('uses the configured graph limit and reports automatic progression without claiming task completion in English or Turkish', async () => {
  const f = await fixture({ graphInputMaxBytes: Buffer.byteLength(JSON.stringify(graph)) }); const file = join(f.root, 'graph.json'); await writeFile(file, JSON.stringify(graph));
  await runCommand([...command, file, '--lang', 'en'], f.context);
  expect(f.output.pop()).toContain('progresses new admissions automatically');
  await runCommand([...command, file, '--lang', 'tr'], f.context);
  expect(f.output.pop()).toContain('yeni kabulleri güncel policy ile otomatik ilerletir');
  expect(f.output).toEqual([]); expect(f.calls).toHaveLength(2);
});

it('forwards a bounded versioned branch file and refuses ambiguous stdin', async () => {
  const f = await fixture(); const file = join(f.root, 'graph.json'), branchPath = join(f.root, 'branch.json');
  const branch = { schemaVersion: 1, input: { id: 'fact', revision: '1', value: false }, whenTrue: 'a', whenFalse: 'b', join: 'join' };
  await writeFile(file, JSON.stringify(graph)); await writeFile(branchPath, JSON.stringify(branch));
  await runCommand([...command, file, '--branch', branchPath, '--json'], f.context);
  expect(f.calls[0]).toMatchObject({ branch });
  await expect(runCommand([...command, file, '--branch', '-'], f.context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  await writeFile(branchPath, JSON.stringify({ ...branch, input: { ...branch.input, value: 'false' } }));
  await expect(runCommand([...command, file, '--branch', branchPath], f.context)).rejects.toMatchObject({ code: 'CLI_GRAPH_INPUT_INVALID' });
  expect(f.calls).toHaveLength(1);
});
