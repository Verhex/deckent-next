import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { unifiedDiff } from '../../../src/adapters/core/workspace-write/index.js';
import { clearConfigCache } from '#platform/index.js';
import { CLI_CATALOG } from '#surfaces/core/cli-kit/index.js';
import { TASK_ACTION_GROUPS, taskActions, taskCommand, taskMenu } from '#surfaces/core/cli-task/index.js';

/**
 * C-TASK (alpha.48, CLI review §task): the `task` family for a person — config language, the control-character marker (J1b D1),
 * `task inspect` in run-inspect order, short run ids, the grouped bare refusal and the TTY menu with its delivery chain.
 */
const ESC = '\u001b', CR = '\r';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project(config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-cli-task-human-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') }, ...config }));
  return root;
}
async function run(argv: string[], handlers: Record<string, unknown>, root: string, env: Record<string, string> = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, { root, env: { HOME: join(root, 'h'), USERPROFILE: join(root, 'h'), NO_COLOR: '1', ...env }, initialize() {},
    stdout: { write(value: string) { out.push(value); } }, stderr: { write(value: string) { err.push(value); } }, ...handlers } as never);
  return { code, text: out.join(''), err: err.join('') };
}

const file = (text: string) => ({ mode: '100644', text, digest: 'a'.repeat(64) });
const patchResult = (after: string, before = 'ok();\nold();\n') => ({ schemaVersion: 1, receipt: {}, application: 'not-applied',
  scope: { schemaVersion: 1, matcher: 1, mode: 'warn', status: 'unscoped' }, patch: { changes: [{ path: 'src/a.ts', before: file(before), after: file(after) }] } });
const patchArgs = ['task', 'patch-preview', '--scope', 's', '--run', 'r', '--task', 't', '--attempt', 'a', '--generation', '1', '--layout-revision', 'l'];
const marker = '\\ control characters in the line above were neutralised (shown, not executed)';

it('J1b D1: a diff line whose control characters were neutralised is marked with a unified-diff meta line (EN and TR)', async () => {
  const root = await project();
  // The F1 payload: a backdoor line hidden by CR + erase-line, and SGR 8 (concealed text).
  const hostile = `ok();\nbackdoor();${CR}${ESC}[2K+// formatting only\nsecret()${ESC}[8mhidden${ESC}[0m\n`;
  const handlers = { async previewWorkspacePatch() { return patchResult(hostile); }, renderUnifiedDiff: unifiedDiff };
  const { code, text } = await run([...patchArgs, '--diff'], handlers, root);
  expect(code).toBe(0);
  expect(text.includes(ESC)).toBe(false);
  // The hidden line stays readable with its marker, and the marker follows each neutralised line (never a ' ', '+' or '-' line).
  expect(text).toContain(`+backdoor();\n++// formatting only\n${marker}`);
  expect(text).toContain(`+secret()hidden\n${marker}`);
  expect(text.split('\n').filter(line => line === marker)).toHaveLength(2);
  const tr = await run([...patchArgs, '--diff', '--lang', 'tr'], handlers, root);
  expect(tr.text).toContain('+secret()hidden\n\\ üstteki satırdaki kontrol karakterleri etkisizleştirildi (gösterildi, çalıştırılmadı)');
});

it('J1b D1: no marker for a clean diff, a CRLF file, --stat or --json', async () => {
  const root = await project();
  for (const after of ['ok();\nnew();\n', 'ok();\r\nnew();\r\n']) {
    const before = after.includes('\r') ? 'ok();\r\nold();\r\n' : 'ok();\nold();\n';
    const handlers = { async previewWorkspacePatch() { return patchResult(after, before); }, renderUnifiedDiff: unifiedDiff };
    const { code, text } = await run(patchArgs, handlers, root);
    expect(code).toBe(0); expect(text).toContain('+new();'); expect(text).not.toContain('neutralised');
  }
  const hostile = { async previewWorkspacePatch() { return patchResult(`x${ESC}[2Ky\n`); }, renderUnifiedDiff: unifiedDiff };
  expect((await run([...patchArgs, '--stat'], hostile, root)).text).not.toContain('neutralised');
  expect(JSON.parse((await run([...patchArgs, '--json'], hostile, root)).text)).toEqual(patchResult(`x${ESC}[2Ky\n`));
});

