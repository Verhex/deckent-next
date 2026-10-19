import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { clearConfigCache } from '#platform/index.js';
import { summarizeWorkCosts } from '#domain/index.js';
import { inventoryCommand, renderHumanReport, reportCommand, runControlFlow, runControls, runList } from '#surfaces/core/cli-run/index.js';
import { runControlActions } from '#surfaces/core/terminal-work/index.js';

/**
 * C-RUN (alpha.48, CLI review §run, §report, §inventory): the run family for a person — `run list` over the `/runs` query, short ids,
 * `run inspect` in reading order with internal records under --verbose, TTY Run controls (picker, revision read by the system, card naming
 * scope and Run), the report's Known / Not measurable sections and the inventory's default scope, table and limit text.
 */
const ESC = '\u001b';
const LONG = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90', OTHER = 'a1b2ffff00000000000000000000000000000000000000000000000000000000';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project(config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-cli-run-human-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') }, ...config }));
  return root;
}
function sinks() {
  const out: string[] = [], err: string[] = [];
  return { out, err, stdout: { write(value: string) { out.push(value); return true; } }, stderr: { write(value: string) { err.push(value); return true; } } };
}
async function run(argv: string[], handlers: Record<string, unknown>, root: string, env: Record<string, string> = {}) {
  const s = sinks();
  const code = await main(argv, { root, env: { HOME: join(root, 'h'), USERPROFILE: join(root, 'h'), NO_COLOR: '1', ...env }, initialize() {}, stdin: { isTTY: false },
    stdout: s.stdout, stderr: s.stderr, ...handlers } as never);
  return { code, text: s.out.join(''), err: s.err.join('') };
}
const brief = (task: string) => ({ schemaVersion: 1, task, scopePaths: null, acceptance: null, criteria: [], profile: null, model: null, effort: null, contextRefs: [] });
type Task = Record<string, unknown>;
function view(tasks: readonly Task[] = [{}], extra: Record<string, unknown> = {}) {
  return { schemaVersion: 3, runId: LONG, scopeId: 's', layoutRevision: 'l', registryRevision: 'reg', revision: 7, cancellationRequested: false, state: { kind: 'running' },
    criteria: [{ id: 'exit', version: 1, description: 'Exit cleanly', evaluator: { id: 'process-exit', version: 1 }, fingerprint: 'f'.repeat(64) }],
    tasks: tasks.map((task, index) => ({ id: `t${index}`, kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'], profile: { id: 'coding', version: 3 }, phase: 'active',
      unresolvedEffects: false, ...task })), ...extra };
}
/** A context whose Run store holds the given views; every read and write is recorded. */
function store(views: readonly ReturnType<typeof view>[]) {
  const calls: string[] = [], byId = new Map(views.map(item => [item.runId, item]));
  return { calls, byId, context: {
    async inspectSurfaceRunIds(_root: string, scopeId: string) { calls.push(`ids:${scopeId}`); return views.map(item => item.runId); },
    async inspectRun(_root: string, query: { runId: string }) { calls.push(`inspect:${query.runId.slice(0, 6)}`); return { schemaVersion: 1, layout: {}, run: byId.get(query.runId) ?? null }; },
    async applyRunLifecycle(_root: string, command: Record<string, unknown>) { calls.push(`apply:${JSON.stringify(command)}`); const current = byId.get(command['runId'] as string)!;
      return { schemaVersion: 1, lifecycle: { schemaVersion: 1, commandId: command['commandId'], run: { ...current, revision: current.revision + 1 } } }; },
    async deliverRunCancellation(_root: string, command: Record<string, unknown>) { calls.push(`cancel:${JSON.stringify(command)}`);
      return { schemaVersion: 1, delivery: { schemaVersion: 1, runId: command['runId'], outcomes: [] } }; },
  } };
}
const scripted = (answers: (string | null)[]) => { const asked: { title: string; body?: readonly string[]; options: readonly { id: string; label: string }[] }[] = [];
  return { asked, ask: async (request: (typeof asked)[number]) => { asked.push(request); return answers.shift() ?? null; } }; };

