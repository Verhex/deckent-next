import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { unifiedDiff } from '../../../src/adapters/core/workspace-write/index.js';
import { clearConfigCache } from '#platform/index.js';

/**
 * SEC-5S (claude-security F1, F35, F37): worker- and model-written text reaches the owner's terminal only through `terminalSafeText`.
 * Each payload keeps the risky input (CSI erase/cursor-up, OSC 52 clipboard, OSC title, CR overwrite, C1 CSI) and asserts it is
 * neutralised in human output while the hidden text stays readable and `--json` stays data-exact.
 */
const ESC = '\u001b', CR = '\r', C1_CSI = '\u009b';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'dn-terminal-safe-cli-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true }); await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') } }));
  return root;
}
async function run(argv: string[], handlers: Record<string, unknown>, root: string) {
  const out: string[] = [];
  const code = await main(argv, { root, env: { HOME: join(root, 'h'), USERPROFILE: join(root, 'h'), NO_COLOR: '1' }, initialize() {},
    stdout: { write(value: string) { out.push(value); } }, stderr: { write() {} }, ...handlers } as never);
  return { code, text: out.join('') };
}
function expectNeutralised(text: string) {
  expect(text.includes(ESC)).toBe(false);
  expect(text.includes(CR)).toBe(false);
  expect(text.includes(C1_CSI)).toBe(false);
  expect(text.includes('\u0007')).toBe(false);
}

const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
const file = (text: string) => ({ mode: '100644', text, digest: 'a'.repeat(64) });
// F1: a backdoor line hidden by CR + erase-line, a cursor-up rewrite, an OSC 52 clipboard write and a C1 CSI.
const hostile = `ok();\nbackdoor();${CR}${ESC}[2K+// formatting only\n${ESC}[1A${ESC}[2Kmore();\nclip()${ESC}]52;c;Zm9v${ESC}\\\nc1()${C1_CSI}2K\n`;
const patchResult = { schemaVersion: 1, receipt: {}, application: 'not-applied', scope: { schemaVersion: 1, matcher: 1, mode: 'warn', status: 'unscoped' },
  patch: { changes: [{ path: 'src/a.ts', before: file('ok();\nold();\n'), after: file(hostile) }] } };
const patchArgs = ['task', 'patch-preview', '--scope', 's', '--run', 'r', '--task', 't', '--attempt', 'a', '--generation', '1', '--layout-revision', 'l'];

it('F1: patch-preview --diff neutralises escape sequences in worker-written file bodies, keeps every hidden line visible with its diff marker', async () => {
  const root = await project();
  const handlers = { async previewWorkspacePatch() { return patchResult; }, renderUnifiedDiff: unifiedDiff };
  for (const extra of [[], ['--diff']]) {
    const { code, text } = await run([...patchArgs, ...extra], handlers, root);
    expect(code).toBe(0);
    expectNeutralised(text);
    // The line a CR would have overwritten is still shown, and its continuation keeps the "+" marker of the line it belongs to.
    expect(text).toContain('+backdoor();\n++// formatting only');
    expect(text).toContain('+more();');
    expect(text).toContain('+clip()');
    expect(text).toContain('+c1()2K');
    expect(text).toContain('--- a/src/a.ts\n+++ b/src/a.ts');
  }
  const json = await run([...patchArgs, '--json'], handlers, root);
  expect(JSON.parse(json.text)).toEqual(patchResult);
});

it('F1: patch-prepare human view neutralises C1 controls that JSON.stringify leaves raw; --json stays exact', async () => {
  const root = await project();
  const handlers = { async prepareWorkspacePatch() { return patchResult; } };
  const args = ['task', 'patch-prepare', ...patchArgs.slice(2)];
  const human = await run(args, handlers, root);
  expect(human.code).toBe(0);
  expectNeutralised(human.text);
  expect(human.text).toContain('backdoor();');
  expect(JSON.parse((await run([...args, '--json'], handlers, root)).text)).toEqual(patchResult);
});

const hostileModel = `claude-x${ESC}]0;evil-title${ESC}\\${ESC}[2J`;
const model = { provider: 'claude', requested: { channelId: 'claude-cli-subscription', modelId: hostileModel, auxiliaryModelIds: [`aux${C1_CSI}1A`] },
  init: `init${CR}${ESC}[2Kfake`, usage: [`used${ESC}]52;c;Zm9v\u0007`], verdict: 'unverified', unexpected: [], evidence: 'sealed' } as const;

