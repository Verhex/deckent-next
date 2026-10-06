import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Host test: the product validator is consumed from the built package (dist), never from product tests importing the host.
import { validateTaskGraph, workInputSchema } from '#domain/core/task-graph/index.js';
import { REASONING_EFFORTS } from '#domain/core/provider-catalog/index.js';
import { prepareCardGraph, readCardSet, HOST_CARD_INPUT_MAX_BYTES } from './n1-card-wire.mjs';

const workClasses = JSON.parse(await readFile(new URL('../../assets/native-coding/work-classes.json', import.meta.url), 'utf8'));
const workInput = () => ({ schemaVersion: 1, title: 'Bounded contract test', task: 'Test the stated edge cases.\nRetain existing behavior.',
  scope: { paths: ['src/domain/core/task-graph/**', 'tests/contracts/domain/task-graph.test.ts'] },
  acceptance: 'Run the named contract checks and retain negative evidence.',
  model: { channelId: 'requested-channel', modelId: 'requested-exact-model', auxiliaryModelIds: ['requested-exact-aux'] },
  effort: 'high', maxTurns: 9 });
const card = () => ({ id: 'task-1', templateKind: 'reusable-template', dependencies: [], acceptanceCriteria: ['verify'], workInput: workInput() });
const set = () => ({ schemaVersion: 1, revision: 7, cards: [card()], criterionDefinitions: [{ id: 'verify', version: 1,
  description: 'Delivery evidence required', evaluator: { id: 'requested-evaluator', version: 2 }, parameters: { requireProof: true } }] });
const prepare = input => prepareCardGraph(input, validateTaskGraph);
const refuses = (fn, code) => assert.throws(fn, error => code === undefined || String(error?.message).includes(code));
const refusesAsync = (promise, code) => assert.rejects(promise, error => code === undefined || String(error?.message).includes(code));