it('run list reads the /runs query, lists waiting Runs first with short ids and the /runs state words (EN and TR), and names the default scope', async () => {
  registerProviderConfig();
  const root = await project({ terminal: { scopeId: 's' } });
  const parked = { ...view([{ taskBrief: { ...brief('Answer the auditor'), title: 'Auditor question' }, phase: 'awaiting-decision' }]), runId: OTHER,
    state: { kind: 'parked', reason: 'needs-input', since: 1, deadline: 2 } };
  const s = store([view([{ taskBrief: brief(`Post the invoice\nsecond line`), phase: 'accepted' }, {}]), parked]);
  for (const [locale, words] of [['en', ['a1b2c3', 'a1b2ff', 'parked (needs your input)', 'running', '1/2', 'Post the invoice', 'scope: s (default)']],
    ['tr', ['bekletildi: sizden bilgi bekliyor', 'çalışıyor', 'scope: s (varsayılan)', 'gösterildi']]] as const) {
    const out = sinks();
    await runList(new Map(), false, { ...s.context, root, env: { HOME: join(root, 'h'), NO_COLOR: '1' }, locale, stdin: { isTTY: false }, stdout: out.stdout } as never, locale);
    const text = out.out.join('');
    for (const word of words) expect(text).toContain(word);
    expect(text.indexOf('a1b2ff')).toBeLessThan(text.indexOf('a1b2c3')); // waiting first, although it is the older id in the query
    expect(text).not.toContain(LONG); expect(text).not.toContain('second line');
  }
  expect(s.calls.filter(call => call.startsWith('ids:'))).toEqual(['ids:s', 'ids:s']);
  const json = sinks();
  await runList(new Map([['--scope', 's']]), true, { ...s.context, root, stdout: json.stdout } as never, 'en');
  expect(JSON.parse(json.out.join(''))).toMatchObject({ schemaVersion: 1, scopeId: 's', runs: [{ runId: OTHER }, { runId: LONG }] });
});

it('run list off a terminal without a scope or a configured default refuses with the valid scopes (CLI_SCOPE_REQUIRED, exit 2)', async () => {
  const root = await project();
  const s = store([view()]);
  await expect(runList(new Map(), false, { ...s.context, root, env: { HOME: join(root, 'h') }, stdin: { isTTY: false }, stdout: sinks().stdout,
    configChoiceSources: () => ({ async list() { return [{ value: 's' }, { value: 'live' }]; } }) } as never, 'en'))
    .rejects.toMatchObject({ code: 'CLI_SCOPE_REQUIRED', params: { scopes: 's, live' } });
  expect(s.calls).toEqual([]);
});

it('a short id resolves on inspect and on the AI control path; an ambiguous prefix refuses before any read; an unknown one reads as typed (RUN_NOT_FOUND, TR, exit 1)', async () => {
  const root = await project();
  const s = store([view(), { ...view(), runId: OTHER }]);
  const inspected = await run(['run', 'inspect', '--scope', 's', '--id', 'a1b2c3', '--lang', 'en'], s.context, root);
  expect(inspected.code).toBe(0); expect(s.calls).toContain('inspect:a1b2c3'); expect(inspected.text).toContain('Run a1b2c3d4 |');
  s.calls.length = 0;
  const ambiguous = await run(['run', 'inspect', '--scope', 's', '--id', 'a1b2', '--json'], s.context, root);
  expect(ambiguous.code).toBe(2); expect(JSON.parse(ambiguous.err).code).toBe('CLI_ID_AMBIGUOUS'); expect(s.calls).toEqual(['ids:s']);
  const missing = await run(['run', 'inspect', '--scope', 's', '--id', 'ffff0000', '--lang', 'tr'], s.context, root);
  expect(missing.code).toBe(1); expect(missing.err).toContain('Kayıtlı Run bulunamadı: ffff0000.');
  s.calls.length = 0;
  const cancelled = await run(['run', 'cancel', '--scope', 's', '--id', 'a1b2ff', '--command-id', 'c-1', '--expected-revision', '7', '--json'], s.context, root);
  expect(cancelled.code).toBe(0); expect(s.calls.find(call => call.startsWith('cancel:'))).toContain(`"runId":"${OTHER}"`);
});

it('negative: the AI and pipe control path still requires --command-id and --expected-revision and writes nothing without them', async () => {
  const root = await project();
  const s = store([view()]);
  for (const [argv, env] of [[['run', 'cancel', '--scope', 's', '--id', LONG, '--command-id', 'c-1'], {}], [['run', 'hold', '--scope', 's', '--id', LONG, '--reason', 'r'], {}],
    [['run', 'close', '--scope', 's', '--id', LONG], { CLAUDECODE: '1' }]] as const) {
    const result = await run([...argv], s.context, root, env);
    expect(result.code).toBe(2); expect(result.err).toContain('CLI_USAGE');
  }
  // An agent on a real terminal is never asked: the same refusal.
  const tty = sinks();
  const code = await main(['run', 'close', '--scope', 's', '--id', LONG], { root, env: { HOME: join(root, 'h'), CLAUDECODE: '1' }, initialize() {}, stdin: { isTTY: true, setRawMode() {} },
    stdout: { ...tty.stdout, isTTY: true }, stderr: tty.stderr, ...s.context } as never);
  expect(code).toBe(2);
  expect(s.calls.filter(call => call.startsWith('apply:') || call.startsWith('cancel:'))).toEqual([]);
});

