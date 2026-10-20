import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { summarizeWorkCosts } from '#domain/index.js';
import { main } from '#surfaces/index.js';
import { formatBytes, formatClock, formatDuration, type CliCardRequest } from '#surfaces/core/cli-human/index.js';
import { renderCostReport, renderResourceDetail } from '#surfaces/core/monitor/index.js';
import { renderHumanReport } from '#surfaces/core/cli-run/index.js';

/*
 * PRE-5 CIKTI-OKUNUR (owner outputs 2026-10-20, analysis §6): a new user reads every human output without decoding it — bytes, seconds and
 * instants through the one shared formatter (`cli-human`), one language per output, an untitled Run named by its task, a picked report that
 * says how to get it again from a script, and an `init policy --preview` a person can read. `--json` shapes are unchanged.
 * A person's card is simulated here (the Ink card view is PTY-proven elsewhere).
 */
registerProviderConfig();
const card = vi.hoisted(() => ({ interactive: false, answers: [] as (string | null)[], asked: [] as CliCardRequest[] }));
vi.mock('#surfaces/core/cli-human/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('#surfaces/core/cli-human/index.js')>();
  return { ...real,
    cliMode: (context: Parameters<typeof real.cliMode>[0], json?: boolean) => card.interactive && !json ? { mode: 'interactive' as const, reason: 'tty' as const } : real.cliMode(context, json),
    askCliCard: async (request: CliCardRequest, io: Parameters<typeof real.askCliCard>[1]) => {
      if (!card.interactive) return real.askCliCard(request, io);
      card.asked.push(request); return card.answers.length ? card.answers.shift()! : null;
    } };
});
const roots: string[] = [];
beforeEach(() => { card.interactive = false; card.answers = []; card.asked = []; });
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project(config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-readable-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') }, ...config }));
  return root;
}
const sink = () => { const out: string[] = []; return { out, text: () => out.join(''), stream: { write(value: string) { out.push(value); return true; } } }; };

/** The owner's dogfood worker, as `workers --verbose` and the monitor showed it. */
const OWNER_RESOURCES = { schemaVersion: 1 as const, state: 'stale' as const, coverage: 'partial' as const, provisional: true as const, ageMs: 346_800_618,
  latest: { schemaVersion: 1, identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 }, worker: null, observedAtMs: 1, source: 'docker',
    cpuSeconds: 0.49022299999999996, cpuCores: 0.03, memoryBytes: 583_852_032, memoryLimitBytes: 2_147_483_648, kernelPeakBytes: 589_570_048, gap: null },
  sampleCount: 4, gapCount: 1, cpuSeconds: 0.49022299999999996, sampledPeakBytes: 583_852_032, trimmedBeforeMs: 1_791_928_729_382, reason: null };
const RAW = ['583852032', '2147483648', '346800618', '0.49022299999999996', '1791928729382', ' ms', 'bayt', 'bytes'];

it.each(['en', 'tr'] as const)('resource lines read in human units and a local date, never raw bytes, ms, float noise or an epoch (%s)', locale => {
  const text = renderResourceDetail(OWNER_RESOURCES as never, locale).join('\n');
  for (const raw of RAW) expect(text, raw).not.toContain(raw);
  for (const human of [formatBytes(583_852_032, locale), formatBytes(2_147_483_648, locale), formatDuration(346_800_618, locale), formatDuration(0.49022299999999996 * 1000, locale),
    formatClock(1_791_928_729_382, locale)]) expect(text, human).toContain(human);
  // No sample at all: one line that says so and why, not a row of "unknown" with units.
  const none = renderResourceDetail({ ...OWNER_RESOURCES, state: 'gap', ageMs: null, latest: null, sampleCount: 0, gapCount: 0, cpuSeconds: null, sampledPeakBytes: null,
    trimmedBeforeMs: null, reason: 'missing' } as never, locale);
  expect(none).toHaveLength(1);
  expect(none[0]).toContain(locale === 'tr' ? 'Saklanan örnek yok' : 'No retained sample');
  expect(none[0]).not.toMatch(locale === 'tr' ? /bilinmiyor/u : /unknown/u);
});

const attempt = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, identity: { scopeId: 's', runId: 'queue-verify-c51d', taskId: 'readme-clone-note',
  attemptId: 'ef257c6e-008a-4137-bd24-8a0a578886c7', layoutRevision: 'l', generation: 1 }, profile: { id: 'verify-light', version: 2 }, model: null, effort: null,
  acceptance: { workClass: null, policyRevision: null, profileVersion: null, evaluationId: null, criteria: [], outcome: 'accepted', score: null, ceilingReasons: [] },
  axes: { cpuSeconds: 24.990560000000002, sampledPeakBytes: 1_435_103_232, kernelPeakBytes: null, wallMs: 32_295, apiMoney: null,
    subscription: { calls: null, durationMs: 23_436, limit: null }, localModel: null, humanInterventions: null },
  quality: { reworkCount: null, rollbackCount: null, interventionCount: null, followup: 'unknown' }, coverage: 'partial', sampleCount: 6, gapCount: 1, ...overrides });