test('retains exact template/task/criterion/model/scope/effort and deterministic JSON without mutating input', () => {
  const input = set(); const before = JSON.stringify(input);
  const graph = prepare(input);
  const expectedTask = { id: 'task-1', kind: 'reusable-template', dependencies: [], acceptanceCriteria: ['verify'], workInput: workInput() };
  assert.deepEqual(graph, { schemaVersion: 3, revision: 7, tasks: [expectedTask], criterionDefinitions: input.criterionDefinitions });
  assert.equal(Object.hasOwn(graph.tasks[0], 'templateKind'), false);
  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.stringify(prepare(input)), JSON.stringify(graph));
  assert.deepEqual(validateTaskGraph(JSON.parse(JSON.stringify(graph))), graph);
  assert.deepEqual(workInputSchema.parse(graph.tasks[0].workInput), input.cards[0].workInput);
});
for (const value of [undefined, false, true]) test(`preserves noChangeAllowed=${value} without granting implicit empty-patch acceptance`, () => {
  const input = set();
  if (value !== undefined) Object.assign(input.cards[0].workInput, { noChangeAllowed: value });
  const actual = prepare(input).tasks[0].workInput;
  assert.equal(actual.noChangeAllowed, value);
  assert.equal(Object.hasOwn(actual, 'noChangeAllowed'), value !== undefined);
});
for (const effort of REASONING_EFFORTS) test(`preserves catalog vocabulary effort ${effort} without asserting model support`, () => {
  const input = set(); input.cards[0].workInput.effort = effort;
  assert.equal(prepare(input).tasks[0].workInput.effort, effort);
});
for (const workClass of workClasses.classes.map(row => row.id)) test(`preserves explicit P33 workClass ${workClass} without deriving effort or authority`, () => {
  const input = set(); Object.assign(input.cards[0].workInput, { workClass, noChangeAllowed: false });
  const before = JSON.stringify(input);
  const graph = prepare(input); const actual = graph.tasks[0].workInput;
  assert.deepEqual(actual, input.cards[0].workInput);
  assert.equal(actual.workClass, workClass);
  assert.equal(actual.effort, 'high');
  assert.equal(actual.noChangeAllowed, false);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(validateTaskGraph(JSON.parse(JSON.stringify(graph))), graph);
});
test('keeps absent class and effort absent even when the template kind has a P33 class binding', () => {
  const input = set(); input.cards[0].templateKind = workClasses.bindings[0].kind;
  Reflect.deleteProperty(input.cards[0].workInput, 'effort');
  const actual = prepare(input).tasks[0].workInput;
  for (const key of ['workClass', 'effort', 'noChangeAllowed']) assert.equal(Object.hasOwn(actual, key), false);
});
test('preserves an unregistered class identity for actual policy admission; preparation never resolves the registry', () => {
  const workClass = 'operator-unregistered-class';
  assert.equal(workClasses.classes.some(row => row.id === workClass), false);
  const input = set(); Object.assign(input.cards[0].workInput, { workClass });
  Reflect.deleteProperty(input.cards[0].workInput, 'effort');
  assert.equal(prepare(input).tasks[0].workInput.workClass, workClass);
});
for (const workClass of ['', '  ', 'control\0class', 7, null]) test(`refuses invalid P33 workClass syntax ${JSON.stringify(workClass)} through actual workInput schema`, () => {
  const input = set(); Object.assign(input.cards[0].workInput, { workClass });
  refuses(() => prepare(input), 'TASK_GRAPH_INVALID');
});
test('retains syntactically valid unknown IDs and aliases for actual run admission to refuse', () => {
  const input = set(); input.cards[0].workInput.model = { channelId: 'not-an-active-channel', modelId: 'unresolved-alias', auxiliaryModelIds: [] };
  assert.deepEqual(prepare(input).tasks[0].workInput.model, input.cards[0].workInput.model);
});
test('requires typed scope and declines historical fixed-profile/prose cards', () => {
  refuses(() => prepare({ card: 'old', kind: 'card-old', scope: 'Edit foo only', task: 'task' }), 'N1_CARD_INPUT_INVALID');
  const input = set(); Object.assign(input.cards[0].workInput, { scope: 'Edit foo only' });
  refuses(() => prepare(input), 'TASK_GRAPH_INVALID');
});
for (const path of ['', '  ', '../secret', '/absolute', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a\0b']) test(`refuses unsafe scope ${JSON.stringify(path)} using real workInput schema`, () => {
  const input = set(); input.cards[0].workInput.scope.paths = [path];
  refuses(() => prepare(input), 'TASK_GRAPH_INVALID');
});
test('refuses duplicate scopes, too many paths and invalid tasks/model grammar/effort through domain validation', () => {
  for (const replacement of [{ scope: { paths: ['same', 'same'] } }, { scope: { paths: Array.from({ length: 65 }, (_, i) => `p${i}`) } },
    { task: '' }, { task: '  ' }, { effort: 'invented' }, { noChangeAllowed: 'true' },
    { model: { channelId: 'channel', modelId: '--option', auxiliaryModelIds: [] } },
    { model: { channelId: 'channel', modelId: 'model', auxiliaryModelIds: [], provider: 'host-made' } }, { hostGeneratedWorkClass: 'coding' }]) {
    const input = set(); Object.assign(input.cards[0].workInput, replacement);
    refuses(() => prepare(input), 'TASK_GRAPH_INVALID');
  }
});
test('keeps plain dependency edges in v3 and uses existing v4 for accepted-patch edges and inputs', () => {
  const input = set(); const second = { ...card(), id: 'task-2', dependencies: ['task-1'] };
  input.cards.push(second);
  assert.equal(prepare(input).schemaVersion, 3);
  second.dependencies = [{ taskId: 'task-1', startFrom: 'accepted-patch' }];
  Object.assign(second, { inputs: [{ name: 'patch', taskId: 'task-1', output: 'patch' }] });
  const graph = prepare(input);
  assert.equal(graph.schemaVersion, 4);
  assert.deepEqual(graph.tasks[1].dependencies, second.dependencies);
  assert.deepEqual(graph.tasks[1].inputs, [{ name: 'patch', taskId: 'task-1', output: 'patch' }]);
});
test('runs real DAG/criterion integrity checks rather than stopping at Zod syntax', () => {
  const missing = set(); missing.cards[0].dependencies = ['absent'];
  refuses(() => prepare(missing), 'TASK_DEPENDENCY_MISSING');
  const cycle = set(); cycle.cards[0].dependencies = ['task-1'];
  refuses(() => prepare(cycle), 'TASK_GRAPH_CYCLE');
  const duplicate = set(); duplicate.cards.push(card());
  refuses(() => prepare(duplicate), 'TASK_DUPLICATE');
  const absent = set(); absent.criterionDefinitions = [];
  refuses(() => prepare(absent), 'TASK_CRITERION_DEFINITION_MISSING');
  const unused = set(); unused.cards[0].acceptanceCriteria = ['other'];
  refuses(() => prepare(unused), 'TASK_CRITERION_DEFINITION_MISSING');
});
test('rejects missing workInput/template, competing kind and unrecognized graph/card fields', () => {
  for (const mutate of [input => { Object.assign(input.cards[0], { workInput: undefined }); },
    input => { Object.assign(input.cards[0], { templateKind: undefined }); },
    input => { Object.assign(input.cards[0], { kind: 'competing' }); },
    input => { Object.assign(input.cards[0], { profileId: 'per-task-registry-profile' }); },
    input => { Object.assign(input, { tasks: [card()] }); },
    input => { Object.assign(input, { config: { active: true } }); }]) {
    const input = set(); mutate(input); refuses(() => prepare(input));
  }
  refuses(() => prepare({ ...set(), schemaVersion: 2 }), 'N1_CARD_INPUT_INVALID');
});
test('performs only bounded input-file reading and leaves the artifact bytes intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'n1-card-wire-'));
  try {
    const path = join(directory, 'cards.json'); const text = JSON.stringify(set()); await writeFile(path, text);
    assert.equal(prepare(await readCardSet(path)).schemaVersion, 3);
    assert.equal(await readFile(path, 'utf8'), text);
    await writeFile(path, Buffer.alloc(HOST_CARD_INPUT_MAX_BYTES + 1, 32));
    await refusesAsync(readCardSet(path), 'N1_CARD_INPUT_LIMIT');
    await writeFile(path, Buffer.from([0xff])); await refusesAsync(readCardSet(path));
    await writeFile(path, '{invalid'); await refusesAsync(readCardSet(path));
    // Some platforms refuse directory open before fstat; both are a refusal.
    await refusesAsync(readCardSet(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
