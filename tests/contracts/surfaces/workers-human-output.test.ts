import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const id = (taskId: string, attemptId: string) => ({ scopeId: 's', runId: 'run1', taskId, attemptId, generation: 3, layoutRevision: 'l' });
const model = { provider: 'codex', requested: { channelId: 'codex-cli', modelId: 'gpt-exact-1', auxiliaryModelIds: [] }, init: null, usage: null, verdict: 'unverified', unexpected: [], evidence: 'sealed' };
const base = { authority: 'next-ledger', workspace: null, handle: null, outputRecorded: true, patchRecorded: false, files: null, diagnostics: [] };
const files = (freshness: string) => ({ heartbeat: { state: 'available', ageMs: 1, freshness, phase: 'x' } });
const report = { schemaVersion: 1, observedAt: 0, scopeId: 's', control: 'observe-only', sources: [
  { id: 'a', path: '/p/a', kind: 'next-project', status: 'available', nextAfter: 'cursor9', truncated: true, workers: [
    { ...base, taskId: 't1', identity: id('t1', 'abcdefghijkl'), provider: 'claude', process: 'exited', terminal: { handle: 'h', exitCode: 0, interrupted: false }, files: { ...files('fresh'), usage: { turns: 6, durationMs: 24664, tokenUsageRecorded: true, tokens: { input: 8, output: 1066 }, costUsd: 0.107503, outcome: 'success' } }, model },
    { ...base, taskId: 't2', identity: id('t2', '12345678zzzz'), provider: 'codex', process: 'running', terminal: null, files: files('stale') },
    { ...base, taskId: 't3', identity: id('t3', 'qrstuvwxyz'), provider: 'docker', process: 'exited', terminal: { handle: 'h', exitCode: 1, interrupted: false }, files: { heartbeat: { state: 'missing', ageMs: null, freshness: 'unknown', phase: 'x' } } },
    { ...base, taskId: 't4', identity: null, provider: '', process: 'unknown', terminal: null },
    { ...base, taskId: 't5', identity: id('t5', 'releasedxxxx'), provider: 'unknown', process: 'missing', terminal: { handle: 'h', exitCode: 0, interrupted: false }, custody: 'released', diagnostics: ['custody-released'],
      usage: { turns: 11, durationMs: 48029, tokenUsageRecorded: true, tokens: { input: 18, output: 4786 }, costUsd: 0.2039428, outcome: 'success' }, usageEvidence: 'sealed' }] },
  { id: 'b', path: '/p/b', kind: 'next-project', status: 'available', nextAfter: null, truncated: false, workers: [] }] };
it('workers list --verbose keeps the per-source detail lines, JSON is unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-workers-human-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true }); await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') } }));
  const run = async (extra: string[], command = 'list', lang = 'en') => { const out: string[] = [];
    const code = await main(['workers', command, '--scope', 's', '--lang', lang, ...extra], { root, env: { HOME: join(root, 'h'), USERPROFILE: join(root, 'h') }, initialize() {},
      stdout: { write(v: string) { out.push(v); } }, stderr: { write() {} }, async inspectWorkers() { return report; } } as never); return { code, text: out.join('') }; };
  const human = await run(['--verbose']); expect(human.code).toBe(0);
  const lines = human.text.split('\n').filter(Boolean);
  for (const line of lines) expect(() => JSON.parse(line), line).toThrow();
  expect(lines).toContain('Source a (/p/a): available · truncated, next page after cursor9');
  expect(lines).toContain('Source b (/p/b): available');
  const at = (task: string) => lines.findIndex(l => l.includes(`run1/${task} `));
  expect(lines[at('t1')]).toBe('  run1/t1 · attempt abcdefgh · gen 3 · exited 0 · heartbeat fresh · claude');
  expect(lines[at('t1') + 1]).toContain('Task t1: Model on codex-cli');
  expect(lines[at('t1') + 2]).toBe('Resources unmeasured');
  expect(lines[at('t1') + 3]).toBe('  Usage: 6 turns · 24.7s · tokens 8 in / 1066 out · $0.1075 · reported success');
  expect(lines[at('t1') + 3]!.length).toBeLessThanOrEqual(100);
  expect(lines[at('t2')]).toBe('  run1/t2 · attempt 12345678 · gen 3 · running · heartbeat stale · codex');
  expect(lines.filter(l => l.includes('Usage:'))).toHaveLength(2);
  expect(lines[at('t5') + 1]).toBe('Resources unmeasured');
  expect(lines[at('t5') + 2]).toBe('  Usage: 11 turns · 48.0s · tokens 18 in / 4786 out · $0.2039 · reported success');
  const tr = (await run(['--verbose'], 'list', 'tr')).text.split('\n');
  expect(tr).toContain('  Kullanım: 6 tur · süre 24.7s · token 8 giriş / 1066 çıkış · maliyet $0.1075 · başarılı bildirdi');
  expect(lines[at('t3')]).toBe('  run1/t3 · attempt qrstuvwx · gen 3 · exited 1 · heartbeat missing · docker');
  expect(lines).toContain('  -/t4 · attempt - · gen - · unknown · heartbeat unavailable (unknown) · -');
  expect(lines[lines.indexOf('Source b (/p/b): available') + 1]).toBe('  No workers.');
  expect((await run(['--json'])).text).toBe(JSON.stringify(report) + '\n');
  expect(await run(['--verbose', '--samples', '1'], 'watch')).toEqual(human);
  expect((await run(['--samples', '1', '--json'], 'watch')).text).toBe(JSON.stringify(report) + '\n');
});