it('TTY control: the picker offers only Runs whose state allows it; declined or cancelled cards write nothing', async () => {
  registerProviderConfig();
  const root = await project({ terminal: { scopeId: 's' } });
  const finished = { ...view(), runId: OTHER, state: { kind: 'terminal', outcome: 'completed', reason: 'completed' } };
  for (const answers of [['s', LONG, 'no'], ['s', LONG, null], [null]]) {
    const s = store([view(), finished]), printed: string[] = [], cards = scripted([...answers]);
    await runControlFlow('cancel', { ...s.context, root, configChoiceSources: () => ({ async list() { return [{ value: 's' }]; } }) } as never,
      { locale: 'en', root, options: { env: { HOME: join(root, 'h') } }, ask: cards.ask as never, print: text => printed.push(text) }, {});
    expect(s.calls.filter(call => call.startsWith('apply:') || call.startsWith('cancel:'))).toEqual([]);
    if (answers.length > 1) {
      expect(cards.asked[1]!.options.map(option => option.id)).toEqual([LONG]); // the finished Run is not offered
      expect(cards.asked[1]).toMatchObject({ initial: LONG }); // Enter takes the first (waiting first, newest) Run
      expect(printed.join('\n')).toContain('Run a1b2c3d4 was not cancelled.'); // the terminal /cancel words
    } else expect(printed).toEqual(['Nothing was sent.']);
    // A change never takes the configured default silently: the scope card came first, the default preselected.
    expect(cards.asked[0]).toMatchObject({ initial: 's' });
  }
});

it('TTY hold: the revision is read just before the card, the card names scope and Run, the command id comes from the system; a stale Run is read again and asked again', async () => {
  const root = await project();
  const s = store([view([{ taskBrief: { ...brief('Close the books'), title: 'Month-end close' } }])]);
  let conflict = true;
  const apply = s.context.applyRunLifecycle;
  s.context.applyRunLifecycle = async (r: string, command: Record<string, unknown>) => {
    if (conflict) { conflict = false; s.byId.set(LONG, { ...s.byId.get(LONG)!, revision: 9 }); throw Object.assign(new Error('stale'), { code: 'RUN_STORE_CONFLICT' }); }
    return apply(r, command);
  };
  const printed: string[] = [], cards = scripted(['yes', 'yes']);
  await runControlFlow('hold', s.context as never, { locale: 'tr', root, options: { env: {} }, ask: cards.ask as never, print: text => printed.push(text) }, { scopeId: 's', runId: 'a1b2c3' });
  expect(cards.asked).toHaveLength(2);
  expect(cards.asked[0]!.title).toContain('Month-end close');
  expect(cards.asked[0]!.body!.join('\n')).toContain('Kapsam: s'); expect(cards.asked[0]!.body!.join('\n')).toContain('revizyon 7');
  expect(cards.asked[1]!.body!.join('\n')).toContain('revizyon 9');
  expect(cards.asked[0]!.body!.join('\n')).toContain('Bekletmeyi deckent run resume kaldırır'); // no window key on a CLI card
  expect(cards.asked[1]!.body!.join('\n')).toContain('Run bu arada değişti');
  const write = s.calls.find(call => call.startsWith('apply:'))!;
  expect(JSON.parse(write.slice(6))).toMatchObject({ action: 'hold', runId: LONG, scopeId: 's', expectedRevision: 9, holdReason: 'Kişi Deckent terminalinde bekletti.' });
  expect(JSON.parse(write.slice(6)).commandId).toMatch(/^cli-run-hold-/u);
  expect(printed.join('\n')).toContain('bekletme kaydedildi');
});