it('transcript and patch-preview follow the host-resolved language (config language), format unchanged; --lang still wins', async () => {
  const root = await project();
  const handlers = { async previewWorkspacePatch() { return patchResult('ok();\nnew();\n'); }, renderUnifiedDiff: unifiedDiff, locale: 'tr' };
  const tr = await run([...patchArgs, '--stat'], handlers, root);
  expect(tr.code).toBe(0);
  expect(tr.text).toContain('src/a.ts | +1 -1');
  expect(tr.text).toContain('Kapsam:');
  expect(tr.text).not.toContain('Scope:');
  expect((await run([...patchArgs, '--stat', '--lang', 'en'], handlers, root)).text).toContain('Scope:');
});

const LONG = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const view = (tasks: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ schemaVersion: 3, state: { kind: 'terminal', outcome: 'succeeded' }, runId: LONG,
  scopeId: 's', layoutRevision: 'l', registryRevision: 'reg', revision: 7, cancellationRequested: false,
  criteria: [{ id: 'exit', version: 1, description: 'exits 0', evaluator: { id: 'process-exit', version: 1 }, fingerprint: 'c'.repeat(64) }],
  tasks: tasks.map(task => ({ id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'], profile: { id: 'coding', version: 1 }, phase: 'accepted',
    unresolvedEffects: false, ...task })), ...extra });
const acceptance = { workClass: null, policyRevision: null, profileVersion: null, evaluationId: null, criteria: [], outcome: 'accepted', score: null, ceilingReasons: [] };
const exclusions = (count: number) => ({ count, entries: Array.from({ length: count }, (_, index) => ({ path: index === 0 ? '.npmrc' : `pkg/file-${index}.js`,
  rule: index === 0 ? '.npmrc' : 'node_modules/**', by: index === 0 ? 'acknowledgedDenyPaths:.npmrc' : 'dependencyTree:node_modules' })) });

it('task inspect: request → result → what the acceptance rests on → delivery; metadata and a long secret-gate list only with --verbose', async () => {
  const root = await project();
  const task = { acceptance, configExclusions: exclusions(64), taskBrief: { schemaVersion: 1, task: 'Add the file', scopePaths: null, acceptance: null, criteria: [], profile: null,
    model: null, effort: null, contextRefs: [] }, resultBrief: { schemaVersion: 1, attemptId: 'att', claimLabel: 'CLAIM', report: null, evaluation: { verdict: 'accepted' },
    runDelivery: null, openIssues: null, deliveryOutlook: 'awaiting-delivery' } };
  const result = { schemaVersion: 1, layout: {}, run: view([task]), models: [] };
  let asked = '';
  const inspectRun = async (_root: string, query: { runId: string }) => { asked = query.runId; return result; };
  const args = ['task', 'inspect', '--scope', 's', '--run', LONG, '--task', 't'];
  const plain = await run(args, { inspectRun }, root);
  expect(plain.code).toBe(0);
  const lines = plain.text.split('\n');
  const at = (part: string) => lines.findIndex(line => line.includes(part));
  expect(at('Add the file')).toBeGreaterThan(0);
  expect(at('accepted on: exit code · content not independently verified')).toBeGreaterThan(at('Add the file'));
  expect(at('awaiting delivery')).toBeGreaterThan(at('accepted on:'));
  expect(plain.text).toContain('Secret gate: 64 path(s) passed by an exception, 1 of them from the deny list: .npmrc (every path: --verbose).');
  expect(plain.text).not.toContain('pkg/file-1.js');
  expect(plain.text).not.toMatch(/class unknown|criteria unknown/i);
  const verbose = await run([...args, '--verbose'], { inspectRun }, root);
  expect(verbose.text).toContain('pkg/file-63.js'); expect(verbose.text).toMatch(/unknown/);
  expect(asked).toBe(LONG);
  expect(JSON.parse((await run([...args, '--json'], { inspectRun }, root)).text)).toEqual({ schemaVersion: 1, runId: LONG, task: result.run.tasks[0], models: [] });
  // --verbose belongs to inspect only.
  expect((await run([...patchArgs, '--verbose'], { inspectRun }, root)).code).toBe(2);
});

