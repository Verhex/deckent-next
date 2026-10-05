import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateTaskGraph, workInputSchema } from '#domain/core/task-graph/index.js';
import { REASONING_EFFORTS } from '#domain/core/provider-catalog/index.js';
import workClasses from '../../../assets/native-coding/work-classes.json' with { type: 'json' };
// Host-only module outside product tsconfig; product source validator is passed unchanged.
// @ts-expect-error host mjs has no declaration file
import { prepareCardGraph, readCardSet, HOST_CARD_INPUT_MAX_BYTES } from '../../../.agents/refactor/n1-card-wire.mjs';

const workInput = () => ({ schemaVersion: 1, title: 'Bounded contract test', task: 'Test the stated edge cases.\nRetain existing behavior.',
  scope: { paths: ['src/domain/core/task-graph/**', 'tests/contracts/domain/task-graph.test.ts'] },
  acceptance: 'Run the named contract checks and retain negative evidence.',
  model: { channelId: 'requested-channel', modelId: 'requested-exact-model', auxiliaryModelIds: ['requested-exact-aux'] },
  effort: 'high', maxTurns: 9 });
const card = () => ({ id: 'task-1', templateKind: 'reusable-template', dependencies: [] as unknown[],
  acceptanceCriteria: ['verify'], workInput: workInput() });
const set = () => ({ schemaVersion: 1, revision: 7, cards: [card()], criterionDefinitions: [{ id: 'verify', version: 1,
  description: 'Delivery evidence required', evaluator: { id: 'requested-evaluator', version: 2 }, parameters: { requireProof: true } }] });
const prepare = (input: unknown) => prepareCardGraph(input, validateTaskGraph);