// J2e join (lead note on the C-RUN review flag "test-coverage"): the accepted card path of cancel and close, not only declines.
it('TTY cancel and close: a yes sends one command with a system command id at the revision read before the card; close advances the revision', async () => {
  const root = await project();
  for (const action of ['cancel', 'close'] as const) {
    const s = store([view()]), printed: string[] = [], cards = scripted(['yes']);
    await runControlFlow(action, s.context as never, { locale: 'en', root, options: { env: {} }, ask: cards.ask as never, print: text => printed.push(text) }, { scopeId: 's', runId: 'a1b2c3' });
    expect(cards.asked).toHaveLength(1);
    const writes = s.calls.filter(call => call.startsWith('apply:') || call.startsWith('cancel:'));
    expect(writes).toHaveLength(1);
    const sent = JSON.parse(writes[0]!.slice(writes[0]!.indexOf(':') + 1)) as Record<string, unknown>;
    expect(writes[0]!.startsWith(action === 'cancel' ? 'cancel:' : 'apply:')).toBe(true);
    expect(sent).toMatchObject({ runId: LONG, scopeId: 's', expectedRevision: 7, ...(action === 'close' ? { action: 'close' } : { action: 'cancel' }) });
    expect(sent['commandId']).toMatch(new RegExp(`^cli-run-${action}-[0-9a-f-]{36}$`, 'u'));
    if (action === 'close') expect(printed.join('\n')).toContain('(revision 8)');
  }
});

it('the TTY control offer equals the terminal /runs keys for hold, resume and close in every Run state', () => {
  const states = [{ kind: 'running' }, { kind: 'terminal', outcome: 'failed', reason: 'completed' },
    ...['dependency-failed', 'dependency-cancelled', 'awaiting-decision', 'evaluation-not-ready', 'needs-input', 'operator-hold', 'progression-failed', 'quota-exhausted']
      .map(reason => ({ kind: 'parked', reason, since: 1, deadline: 2 })), { kind: 'parked', reason: 'needs-input', since: 1, deadline: 2, operatorHold: { schemaVersion: 1, note: 'n' } }];
  for (const state of states) for (const cancellationRequested of [false, true]) {
    const runView = { ...view(), state, cancellationRequested } as never;
    expect(runControls(runView).filter(action => action !== 'cancel')).toEqual(runControlActions(runView));
  }
});

it('run inspect reads request → result → tasks → acceptance evidence kind → delivery; internal records are --verbose (EN/TR)', async () => {
  const root = await project();
  const accepted = view([{ taskBrief: { ...brief('Reconcile the ledger'), title: 'Ledger reconciliation' }, phase: 'accepted',
    resultBrief: { schemaVersion: 1, attemptId: 'a-1', evaluation: { verdict: 'accepted' }, report: { status: 'missing' }, deliveryOutlook: 'none' } }],
  { authority: { decision: { eventId: 'evt-1', sequence: 4 } } });
  const s = store([accepted]);
  for (const [locale, request, evidence] of [['en', 'Request: Ledger reconciliation', 'accepted on: exit code · content not independently verified'],
    ['tr', 'İstek: Ledger reconciliation', 'kabul: çıkış kodu']] as const) {
    const plain = await run(['run', 'inspect', '--scope', 's', '--id', LONG, '--lang', locale], s.context, root);
    expect(plain.code).toBe(0);
    const text = plain.text;
    expect(text).toContain(request); expect(text).toContain(evidence);
    expect(text.indexOf(request)).toBeLessThan(text.indexOf('t0 ('));
    expect(text).not.toContain('evt-1'); expect(text).not.toContain(LONG); expect(text).toContain('--verbose');
    const verbose = await run(['run', 'inspect', '--scope', 's', '--id', LONG, '--lang', locale, '--verbose'], s.context, root);
    expect(verbose.text).toContain('evt-1'); expect(verbose.text).toContain(LONG); expect(verbose.text).toContain('coding v3');
  }
  expect((await run(['run', 'inspect', '--scope', 's', '--id', LONG, '--verbose', '--json'], s.context, root)).code).toBe(2);
});