it('short run ids: a unique prefix resolves (git-like), an ambiguous one refuses before any read, a full or unknown id passes unchanged', async () => {
  const root = await project();
  const ids = [LONG, `${'a'.repeat(4)}f${'0'.repeat(59)}`, OTHER];
  const seen: string[] = [];
  const handlers = { async inspectSurfaceRunIds() { return ids; }, async inspectRun(_root: string, query: { runId: string }) { seen.push(query.runId); return { schemaVersion: 1, layout: {}, run: view([{}]) }; } };
  expect((await run(['task', 'inspect', '--scope', 's', '--run', 'bbbb', '--task', 't'], handlers, root)).code).toBe(0);
  expect(seen).toEqual([OTHER]);
  const ambiguous = await run(['task', 'inspect', '--scope', 's', '--run', 'aaaa', '--task', 't', '--json'], handlers, root);
  expect(ambiguous.code).toBe(2); expect(JSON.parse(ambiguous.err)).toMatchObject({ code: 'CLI_ID_AMBIGUOUS' }); expect(seen).toEqual([OTHER]);
  // The AI path's full id, and an older Run outside the listed page, reach the application exactly as typed.
  const older = 'c'.repeat(64);
  expect((await run(['task', 'inspect', '--scope', 's', '--run', LONG, '--task', 't'], handlers, root)).code).toBe(0);
  expect((await run(['task', 'inspect', '--scope', 's', '--run', older, '--task', 't'], handlers, root)).code).toBe(0);
  expect(seen).toEqual([OTHER, LONG, older]);
});

it('bare `deckent task` off a person terminal (pipe, agent, --json) is never asked: the four groups and the missing argument, exit-2 code', async () => {
  const tty = { isTTY: true, setRawMode() {}, on() {}, off() {} };
  const contexts = [{ env: { NO_COLOR: '1' } }, { env: { NO_COLOR: '1', CLAUDECODE: '1' }, stdin: tty, stdout: { isTTY: true, write() {} } }];
  for (const [index, context] of contexts.entries()) {
    const error = await taskCommand(index ? ['task'] : ['task', '--json'], context as never).then(() => null, (value: unknown) => value as { code: string; message: string });
    expect(error?.code).toBe('CLI_ARGUMENT_MISSING');
    expect(error?.message).toContain('Missing argument: <action>.');
    expect(error?.message).toContain('Inspect: inspect | transcript | patch-preview | integration-inspect');
    expect(error?.message).toContain('Queue: integration-queue-enqueue');
  }
  const tr = await taskCommand(['task', '--lang', 'tr'], { env: {} } as never).then(() => null, (value: unknown) => value as { message: string });
  expect(tr?.message).toContain('Yürüt ve değerlendir: execute | evaluate | accept | reject');
  // Help = behaviour: the groups name exactly the catalog's task actions.
  const spec = CLI_CATALOG.find(command => command.name === 'task')!;
  expect(Object.values(TASK_ACTION_GROUPS).flat().sort()).toEqual((spec.children ?? []).filter(child => !('planned' in child)).map(child => child.name).sort());
});

type Card = { title: string; body?: readonly string[]; options: readonly { id: string; label: string }[] };
function scripted(answers: readonly (string | null)[]) {
  const cards: Card[] = [];
  return { cards, ask: async (card: Card) => { cards.push(card); if (cards.length > answers.length) throw new Error(`unexpected card ${card.title}`); return answers[cards.length - 1]!; } };
}
const brief = (outlook: string) => ({ schemaVersion: 1, attemptId: 'att', claimLabel: 'CLAIM', report: null, evaluation: { verdict: 'accepted' }, runDelivery: null, openIssues: null, deliveryOutlook: outlook });
const ioFor = (ask: (card: Card) => Promise<string | null>, printed: string[], extra: Record<string, unknown> = {}) => ({ locale: 'en' as const, ask: ask as never,
  print: (text: string) => { printed.push(text); }, root: '/fixture', options: { env: {} }, show: async () => undefined, ...extra });

