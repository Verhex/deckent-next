import { expect, it } from 'vitest';
import { main } from '#surfaces/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { emptySnapshot, fullSnapshot } from '../../fixtures/monitor/snapshots.js';
const source = { scopeId: 's', runId: 'r', layoutRevision: 'l', taskId: 'predecessor', attemptId: 'source-attempt', generation: 1 };
const receipt = { source, digest: 'a'.repeat(64) };
function harness() {
  const out: string[] = [], err: string[] = [];
  const task = { id: 'dependent', kind: 'coding', dependencies: ['predecessor'], acceptanceCriteria: ['ok'], profile: { id: 'p', version: 1 }, phase: 'active', unresolvedEffects: false, handoffs: [receipt] };
  const context = { env: { NO_COLOR: '1', TERM: 'dumb' }, stdout: { write(v: string) { out.push(v); } }, stderr: { write(v: string) { err.push(v); } },
    async inspectRun() { return { schemaVersion: 1, layout: {}, run: { schemaVersion: 3, runId: 'r', revision: 1, state: { kind: 'running' }, cancellationRequested: false, tasks: [task], criteria: [] } }; } };
  return { out, err, context: context as never };
}
it.each([['en', 'Handoff received'], ['tr', 'devir alındı']])('run and task inspect render the engine receipt in %s', async (lang, label) => {
  for (const args of [['run', 'inspect', '--scope', 's', '--id', 'r'], ['task', 'inspect', '--scope', 's', '--run', 'r', '--task', 'dependent']]) {
    const h = harness(); expect(await main([...args, '--lang', lang], h.context)).toBe(0);
    expect(h.err.join('')).toBe(''); expect(h.out.join('')).toContain(label); expect(h.out.join('')).toContain('source-attempt');
  }
});
it('task inspect JSON retains source binding and note digest without a new operator operation', async () => {
  const h = harness(); expect(await main(['task', 'inspect', '--scope', 's', '--run', 'r', '--task', 'dependent', '--json'], h.context)).toBe(0);
  expect(JSON.parse(h.out.join('')).task.handoffs).toEqual([receipt]);
});
it.each([['en', 'handoff received'], ['tr', 'devir alındı']])('monitor renders the same dependency receipt in %s', async (locale, label) => {
  const surface = await loadMonitorSurface(); const template = fullSnapshot.installs[0]!.runs[0]!;
  const run = { ...template, tasks: [{ ...template.tasks[0]!, handoffs: [receipt] }] };
  const snapshot = { ...emptySnapshot, installs: [{ ...emptySnapshot.installs[0]!, runs: [run] }] };
  const block = surface.buildMonitorView(snapshot, locale as 'en' | 'tr', true).tabs.runs[0]!;
  if (block.kind !== 'table') throw Error('expected table');
  expect(block.rows[0]!.detail().flat().map(cell => cell.text).join(' ')).toContain(label);
});
it('CLI/SDK expose distinct English and Turkish typed refusal messages', async () => {
  const { ErrorRegistry, t } = await import('#platform/index.js');
  for (const code of ['HANDOFF_SOURCE_NOT_ACCEPTED', 'HANDOFF_ARTIFACT_MISMATCH', 'HANDOFF_PATCH_UNAPPLICABLE', 'HANDOFF_INVALID', 'HANDOFF_LIMIT_EXCEEDED'] as const) {
    const en = t(`error.${code}`, {}, 'en'), tr = t(`error.${code}`, {}, 'tr');
    expect(en).not.toBe(tr); expect(en).not.toContain(`error.${code}`); expect(tr).not.toContain(`error.${code}`);
    expect(ErrorRegistry.createError(code).code).toBe(code);
  }
});