it.each(['en', 'tr'] as const)('report --verbose: every raw axis in human units, unknown money without a currency, Turkish without English nouns (%s)', locale => {
  const report = summarizeWorkCosts({ scopeId: 's', runId: 'queue-verify-c51d', runRevision: 3, observedAtMs: 1, withheld: 0, attempts: [attempt() as never] });
  const text = renderCostReport(report, locale);
  for (const raw of ['24.990560000000002', '1435103232', '32295', '23436', 'unknown USD', 'bilinmiyor USD', ' ms', 'bayt']) expect(text, raw).not.toContain(raw);
  for (const human of [formatDuration(24.990560000000002 * 1000, locale), formatBytes(1_435_103_232, locale), formatDuration(32_295, locale), formatDuration(23_436, locale)])
    expect(text, human).toContain(human);
  if (locale === 'tr') for (const english of ['Task ', 'Attempt', 'effort', 'kabul kabul']) expect(text, english).not.toContain(english);
  expect(renderHumanReport(report, { criteria: [], tasks: [] } as never, { env: {} } as never, locale, true)).not.toContain('24.990560000000002');
});

const LONG = 'c51d5b2350cafd7f84d2a05bead33c7502f91fb2de47401d94e03b987cad5220';
function verifyRun() {
  // A delivery-queue verify Run records no brief: only its task id and kind.
  return { schemaVersion: 3, runId: LONG, scopeId: 's', layoutRevision: 'l', registryRevision: 'reg', revision: 3, cancellationRequested: false,
    state: { kind: 'terminal', outcome: 'completed', reason: 'completed' }, criteria: [],
    tasks: [{ id: 'readme-clone-note', kind: 'verify', dependencies: [], acceptanceCriteria: [], profile: { id: 'verify-light', version: 2 }, phase: 'accepted', unresolvedEffects: false }],
    costReport: summarizeWorkCosts({ scopeId: 's', runId: LONG, runRevision: 3, observedAtMs: 1, withheld: 0, attempts: [attempt({ identity: { ...attempt().identity, runId: LONG } }) as never] }) };
}
const runs = (run: ReturnType<typeof verifyRun>) => ({ async inspectSurfaceRunIds() { return [run.runId]; },
  async inspectRun() { return { schemaVersion: 1, layout: {}, run }; } });

it.each([['en', 'readme-clone-note (verify task)', 'Untitled'], ['tr', 'readme-clone-note (verify işi)', 'Başlıksız']] as const)(
  'an untitled Run is named by its task and kind in the report list, never "untitled work" (%s)', async (locale, name, untitled) => {
    const root = await project({ terminal: { scopeId: 's' } }), out = sink();
    expect(await main(['report', '--lang', locale], { root, env: { HOME: join(root, 'h'), NO_COLOR: '1' }, initialize() {}, stdin: { isTTY: false }, stdout: out.stream, ...runs(verifyRun()) } as never)).toBe(0);
    expect(out.text()).toContain(name); expect(out.text()).not.toContain(untitled);
  });

it('a report picked on a terminal names the command that prints it again from a script; --run takes a short id without a picker', async () => {
  const root = await project({ terminal: { scopeId: 's' } });
  card.interactive = true; card.answers = [LONG];
  const out = sink();
  expect(await main(['report', '--scope', 's', '--verbose', '--lang', 'en'], { root, env: { HOME: join(root, 'h'), NO_COLOR: '1' }, initialize() {}, stdout: out.stream, ...runs(verifyRun()) } as never)).toBe(0);
  expect(card.asked).toHaveLength(1);
  expect(card.asked[0]!.options[0]!.label).toContain('readme-clone-note (verify task)');
  expect(out.text()).toContain('deckent report --scope s --run c51d5b23 --verbose');
  card.interactive = false; card.asked = [];
  const script = sink();
  expect(await main(['report', '--scope', 's', '--run', 'c51d5b23', '--lang', 'en'], { root, env: { HOME: join(root, 'h'), NO_COLOR: '1' }, initialize() {}, stdin: { isTTY: false },
    stdout: script.stream, ...runs(verifyRun()) } as never)).toBe(0);
  expect(card.asked).toEqual([]); expect(script.text()).toContain('readme-clone-note');
  expect(script.text()).not.toContain('deckent report --scope s --run'); // nothing was picked: no re-run line
});