it('the menu offers only the actions valid for the task state', () => {
  const decision = { reason: 'evaluation-uncertain', deadline: 1, since: 0 };
  const cases: [Record<string, unknown>, Record<string, unknown>, string[]][] = [
    [{ phase: 'pending' }, {}, ['inspect']],
    [{ phase: 'active', resultBrief: brief('none') }, { state: { kind: 'running' } }, ['inspect', 'transcript']],
    [{ phase: 'awaiting-decision', decision, resultBrief: brief('none') }, { state: { kind: 'running' } }, ['inspect', 'transcript', 'diff', 'accept', 'reject']],
    [{ phase: 'awaiting-decision', decision: { ...decision, reason: 'needs-input' }, resultBrief: brief('none') }, { state: { kind: 'running' } }, ['inspect', 'transcript', 'diff', 'reject']],
    [{ phase: 'awaiting-decision', decision, unresolvedEffects: true, resultBrief: brief('none') }, { state: { kind: 'running' } }, ['inspect', 'transcript', 'diff']],
    [{ phase: 'accepted', resultBrief: brief('awaiting-delivery') }, {}, ['inspect', 'transcript', 'diff', 'deliver']],
    [{ phase: 'accepted', resultBrief: brief('none') }, {}, ['inspect', 'transcript', 'diff']],
    [{ phase: 'skipped' }, {}, ['inspect']],
  ];
  for (const [task, run, expected] of cases) {
    const runView = view([task], run) as never;
    expect(taskActions(runView, (runView as { tasks: never[] }).tasks[0]!, true)).toEqual(expected);
  }
  // Without the delivery port (no verified-terminal composition) delivery is not offered.
  const accepted = view([{ phase: 'accepted', resultBrief: brief('awaiting-delivery') }]) as never;
  expect(taskActions(accepted, (accepted as { tasks: never[] }).tasks[0]!, false)).not.toContain('deliver');
});

it('accept: the revision is read before the card; declining writes nothing; a stale revision is refused, read again and asked again', async () => {
  const decision = { reason: 'evaluation-uncertain', deadline: 1, since: 0 };
  let revision = 7; const writes: { expectedRevision: number; action: string; commandId: string }[] = [];
  const context = { async inspectRun() { return { schemaVersion: 1, layout: {}, run: view([{ phase: 'awaiting-decision', decision, resultBrief: brief('none') }], { state: { kind: 'running' }, revision }) }; },
    async applyRunLifecycle(_root: string, command: { expectedRevision: number; action: string; commandId: string }) {
      writes.push(command);
      if (writes.length === 1) { revision = 8; throw Object.assign(new Error('stale'), { code: 'RUN_STORE_CONFLICT' }); }
      return { schemaVersion: 1, layout: {}, lifecycle: { schemaVersion: 1, commandId: command.commandId, run: view([{ phase: 'accepted', acceptedEvidence: 'model-unverified' }]) } };
    } };
  const target = { scopeId: 's', runId: LONG, taskId: 't' };
  // Declined: no write.
  const declined = scripted(['accept', 'no', 'exit']), printed: string[] = [];
  await taskMenu(context as never, ioFor(declined.ask, printed) as never, target);
  expect(writes).toEqual([]); expect(printed).toContain('Nothing was changed.');
  // Stale, then re-read and confirmed again on the current revision.
  const accepted = scripted(['accept', 'yes', 'yes', 'exit']);
  await taskMenu(context as never, ioFor(accepted.ask, printed) as never, target);
  expect(writes.map(write => [write.action, write.expectedRevision])).toEqual([['accept', 7], ['accept', 8]]);
  expect(writes[0]!.commandId).not.toBe(writes[1]!.commandId);
  expect(accepted.cards[2]!.body).toContain('The Run changed meanwhile; this card shows its current state.');
  expect(printed.some(line => /not independently verified|unverified/i.test(line))).toBe(true);
});