it('report: Known and Not measurable with a reason per axis, readable units, no escape sequences (EN and TR)', () => {
  const identity = { scopeId: 's', runId: LONG, taskId: 't0', attemptId: '0e1f2a3b-0000-4000-8000-000000000000', layoutRevision: 'l', generation: 1 };
  const attempt = { schemaVersion: 1, identity, profile: { id: 'coding', version: 3 }, model: { channelId: 'claude-cli-subscription', modelId: `claude-x${ESC}[2J`, evidence: 'requested' },
    effort: 'high', acceptance: { workClass: null, policyRevision: null, profileVersion: null, evaluationId: null, criteria: [], outcome: 'accepted', score: null, ceilingReasons: [] }, axes: { cpuSeconds: 0.49022299999999996, sampledPeakBytes: 583852032, kernelPeakBytes: null, wallMs: 20900,
      apiMoney: null, subscription: { calls: null, durationMs: 1, limit: null }, localModel: null, humanInterventions: null },
    quality: { reworkCount: null, rollbackCount: null, interventionCount: null, followup: 'unknown' }, coverage: 'partial', sampleCount: 3, gapCount: 0 };
  const report = summarizeWorkCosts({ scopeId: 's', runId: LONG, runRevision: 7, observedAtMs: 1, withheld: 1, attempts: [attempt as never] });
  for (const [locale, words] of [['en', ['Known', 'Not measurable', '0.49 s', '557 MB', '20.9 s', 'API charge: a subscription call has no per-call charge to measure (1 attempt(s))',
    'Human interventions: this version does not record it', '1 attempt(s) not shown']],
  ['tr', ['Bilinen', 'Ölçülemeyen', '0,49 sn', '557 MB', '20,9 sn', 'abonelik çağrısında çağrı başına ücret ölçülemez', 'bu sürüm bunu kaydetmiyor']]] as const) {
    const text = renderHumanReport(report, view() as never, { env: {} } as never, locale, false);
    for (const word of words) expect(text).toContain(word);
    expect(text).not.toContain(ESC); expect(text).not.toContain('583852032'); expect(text).not.toContain(identity.attemptId);
    expect(text.indexOf(locale === 'en' ? 'Known' : 'Bilinen')).toBeLessThan(text.indexOf(locale === 'en' ? 'Not measurable' : 'Ölçülemeyen'));
  }
});

it('bare report off a terminal: the default scope\'s recent Runs, one line each, and the command that reads one', async () => {
  registerProviderConfig();
  const root = await project({ terminal: { scopeId: 's' } });
  const s = store([view([{ taskBrief: { ...brief('x'), title: 'Payroll export' } }])]);
  // The handler itself (the catalog's `bare: 'handler'` for report is the lead's catalog delta; until then the dispatcher names --scope/--run).
  const out = sinks();
  await reportCommand(['report', '--lang', 'en'], { ...s.context, root, env: { HOME: join(root, 'h') }, stdin: { isTTY: false }, stdout: out.stdout } as never);
  const text = out.out.join('');
  expect(text).toContain('scope: s (default)'); expect(text).toContain('a1b2c3d4 · running · 0/1 tasks accepted · Payroll export');
  expect(text).toContain('deckent report --run <short id>');
});

it('inventory: default scope, short ids in a table, terminal-safe cells, the page limit names its maximum; --json unchanged', async () => {
  registerProviderConfig();
  const root = await project({ terminal: { scopeId: 's' }, inspection: { maxPageSize: 2 } });
  const identity = { scopeId: 's', runId: LONG, taskId: 't0', attemptId: '0e1f2a3b-0000-4000-8000-000000000000', layoutRevision: 'l', generation: 1 };
  const page = { schemaVersion: 1, layout: {}, page: { entries: [{ identity, owner: `worker${ESC}]0;evil${ESC}\\`, launch: 'granted', terminal: { exitCode: 0, signal: null }, cancellationRequested: false,
    outputRecorded: true }], nextAfter: identity.attemptId } };
  const queries: unknown[] = [];
  // The handler itself: the dispatcher's `inventory` entry moves to it with the lead's entry/catalog delta.
  const context = { async inspectInventory(_root: string, query: unknown) { queries.push(query); return page; }, root, env: { HOME: join(root, 'h') }, stdin: { isTTY: false } };
  const human = sinks();
  await inventoryCommand(['inventory', '--lang', 'tr'], { ...context, stdout: human.stdout } as never);
  const text = human.out.join('');
  expect(queries).toEqual([{ schemaVersion: 1, scopeId: 's', after: null }]);
  expect(text).toContain('scope: s (varsayılan)'); expect(text).toContain('a1b2c3d4'); expect(text).toContain('0e1f2a3b');
  expect(text).toContain(`--after ${identity.attemptId}`); expect(text).toContain('deckent run list');
  expect(text).not.toContain(ESC); expect(text).not.toContain('evil'); expect(text).not.toContain(LONG);
  await expect(inventoryCommand(['inventory', '--scope', 's', '--limit', '3', '--lang', 'tr'], { ...context, stdout: sinks().stdout } as never))
    .rejects.toMatchObject({ code: 'DISPATCH_INVENTORY_LIMIT', category: 'usage', suggestion: 'Sayfa başına en çok 2; --limit 2 kullanın.' });
  expect(queries).toHaveLength(1);
  const json = sinks();
  await inventoryCommand(['inventory', '--scope', 's', '--json'], { ...context, stdout: json.stdout } as never);
  expect(JSON.parse(json.out.join(''))).toEqual(page);
});
