import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { clearConfigCache } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const id = (taskId: string, attemptId: string) => ({ scopeId: 's', runId: 'run1', taskId, attemptId, generation: 3, layoutRevision: 'l' });
const model = { provider: 'codex', requested: { channelId: 'codex-cli', modelId: 'gpt-exact-1', auxiliaryModelIds: [] }, init: null, usage: null, verdict: 'unverified', unexpected: [], evidence: 'sealed' };
const base = { authority: 'next-ledger', workspace: null, handle: null, outputRecorded: true, patchRecorded: false, files: null, diagnostics: [] };
const files = (freshness: string) => ({ heartbeat: { state: 'available', ageMs: 1, freshness, phase: 'x' } });
const report = { schemaVersion: 1, observedAt: 0, scopeId: 's', control: 'observe-only', sources: [
  { id: 'a', path: '/p/a', kind: 'next-project', status: 'available', nextAfter: 'cursor9', truncated: true, workers: [
    { ...base, taskId: 't1', identity: id('t1', 'abcdefghijkl'), provider: 'claude', process: 'exited', terminal: { handle: 'h', exitCode: 0, interrupted: false }, files: files('fresh'), model },
    { ...base, taskId: 't2', identity: id('t2', '12345678zzzz'), provider: 'codex', process: 'running', terminal: null, files: files('stale') },
    { ...base, taskId: 't3', identity: id('t3', 'qrstuvwxyz'), provider: 'docker', process: 'exited', terminal: { handle: 'h', exitCode: 1, interrupted: false }, files: { heartbeat: { state: 'missing', ageMs: null, freshness: 'unknown', phase: 'x' } } },
    { ...base, taskId: 't4', identity: null, provider: '', process: 'unknown', terminal: null }] },
  { id: 'b', path: '/p/b', kind: 'next-project', status: 'available', nextAfter: null, truncated: false, workers: [] }] };
it('workers list human output is readable lines, JSON is unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-workers-human-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true }); await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') } }));
  const run = async (extra: string[], command = 'list') => { const out: string[] = [];
    const code = await main(['workers', command, '--scope', 's', '--lang', 'en', ...extra], { root, env: { HOME: join(root, 'h'), USERPROFILE: join(root, 'h') }, initialize() {},
      stdout: { write(v: string) { out.push(v); } }, stderr: { write() {} }, async inspectWorkers() { return report; } } as never); return { code, text: out.join('') }; };
  const human = await run([]); expect(human.code).toBe(0);
  const lines = human.text.split('\n').filter(Boolean);
  for (const line of lines) expect(() => JSON.parse(line), line).toThrow();
  expect(lines).toContain('Source a (/p/a): available · truncated, next page after cursor9');
  expect(lines).toContain('Source b (/p/b): available');
  const at = (task: string) => lines.findIndex(l => l.includes(`run1/${task} `));
  expect(lines[at('t1')]).toBe('  run1/t1 · attempt abcdefgh · gen 3 · exited 0 · heartbeat fresh · claude');
  expect(lines[at('t1') + 1]).toContain('Task t1: Model on codex-cli');
  expect(lines[at('t2')]).toBe('  run1/t2 · attempt 12345678 · gen 3 · running · heartbeat stale · codex');
  expect(lines[at('t3')]).toBe('  run1/t3 · attempt qrstuvwx · gen 3 · exited 1 · heartbeat missing · docker');
  expect(lines).toContain('  -/t4 · attempt - · gen - · unknown · heartbeat unavailable (unknown) · -');
  expect(lines[lines.indexOf('Source b (/p/b): available') + 1]).toBe('  No workers.');
  expect((await run(['--json'])).text).toBe(JSON.stringify(report) + '\n');
  expect(await run(['--samples', '1'], 'watch')).toEqual(human);
  expect((await run(['--samples', '1', '--json'], 'watch')).text).toBe(JSON.stringify(report) + '\n');
});