function fakePort(log: string[], options: { queue?: boolean; targets?: string[] } = {}) {
  const deliverView = { operation: 'deliver-integration', scopeId: 's', runId: LONG, taskId: 't', commandId: 'd', title: 'Add the file', resource: 'refs/deckent/delivery/x',
    from: 'base', to: 'cand', files: ['src/a.ts'], added: 1, removed: 0 };
  const preview = { target: { key: 'k', scopeId: 's', runId: LONG, taskId: 't', title: 'Add the file' }, identity: {}, files: [{ path: 'src/a.ts', added: 1, removed: 0 }], added: 1, removed: 0,
    source: 'src', base: 'base', proposal: 'p', outOfScope: [], adoptionTargets: options.targets ?? [], verification: null, ...(options.queue ? { queueTarget: 'refs/heads/main' } : {}) };
  const refuse = () => Object.assign(new Error('declined'), { code: 'DELIVERY_CONFIRMATION_DECLINED' });
  return {
    async preview() { log.push('preview'); return preview; },
    async deliver(_p: unknown, _ids: unknown, answer: (view: unknown) => Promise<boolean>) {
      if (!await answer(deliverView)) throw refuse();
      log.push('delivered'); return { ref: deliverView.resource, commit: 'c0ffee'.repeat(7).slice(0, 40), commandId: 'cli-delivery' };
    },
    async adopt(_p: unknown, _d: unknown, targetRef: string, commandId: string, answer: (view: unknown) => Promise<boolean>) {
      if (!await answer({ ...deliverView, operation: 'adopt-integration', resource: targetRef })) throw refuse();
      log.push(`adopted:${targetRef}`); return { targetRef, fromCommit: 'a'.repeat(40), toCommit: 'b'.repeat(40), commandId, verifiedBy: null };
    },
    async verificationRuns() { return []; },
    ...(options.queue ? { queue: {
      async prepareCurrent(_t: unknown, commandId: string) { log.push('enqueued'); return { commandId, state: 'awaiting-confirmation' }; },
      async reattempt() { return false; }, async inspect() { return null; },
      async confirm(_s: string, _c: string, ask: (view: unknown) => Promise<boolean>) { if (!await ask({ operation: 'publish', target: { id: 'refs/heads/main' } })) throw refuse(); log.push('confirmed'); return {}; },
    } } : {}),
  };
}

it('deliver: the same /deliver port; every write waits for its own exact card; a declined delivery or adoption writes nothing', async () => {
  const delivering = { async inspectRun() { return { schemaVersion: 1, layout: {}, run: view([{ phase: 'accepted', resultBrief: brief('awaiting-delivery'),
    taskBrief: { schemaVersion: 1, task: 'Add the file', scopePaths: null, acceptance: null, criteria: [], profile: null, model: null, effort: null, contextRefs: [] } }]) }; } };
  const target = { scopeId: 's', runId: LONG, taskId: 't' };
  const run = async (answers: (string | null)[], options: Parameters<typeof fakePort>[1] = {}) => {
    const log: string[] = [], printed: string[] = [], script = scripted(answers);
    await taskMenu(delivering as never, ioFor(script.ask, printed, { deliveryPort: fakePort(log, options) }) as never, target).catch((error: { code?: string }) => log.push(`error:${error.code}`));
    return { log, printed, cards: script.cards };
  };
  // Preview card declined: nothing prepared.
  expect((await run(['deliver', 'no', 'exit'])).log).toEqual(['preview']);
  // Delivery confirmation card (the port's exact card) declined: the port refuses, nothing delivered.
  const declined = await run(['deliver', 'deliver', 'no']);
  expect(declined.log).toEqual(['preview', 'error:DELIVERY_CONFIRMATION_DECLINED']);
  expect(declined.cards[2]!.body).toContain('Write refs/deckent/delivery/x?');
  // Delivered; the adoption card is declined: the branch does not move.
  const adoptDeclined = await run(['deliver', 'deliver', 'yes', 'ref:refs/heads/main', 'no'], { targets: ['refs/heads/main'] });
  expect(adoptDeclined.log).toEqual(['preview', 'delivered', 'error:DELIVERY_CONFIRMATION_DECLINED']);
  expect(adoptDeclined.cards[4]!.body).toContain('Move refs/heads/main to this commit?');
  // Delivered and adopted, each after its own yes.
  const adopted = await run(['deliver', 'deliver', 'yes', 'ref:refs/heads/main', 'yes', 'exit'], { targets: ['refs/heads/main'] });
  expect(adopted.log).toEqual(['preview', 'delivered', 'adopted:refs/heads/main']);
  // A queue target: enqueue, then the exact batch card; declining it publishes nothing.
  expect((await run(['deliver', 'deliver', 'no'], { queue: true })).log).toEqual(['preview', 'enqueued', 'error:DELIVERY_CONFIRMATION_DECLINED']);
});