/** The shape `init policy --preview` returns (first-run template, trimmed to three rules). */
const PREVIEW = { schemaVersion: 1, status: 'preview', scopeId: 'demo', principal: { issuer: 'host', subject: '1000' }, template: { id: 'first-run-template', version: 13 },
  planDigest: '423b0b7103ae611c9cbe3b4476fdb54332b3e3422fb679340a51087b01399dad', transactionId: '5d8bed61b4c4727bf4f18fc0bd12aa6774b691cfbd0d4d605948a27296bac2d9',
  paths: { policy: '/p/.deckent/policy.json', bindings: '/p/.deckent/bindings.json' },
  policy: { schemaVersion: 2, revision: 'first-run-template-v13', roles: [], restrictions: [], separationOfDuties: [],
    grants: [
      { id: 'first-run-read-tools', actions: ['invoke'], scopes: ['demo'], principals: [{ issuer: 'host', subject: '1000' }], resource: { kind: 'agent-tool', ids: ['read_file', 'grep'] }, effect: 'allow' },
      { id: 'first-run-edit-shell-tools', actions: ['invoke'], scopes: ['demo'], principals: [{ issuer: 'host', subject: '1000' }], resource: { kind: 'agent-tool', ids: ['edit_file', 'run_shell'] },
        effect: 'require-approval', modeEligible: true },
      { id: 'first-run-runs', actions: ['create', 'inspect'], scopes: ['demo'], principals: [{ issuer: 'host', subject: '1000' }], resource: { kind: 'run' }, effect: 'allow' }],
    approvalAssurance: [{ id: 'first-run-hard-floor-cards', scopes: ['demo'], subject: 'agent-tool-call', cells: ['edit-floor', 'mcp-floor'], minimum: 'turn-bound' }] },
  bindings: { schemaVersion: 1, revision: 'first-run-template-v13-bindings', bindings: [] },
  serviceIdentity: { status: 'kept', identity: { scopeId: 'demo', serviceId: 'demo-runtime' } } };

it.each(['en', 'tr'] as const)('init policy --preview reads as a plan a person can check: what is written, every rule in words, the next command; --json unchanged (%s)', async locale => {
  const root = await project(), out = sink(), handlers = { async previewPolicyTemplateInstallation() { return PREVIEW; } };
  expect(await main(['init', 'policy', '--scope', 'demo', '--preview', '--lang', locale], { root, env: { HOME: join(root, 'h') }, initialize() {}, stdout: out.stream, ...handlers } as never)).toBe(0);
  const text = out.text();
  expect(text).not.toContain('{'); expect(text).not.toContain('"schemaVersion"');
  for (const word of ['first-run-template', '13', 'demo', '/p/.deckent/policy.json', 'first-run-read-tools', 'read_file, grep', 'first-run-edit-shell-tools', 'first-run-runs',
    'first-run-hard-floor-cards', 'deckent init policy --scope demo --apply', 'deckent init policy --scope demo --preview --json']) expect(text, word).toContain(word);
  expect(text).toContain(locale === 'tr' ? 'hiçbir şey yazılmadı' : 'nothing was written');
  expect(text).toContain(locale === 'tr' ? 'her seferinde onay' : 'approval each time');
  const json = sink();
  expect(await main(['init', 'policy', '--scope', 'demo', '--preview', '--json'], { root, env: { HOME: join(root, 'h') }, initialize() {}, stdout: json.stream, ...handlers } as never)).toBe(0);
  expect(JSON.parse(json.text())).toEqual(PREVIEW);
});

it('the re-run command after a pick names an id prefix that is unique among every Run --run resolves against, not only the offered ones', async () => {
  const root = await project({ terminal: { scopeId: 's' } });
  // 21 Runs: the picker offers the first 20 (run.json list.runsShown); the 21st shares the first eight characters with the picked one.
  const ids = [`aaaaaaaa1${'0'.repeat(55)}`, ...Array.from({ length: 19 }, (_, index) => `b${String(index).padStart(63, '0')}`), `aaaaaaaa2${'0'.repeat(55)}`];
  const views = new Map(ids.map(runId => [runId, { ...verifyRun(), runId }]));
  card.interactive = true; card.answers = [ids[0]!];
  const out = sink();
  expect(await main(['report', '--scope', 's', '--lang', 'en'], { root, env: { HOME: join(root, 'h'), NO_COLOR: '1' }, initialize() {}, stdout: out.stream,
    async inspectSurfaceRunIds() { return ids; }, async inspectRun(_root: string, query: { runId: string }) { return { schemaVersion: 1, layout: {}, run: views.get(query.runId) ?? null }; } } as never)).toBe(0);
  expect(card.asked[0]!.options).toHaveLength(20);
  expect(out.text()).toContain(`deckent report --scope s --run ${ids[0]!.slice(0, 9)}`);
});