it('F35: run inspect neutralises the worker-written needs-input question and worker-reported model names; --json stays exact', async () => {
  const root = await project();
  const question = `Which branch?${ESC}[2J${ESC}[HRun state: accepted${ESC}]52;c;Zm9v\u0007${CR}really`;
  const view = { schemaVersion: 3, state: { kind: 'running' }, runId: 'r', scopeId: 's', layoutRevision: 'l', registryRevision: 'reg', criteria: [], revision: 3,
    cancellationRequested: false, tasks: [{ id: 't', kind: 'claude', dependencies: [], acceptanceCriteria: ['exit'], profile: { id: 'claude', version: 1 },
      phase: 'awaiting-decision', unresolvedEffects: false, decision: { reason: 'needs-input', question, since: 1, deadline: 2 } }] };
  const result = { schemaVersion: 1, layout: {}, run: view, models: [{ ...model, taskId: 't', attemptId: 'a' }] };
  const inspectRun = async () => result;
  for (const lang of ['en', 'tr']) {
    const { code, text } = await run(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', lang], { inspectRun }, root);
    expect(code).toBe(0);
    expectNeutralised(text);
    expect(text).toContain('Which branch?Run state: accepted');
    expect(text).toContain('claude-x');
    expect(text).toContain('init\nfake');
    expect(text).not.toContain('evil-title');
  }
  expect(JSON.parse((await run(['run', 'inspect', '--scope', 's', '--id', 'r', '--json'], { inspectRun }, root)).text)).toEqual(result);
});

it('F37: workers list/watch neutralise worker-reported model names; --json stays exact', async () => {
  const root = await project();
  const report = { schemaVersion: 1, observedAt: 0, scopeId: 's', control: 'observe-only', sources: [{ id: 'current', path: root, kind: 'next-project', status: 'available',
    nextAfter: null, truncated: false, workers: [{ taskId: 't', identity, authority: 'next-ledger', provider: 'claude', workspace: null, process: 'exited', handle: null,
      terminal: null, outputRecorded: true, patchRecorded: false, files: null, diagnostics: [], model }] }] };
  const handlers = { async inspectWorkers() { return report; } };
  for (const argv of [['workers', 'list', '--scope', 's', '--lang', 'en'], ['workers', 'watch', '--scope', 's', '--samples', '1', '--lang', 'tr']]) {
    const { code, text } = await run(argv, handlers, root);
    expect(code).toBe(0);
    expectNeutralised(text);
    expect(text).toContain('claude-x');
    expect(text).toContain('aux1A');
    expect(text).not.toContain('evil-title');
  }
  expect(JSON.parse((await run(['workers', 'list', '--scope', 's', '--json'], handlers, root)).text)).toEqual(report);
});

it('sweep: run inspect and task inspect neutralise worker-tree config-exclusion paths; --json stays exact', async () => {
  const root = await project();
  const entries = [{ path: `pkg/evil${ESC}]52;c;Zm9v\u0007${CR}${ESC}[2Kname.js`, rule: 'node_modules/**', by: 'dependencyTree:node_modules' }];
  const view = { schemaVersion: 3, state: { kind: 'running' }, runId: 'r', scopeId: 's', layoutRevision: 'l', registryRevision: 'reg', criteria: [], revision: 1,
    cancellationRequested: false, tasks: [{ id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'], profile: { id: 'coding', version: 1 },
      phase: 'active', unresolvedEffects: false, configExclusions: { count: 1, entries } }] };
  const result = { schemaVersion: 1, layout: {}, run: view, models: [] };
  const inspectRun = async () => result;
  for (const argv of [['run', 'inspect', '--scope', 's', '--id', 'r'], ['task', 'inspect', '--scope', 's', '--run', 'r', '--task', 't']]) {
    const { code, text } = await run([...argv, '--lang', 'en'], { inspectRun }, root);
    expect(code).toBe(0);
    expectNeutralised(text);
    expect(text).toContain('pkg/evil\nname.js');
  }
  expect(JSON.parse((await run(['task', 'inspect', '--scope', 's', '--run', 'r', '--task', 't', '--json'], { inspectRun }, root)).text).task.configExclusions.entries).toEqual(entries);
});

it('F1: a CRLF line ending is a line end, not an overwrite — CRLF files diff line for line without phantom marker lines', async () => {
  const root = await project();
  const crlf = { ...patchResult, patch: { changes: [{ path: 'win.txt', before: file('a\r\nb\r\n'), after: file('a\r\nB\r\n') }] } };
  const { code, text } = await run([...patchArgs, '--diff'], { async previewWorkspacePatch() { return crlf; }, renderUnifiedDiff: unifiedDiff }, root);
  expect(code).toBe(0);
  expectNeutralised(text);
  expect(text).toContain('@@ -1,2 +1,2 @@\n a\n-b\n+B\n');
  expect(text.includes('\n+\n')).toBe(false);
  expect(text.includes('\n-\n')).toBe(false);
});
