import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { MEMORY_ROLLOUT, memoryRolloutView, type MemoryRolloutMeasures, type MemoryRolloutModes, type MemoryRolloutStatus } from '#engine/index.js';
import { memoryCommand } from '#surfaces/core/cli-memory/index.js';

// S4B-7 (S4B-DESIGN rev 4 §11, §13; owner S-M14): `deckent memory rollout` is a read (an AI tool, a pipe and --json may read it); it shows the phase,
// every exit criterion of the two live switches with its numbers, the exact next person command, the provisional retention and that it enables nothing.
registerProviderConfig();
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-memory-rollout-cli-')); roots.push(root);
  const home = join(root, 'home'), dir = join(root, 'project');
  await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(dir, '.deckent', 'config.json'), JSON.stringify({ terminal: { scopeId: 'scope' } }), { mode: 0o600 });
  return { root: dir, env: { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', CLAUDECODE: '1' } };
}
const capture = () => { let text = ''; return { text: () => text, sink: { write: (chunk: string) => { text += chunk; return true; } } }; };
const pipe = () => Object.assign(Readable.from([]), { isTTY: false });
const m = (count: number, sample: number, complete = true, of: number | null = null) => ({ count, sample, of, complete });
const measures: MemoryRolloutMeasures = { 'context-shadow-runs': m(20, 20), 'context-overflow': m(0, 20), 'context-integrity-violations': m(0, 21), 'candidate-secret-findings': m(0, 3),
  'purge-replay-pending': m(0, 0), agreement: m(17, 20), 'decided-since-false-pass': m(1, 12), corpus: m(0, 31, false, 32), 'independence-violations': null, 'contest-rate': m(2, 20) };
const status = (modes: MemoryRolloutModes): MemoryRolloutStatus => ({ schemaVersion: 1, status: 'ok', scopeId: 'scope', registry: { revision: MEMORY_ROLLOUT.revision, status: 'provisional' },
  modes, view: memoryRolloutView(modes, measures), corpus: { revision: 'memory-injection-corpus-1', items: 32 },
  retention: { revision: 'memory-automation-core-1', status: 'provisional', rows: [{ workClassId: 'small', profileId: 'provisional-90d', entryMaxAgeMs: 90 * 86_400_000 }],
    verified: 4, stale: 1, oldestSupportAgeMs: 37 * 86_400_000, complete: true } });
const shadow: MemoryRolloutModes = { extraction: 'on', verification: 'shadow', context: 'shadow' };

it('EN: phase, switches, both gated phases with numbers, the exact next command, the provisional retention; a pipe under an AI tool may read it', async () => {
  const f = await project(), out = capture(), asked: unknown[] = [];
  await memoryCommand(['memory', 'rollout', '--lang', 'en'], { root: f.root, env: f.env, stdin: pipe(), stdout: out.sink,
    inspectMemoryRollout: async (_root, scopeId) => { asked.push(scopeId); return status(shadow); } });
  expect(asked).toEqual(['scope']);
  const text = out.text();
  for (const line of [
    'Memory rollout in scope scope: phase 2 — the memory part is computed and sealed in shadow (nothing is sent).',
    'Switches: extraction on · verification shadow · context shadow.',
    'Exit criteria of phase 3 (person-verified entries reach the worker and the Brain as data):',
    '  [met] context-admissions: 20 shadow Run admissions sealed a memory part (needs 20).',
    '  [met] context-overflow: 0 of 20 shadow parts would not fit the prompt (allowed: 0).',
    'Exit criteria of phase 4 (the independent evaluator verifies; its entries serve low-risk work only):',
    '  [not met] evaluator-agreement: evaluator and person agree on 17 of 20 decided candidates (85.0%); needs at least 20 decided and ≥ 90.0%.',
    '  [not met] evaluator-false-pass: 12 candidates decided since the last false pass (needs 30); false passes seen: 1.',
    '  [not met] injection-corpus: 31 of 32 poisoning-set items evaluated or screened out, 0 passed (needs every item and at most 0 passes). (newest records only)',
    '  [not met] evaluator-independence: could not be read; counts as not met.',
    '  [met] contest-rate: 2 of 20 decisive records named a conflict (10.0%); needs at least 20 records and ≤ 10.0%.',
    'Next: phase 3 — person-verified entries reach the worker and the Brain as data. Every criterion holds; a person may switch it at their own terminal: deckent config set memoryAutomation.context.mode on --scope scope',
    'Retention (provisional until measured on this installation, registry memory-automation-core-1): small 90 d (provisional-90d).',
    'Verified entries: 4, stale 1, oldest last support 37 d ago.',
    'Rollout registry memory-rollout-core-1 (provisional until measured on this installation); poisoning set memory-injection-corpus-1 (32 items).',
    "This status enables nothing; meeting the criteria only allows a person's switch.",
  ]) expect(text).toContain(line);
});
it('TR: a live phase whose criteria no longer hold is warned with the step-back command; a blocked next phase says how many criteria are unmet', async () => {
  const f = await project(), out = capture();
  await memoryCommand(['memory', 'rollout', '--scope', 'scope', '--lang', 'tr'], { root: f.root, env: f.env, stdin: pipe(), stdout: out.sink,
    inspectMemoryRollout: async () => ({ ...status({ ...shadow, context: 'on' }), view: memoryRolloutView({ ...shadow, context: 'on' }, { ...measures, 'context-overflow': m(2, 20) }) }) });
  const text = out.text();
  expect(text).toContain('scope kapsamında hafıza geçişi: 3. aşama — kişinin doğruladığı kayıtlar işçiye ve Brain\'e veri olarak gider.');
  expect(text).toContain('  [sağlanmadı] context-overflow: 20 gölge parçanın 2 tanesi isteme sığmazdı (izin verilen: 0).');
  expect(text).toContain('Uyarı: 3. aşama açık ama ölçütleri şu an sağlanmıyor (context-overflow); bir kişi geri alabilir: deckent config set memoryAutomation.context.mode shadow --scope scope');
  expect(text).toContain('Sıradaki: 4. aşama — bağımsız değerlendirici doğrular; doğruladığı kayıtlar yalnız düşük riskli işe gider. Henüz açılamaz: 4 ölçüt sağlanmadı.');
  expect(text).toContain('Bu durum hiçbir şeyi açmaz; ölçütlerin sağlanması yalnız bir kişinin anahtarı açmasına izin verir.');
});
it('--json prints the typed status; a held read exits 1 with its next step and is never shown as an empty rollout; an unwired surface is unavailable', async () => {
  const f = await project(), json = capture();
  await memoryCommand(['memory', 'rollout', '--scope', 'scope', '--json'], { root: f.root, env: f.env, stdin: pipe(), stdout: json.sink, inspectMemoryRollout: async () => status(shadow) });
  expect(JSON.parse(json.text())).toMatchObject({ status: 'ok', scopeId: 'scope', view: { phase: 2, next: { phase: 3, met: true } } });
  const err = capture();
  expect(await memoryCommand(['memory', 'rollout', '--scope', 'scope', '--lang', 'en'], { root: f.root, env: f.env, stdin: pipe(), stdout: capture().sink, stderr: err.sink,
    inspectMemoryRollout: async () => ({ schemaVersion: 1, status: 'held', code: 'MEMORY_PURGE_REPLAY_HELD' }) })).toBe(1);
  expect(err.text()).toContain('MEMORY_PURGE_REPLAY_HELD');
  await expect(memoryCommand(['memory', 'rollout', '--scope', 'scope'], { root: f.root, env: f.env, stdin: pipe(), stdout: capture().sink })).rejects.toMatchObject({ code: 'MEMORY_UNAVAILABLE' });
  await expect(memoryCommand(['memory', 'rollout', 'extra', '--scope', 'scope'], { root: f.root, env: f.env, stdin: pipe(), stdout: capture().sink, inspectMemoryRollout: async () => status(shadow) }))
    .rejects.toMatchObject({ code: 'CLI_USAGE' });
});