it('C-DOCTOR: the default view lists only open workers with a summary first; --all adds history; lost workers name the next step', async () => {
  registerProviderConfig(); // the host registers the `terminal` section (terminal.scopeId) at ingress
  const root = await mkdtemp(join(tmpdir(), 'dn-workers-view-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') }, terminal: { scopeId: 's' } }));
  const run = async (args: string[], lang = 'en') => { const out: string[] = [];
    const code = await main(['workers', ...args, '--lang', lang], { root, env: { HOME: join(root, 'h'), USERPROFILE: join(root, 'h') }, initialize() {},
      stdout: { write(v: string) { out.push(v); } }, stderr: { write() {} }, async inspectWorkers() { return report; } } as never); return { code, text: out.join('') }; };
  // `list` without --scope reads the configured scope (a read never needs a flag) and says so on the first line.
  const view = await run(['list']); expect(view.code).toBe(0);
  const lines = view.text.split('\n');
  expect(lines[0]).toBe('scope: s (default) · 1 running · 1 need attention · 3 in history');
  expect(view.text).toContain('Source a has more records: add --after cursor9');
  for (const header of ['Task', 'Run', 'State', 'Model', 'Duration', 'CPU (cores)', 'Memory', 'Last signal']) expect(view.text).toContain(header);
  expect(view.text).toMatch(/t2 +run1 +running, signal old +codex/u);
  expect(view.text).not.toMatch(/\bt1\b/u); // finished: history only
  expect(view.text).not.toMatch(/\bt5\b/u); // released custody: history only
  expect(view.text).toContain('Task t4: its process could not be checked');
  expect(view.text).toContain('To follow work live: deckent monitor');
  const all = await run(['list', '--all']);
  expect(all.text).toMatch(/t1 +run1 +finished +gpt-exact-1 +24\.7 s/u);
  expect(all.text).toMatch(/t3 +run1 +finished with error/u);
  const tr = await run(['list', '--all'], 'tr');
  expect(tr.text.split('\n')[0]).toBe('scope: s (varsayılan) · 1 çalışan · 1 dikkat bekleyen · 3 geçmiş');
  expect(tr.text).toContain('hatayla bitti');
  // A lost worker (no process, no result) names the command that shows its Run.
  const lost = { ...report, sources: [{ ...report.sources[0]!, workers: [{ ...base, taskId: 't9', identity: id('t9', 'lostlostlost'), provider: 'codex', process: 'missing', terminal: null }] }] };
  const out: string[] = [];
  await main(['workers', 'list', '--lang', 'en'], { root, env: { HOME: join(root, 'h') }, initialize() {}, stdout: { write(v: string) { out.push(v); } }, stderr: { write() {} },
    async inspectWorkers() { return lost; } } as never);
  expect(out.join('')).toContain('Task t9: no process and no result. Look at its Run (recovery decides what happens next): deckent run inspect --scope s --run run1');
  expect(JSON.parse((await run(['list', '--json'])).text)).toEqual(report);
});
it('C-DOCTOR: no scope flag and no configured scope off a terminal names the valid scopes (exit 2); an unknown scope keeps SCOPE_UNKNOWN and lists them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dn-workers-scope-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true }); await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') } }));
  const errors: string[] = [];
  const context = { root, env: { HOME: join(root, 'h') }, initialize() {}, stdout: { write() {} }, stderr: { write(v: string) { errors.push(v); } },
    configChoiceSources: () => ({ async list() { return [{ value: 'live' }, { value: 'pilot' }]; } }),
    async inspectWorkers() { throw Object.assign(new Error('SCOPE_UNKNOWN'), { code: 'SCOPE_UNKNOWN' }); } };
  expect(await main(['workers', 'list', '--lang', 'en'], context as never)).toBe(2);
  expect(errors.join('')).toContain('Valid scopes: live, pilot');
  errors.length = 0;
  expect(await main(['workers', 'list', '--scope', 'nope', '--lang', 'en'], context as never)).toBe(1);
  expect(errors.join('')).toContain('Scope nope is not one you can read here. Valid scopes: live, pilot');
  expect(errors.join('')).toContain('SCOPE_UNKNOWN'); // the refusal itself is unchanged (company-aware authorization)
  errors.length = 0;
  expect(await main(['workers', 'list', '--scope', 'nope', '--json'], context as never)).toBe(1);
  expect(errors.join('')).not.toContain('Valid scopes'); // --json: one typed error, no human line
});