describe('N1 preparation feeds the existing typed graph contract', () => {
  it('retains exact template/task/criterion/model/scope/effort and deterministic JSON without mutating input', () => {
    const input = set(); const before = JSON.stringify(input);
    const graph = prepare(input);
    const expectedTask = { id: 'task-1', kind: 'reusable-template', dependencies: [], acceptanceCriteria: ['verify'], workInput: workInput() };
    expect(graph).toEqual({ schemaVersion: 3, revision: 7, tasks: [expectedTask],
      criterionDefinitions: input.criterionDefinitions });
    expect(Object.hasOwn(graph.tasks[0], 'templateKind')).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(prepare(input))).toBe(JSON.stringify(graph));
    expect(validateTaskGraph(JSON.parse(JSON.stringify(graph)))).toEqual(graph);
    expect(workInputSchema.parse(graph.tasks[0].workInput)).toEqual(input.cards[0]!.workInput);
  });
  it.each([undefined, false, true])('preserves noChangeAllowed=%s without granting implicit empty-patch acceptance', value => {
    const input = set();
    if (value !== undefined) Object.assign(input.cards[0]!.workInput, { noChangeAllowed: value });
    const actual = prepare(input).tasks[0].workInput;
    expect(actual.noChangeAllowed).toBe(value);
    expect(Object.hasOwn(actual, 'noChangeAllowed')).toBe(value !== undefined);
  });
  it.each(REASONING_EFFORTS)('preserves catalog vocabulary effort %s without asserting model support', effort => {
    const input = set(); input.cards[0]!.workInput.effort = effort;
    expect(prepare(input).tasks[0].workInput.effort).toBe(effort);
  });
  it.each(workClasses.classes.map(row => row.id))('preserves explicit P33 workClass %s without deriving effort or authority', workClass => {
    const input = set(); Object.assign(input.cards[0]!.workInput, { workClass, noChangeAllowed: false });
    const before = JSON.stringify(input);
    const graph = prepare(input); const actual = graph.tasks[0].workInput;
    expect(actual).toEqual(input.cards[0]!.workInput);
    expect(actual.workClass).toBe(workClass);
    expect(actual.effort).toBe('high');
    expect(actual.noChangeAllowed).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
    expect(validateTaskGraph(JSON.parse(JSON.stringify(graph)))).toEqual(graph);
  });
  it('keeps absent class and effort absent even when the template kind has a P33 class binding', () => {
    const input = set(); input.cards[0]!.templateKind = workClasses.bindings[0]!.kind;
    Reflect.deleteProperty(input.cards[0]!.workInput, 'effort');
    const actual = prepare(input).tasks[0].workInput;
    expect(Object.hasOwn(actual, 'workClass')).toBe(false);
    expect(Object.hasOwn(actual, 'effort')).toBe(false);
    expect(Object.hasOwn(actual, 'noChangeAllowed')).toBe(false);
  });
  it('preserves an unregistered class identity for actual policy admission; preparation never resolves the registry', () => {
    const workClass = 'operator-unregistered-class';
    expect(workClasses.classes.some(row => row.id === workClass)).toBe(false);
    const input = set(); Object.assign(input.cards[0]!.workInput, { workClass });
    Reflect.deleteProperty(input.cards[0]!.workInput, 'effort');
    expect(prepare(input).tasks[0].workInput.workClass).toBe(workClass);
  });
  it.each(['', '  ', 'control\0class', 7, null])('refuses invalid P33 workClass syntax %j through actual workInput schema', workClass => {
    const input = set(); Object.assign(input.cards[0]!.workInput, { workClass });
    expect(() => prepare(input)).toThrow('TASK_GRAPH_INVALID');
  });
  it('retains syntactically valid unknown IDs and aliases for actual run admission to refuse', () => {
    const input = set(); input.cards[0]!.workInput.model = { channelId: 'not-an-active-channel', modelId: 'unresolved-alias', auxiliaryModelIds: [] };
    expect(prepare(input).tasks[0].workInput.model).toEqual(input.cards[0]!.workInput.model);
  });
  it('requires typed scope and declines historical fixed-profile/prose cards', () => {
    expect(() => prepare({ card: 'old', kind: 'card-old', scope: 'Edit foo only', task: 'task' })).toThrow('N1_CARD_INPUT_INVALID');
    const input = set(); Object.assign(input.cards[0]!.workInput, { scope: 'Edit foo only' });
    expect(() => prepare(input)).toThrow('TASK_GRAPH_INVALID');
  });
  it.each(['', '  ', '../secret', '/absolute', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a\0b'])('refuses unsafe scope %j using real workInput schema', path => {
    const input = set(); input.cards[0]!.workInput.scope.paths = [path];
    expect(() => prepare(input)).toThrow('TASK_GRAPH_INVALID');
  });
  it('refuses duplicate scopes, too many paths and invalid tasks/model grammar/effort through domain validation', () => {
    for (const replacement of [{ scope: { paths: ['same', 'same'] } }, { scope: { paths: Array.from({ length: 65 }, (_, i) => `p${i}`) } },
      { task: '' }, { task: '  ' }, { effort: 'invented' }, { noChangeAllowed: 'true' },
      { model: { channelId: 'channel', modelId: '--option', auxiliaryModelIds: [] } },
      { model: { channelId: 'channel', modelId: 'model', auxiliaryModelIds: [], provider: 'host-made' } }, { hostGeneratedWorkClass: 'coding' }]) {
      const input = set(); Object.assign(input.cards[0]!.workInput, replacement);
      expect(() => prepare(input)).toThrow('TASK_GRAPH_INVALID');
    }
  });
  it('keeps plain dependency edges in v3 and uses existing v4 for accepted-patch edges and inputs', () => {
    const input = set(); const second = { ...card(), id: 'task-2', dependencies: ['task-1'] };
    input.cards.push(second);
    expect(prepare(input).schemaVersion).toBe(3);
    second.dependencies = [{ taskId: 'task-1', startFrom: 'accepted-patch' }];
    Object.assign(second, { inputs: [{ name: 'patch', taskId: 'task-1', output: 'patch' }] });
    const graph = prepare(input);
    expect(graph.schemaVersion).toBe(4);
    expect(graph.tasks[1].dependencies).toEqual(second.dependencies);
    expect(graph.tasks[1].inputs).toEqual([{ name: 'patch', taskId: 'task-1', output: 'patch' }]);
  });
  it('runs real DAG/criterion integrity checks rather than stopping at Zod syntax', () => {
    const missing = set(); missing.cards[0]!.dependencies = ['absent'];
    expect(() => prepare(missing)).toThrow('TASK_DEPENDENCY_MISSING');
    const cycle = set(); cycle.cards[0]!.dependencies = ['task-1'];
    expect(() => prepare(cycle)).toThrow('TASK_GRAPH_CYCLE');
    const duplicate = set(); duplicate.cards.push(card());
    expect(() => prepare(duplicate)).toThrow('TASK_DUPLICATE');
    const absent = set(); absent.criterionDefinitions = [];
    expect(() => prepare(absent)).toThrow('TASK_CRITERION_DEFINITION_MISSING');
    const unused = set(); unused.cards[0]!.acceptanceCriteria = ['other'];
    expect(() => prepare(unused)).toThrow('TASK_CRITERION_DEFINITION_MISSING');
  });
  it('rejects missing workInput/template, competing kind and unrecognized graph/card fields', () => {
    for (const mutate of [(input: ReturnType<typeof set>) => { Object.assign(input.cards[0]!, { workInput: undefined }); },
      (input: ReturnType<typeof set>) => { Object.assign(input.cards[0]!, { templateKind: undefined }); },
      (input: ReturnType<typeof set>) => { Object.assign(input.cards[0]!, { kind: 'competing' }); },
      (input: ReturnType<typeof set>) => { Object.assign(input.cards[0]!, { profileId: 'per-task-registry-profile' }); },
      (input: ReturnType<typeof set>) => { Object.assign(input, { tasks: [card()] }); },
      (input: ReturnType<typeof set>) => { Object.assign(input, { config: { active: true } }); }]) {
      const input = set(); mutate(input); expect(() => prepare(input)).toThrow();
    }
    expect(() => prepare({ ...set(), schemaVersion: 2 })).toThrow('N1_CARD_INPUT_INVALID');
  });
  it('performs only bounded input-file reading and leaves the artifact bytes intact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'n1-card-wire-'));
    try {
      const path = join(directory, 'cards.json'); const text = JSON.stringify(set()); await writeFile(path, text);
      expect(prepare(await readCardSet(path)).schemaVersion).toBe(3);
      expect(await readFile(path, 'utf8')).toBe(text);
      await writeFile(path, Buffer.alloc(HOST_CARD_INPUT_MAX_BYTES + 1, 32));
      await expect(readCardSet(path)).rejects.toThrow('N1_CARD_INPUT_LIMIT');
      await writeFile(path, Buffer.from([0xff])); await expect(readCardSet(path)).rejects.toThrow();
      await writeFile(path, '{invalid'); await expect(readCardSet(path)).rejects.toThrow();
      // Some platforms refuse directory open before fstat; both are a refusal.
      await expect(readCardSet(directory)).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
