import { afterEach, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';

const out: string[] = [], err: string[] = [];
afterEach(() => { out.length = 0; err.length = 0; });
const id = (taskId: string, attemptId: string, generation: number) => ({ scopeId: 's', runId: 'r', taskId, attemptId, generation, layoutRevision: `l${generation}` });
const pages = [
  { entries: [id('t', 'a1', 1), id('other', 'z', 9)], nextAfter: 'cursor' },
  { entries: [id('t', 'a2', 2)], nextAfter: null },
];
const entry = (identity: ReturnType<typeof id>) => ({ identity, owner: 'w', launch: 'launched', terminal: null, cancellationRequested: false, outputRecorded: false });
const seen: unknown[] = [];
const ctx = () => ({ env: { HOME: '/tmp/deckent-resolve-test', NO_COLOR: '1' }, stdout: { write(v: string) { out.push(v); } }, stderr: { write(v: string) { err.push(v); } },
  inspectInventory: async (_root: string, query: { after: string | null }) => {
    const page = query.after === null ? pages[0]! : pages[1]!;
    return { schemaVersion: 1, layout: {}, page: { entries: page.entries.map(entry), nextAfter: page.nextAfter } };
  },
  previewWorkspacePatch: async (_r: string, identity: unknown) => { seen.push(identity); return { schemaVersion: 1, receipt: {}, application: 'not-applied', scope: { schemaVersion: 1, matcher: 1, mode: 'warn', status: 'unscoped' }, patch: { changes: [] } }; },
  inspectWorkerTranscript: async (_r: string, identity: unknown) => { seen.push(identity); return { schemaVersion: 1, transcript: 'x' }; },
  inspectWorkspaceIntegration: async (_r: string, query: { identity: unknown }) => { seen.push(query.identity); return { schemaVersion: 1, status: 'absent' }; },
  renderUnifiedDiff: () => '',
} as never);
const line = 'Resolved attempt a2 (generation 2, layout l2) of r/t.';
const scope = ['--scope', 's', '--run', 'r', '--task', 't'];
const cases: [string, string[]][] = [['patch-preview', []], ['transcript', []], ['integration-inspect', ['--command-id', 'c']]];

it.each(cases)('%s resolves the highest generation and prints the line on stdout', async (action, extra) => {
  seen.length = 0;
  expect(await main(['task', action, ...scope, ...extra], ctx())).toBe(0);
  expect(seen).toEqual([id('t', 'a2', 2)]);
  expect(out.join('').startsWith(line + '\n')).toBe(true);
});
it.each(cases)('%s in --json mode keeps stdout JSON and writes the line to stderr', async (action, extra) => {
  seen.length = 0;
  expect(await main(['task', action, ...scope, ...extra, '--json'], ctx())).toBe(0);
  expect(seen).toEqual([id('t', 'a2', 2)]);
  expect(() => JSON.parse(out.join(''))).not.toThrow();
  expect(out.join('')).not.toContain('Resolved attempt');
  expect(err.join('')).toBe(line + '\n');
});
it('exits 1 with ATTEMPT_NOT_FOUND when nothing matches', async () => {
  expect(await main(['task', 'patch-preview', '--scope', 's', '--run', 'r', '--task', 'missing'], ctx())).toBe(1);
  expect(out.join('') + err.join('')).toContain('No attempt of r/missing');
});
it.each([['--attempt', 'a2'], ['--generation', '2'], ['--layout-revision', 'l2']])('treats only %s as a usage error', async (flag, value) => {
  expect(await main(['task', 'patch-preview', ...scope, flag, value], ctx())).toBe(2);
});
it('keeps execute and integration-deliver requiring the full identity', async () => {
  expect(await main(['task', 'execute', ...scope], ctx())).toBe(2);
  expect(await main(['task', 'integration-deliver', ...scope, '--command-id', 'c', '--candidate-command-id', 'd'], ctx())).toBe(2);
});
