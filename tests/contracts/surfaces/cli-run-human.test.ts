import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { clearConfigCache } from '#platform/index.js';
import { summarizeWorkCosts } from '#domain/index.js';
import { inventoryCommand, renderHumanReport, reportCommand, runControlFlow, runList } from '#surfaces/core/cli-run/index.js';

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
    ['tr', ['bekletildi: sizden bilgi bekliyor', 'çalışıyor', 'Kapsam: s (varsayılan)', 'gösterildi']]] as const) {
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
  expect(missing.code).toBe(1); expect(missing.err).toContain('Kayıtlı iş bulunamadı: ffff0000.');
  s.calls.length = 0;
  const cancelArgv = ['run', 'cancel', '--scope', 's', '--id', 'a1b2ff', '--command-id', 'c-1', '--expected-revision', '7', '--json'];
  const cancelled = await run(cancelArgv, s.context, root);
  expect(cancelled.code).toBe(0); expect(s.calls.find(call => call.startsWith('cancel:'))).toContain(`"runId":"${OTHER}"`);
  const settled = ['not-dispatched', 'prevented', 'terminal'].map((status, index) => ({ taskId: `t${index}`, attemptId: `a${index}`, status }));
  for (const status of [null, 'unresolved', 'denied', 'unavailable']) {
    const payload = { schemaVersion: 1, layout: {}, delivery: { schemaVersion: 2, runId: OTHER, scopeId: 's', cancellationRequested: true,
      outcomes: status ? [...settled, { taskId: 't3', attemptId: 'a3', status }] : settled } };
    const result = await run(cancelArgv, { ...s.context, async deliverRunCancellation() { return payload; } }, root);
    expect.soft(result.code, status ?? 'settled').toBe(status ? 1 : 0);
    expect(JSON.parse(result.text)).toEqual(payload); expect(result.err).toBe('');
  }
});

it('negative: the AI and pipe control path still requires --command-id and --expected-revision and writes nothing without them', async () => {
  const root = await project();
  const s = store([view()]);
  for (const [argv, env] of [[['run', 'cancel', '--scope', 's', '--id', LONG, '--command-id', 'c-1'], {}], [['run', 'hold', '--scope', 's', '--id', LONG, '--reason', 'r'], {}],
    [['run', 'close', '--scope', 's', '--id', LONG], { CLAUDECODE: '1' }]] as const) {
    const result = await run([...argv], s.context, root, env);
    // S2 (alpha.53): the refusal names what is missing (CLI_ARGUMENT_MISSING, still exit 2) instead of "invalid".
    expect(result.code).toBe(2); expect(result.err).toContain('CLI_ARGUMENT_MISSING'); expect(result.err).toContain('--expected-revision <n>');
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
  for (const answers of [['s', LONG, 'no'], ['s', LONG, null], ['s', null], [null]]) {
    const s = store([view(), finished]), printed: string[] = [], cards = scripted([...answers]);
    const code = await runControlFlow('cancel', { ...s.context, root, configChoiceSources: () => ({ async list() { return [{ value: 's' }]; } }) } as never,
      { locale: 'en', root, options: { env: { HOME: join(root, 'h') } }, ask: cards.ask as never, print: text => printed.push(text) }, {});
    expect.soft(code).toBe(1);
    expect(s.calls.filter(call => call.startsWith('apply:') || call.startsWith('cancel:'))).toEqual([]);
    if (answers.length >= 2) {
      expect(cards.asked[1]!.options.map(option => option.id)).toEqual([LONG]); // the finished Run is not offered
      expect(cards.asked[1]).toMatchObject({ initial: LONG }); // Enter takes the first (waiting first, newest) Run
    }
    if (answers.length === 3) expect(printed.join('\n')).toContain('Run a1b2c3d4 was not cancelled.'); // the terminal /cancel words
    else expect(printed).toEqual(['Nothing was sent.']);
    // A change never takes the configured default silently: the scope card came first, the default preselected.
    expect(cards.asked[0]).toMatchObject({ initial: 's' });
  }
  const s = store([finished]), printed: string[] = [], cards = scripted([]);
  const code = await runControlFlow('cancel', { ...s.context, root } as never,
    { locale: 'en', root, options: { env: {} }, ask: cards.ask as never, print: text => printed.push(text) }, { scopeId: 's' });
  expect.soft(code).toBe(1);
  expect(cards.asked).toHaveLength(0); expect(s.calls).toEqual(['ids:s', 'inspect:a1b2ff']);
  expect(printed).toEqual(["No Run in scope s can take 'deckent run cancel' now."]);
});

it('TTY cancel and close show a named cancelled Run without a card or write', async () => {
  const root = await project();
  for (const [action, locale, notice] of [
    ['cancel', 'en', 'Run a1b2c3d4 is cancelled. No action was sent.'],
    ['close', 'tr', 'a1b2c3d4 işinin durumu: iptal edildi. İşlem gönderilmedi.'],
  ] as const) {
    const s = store([view([], { state: { kind: 'terminal', outcome: 'cancelled', reason: 'cancelled' } })]);
    const printed: string[] = [], cards = scripted(['yes']);
    const code = await runControlFlow(action, s.context as never, { locale, root, options: { env: {} }, ask: cards.ask as never, print: text => printed.push(text) }, { scopeId: 's', runId: LONG });
    expect.soft(code, action).toBe(1);
    expect.soft(cards.asked, action).toHaveLength(0);
    expect.soft(s.calls, action).toEqual(['ids:s', 'inspect:a1b2c3']);
    expect.soft(printed, action).toEqual([notice]);
  }
});

it('main reports the interactive Run-control result with the matching cards and sends', async () => {
  const root = await project();
  const cancelled = view([], { state: { kind: 'terminal', outcome: 'cancelled', reason: 'cancelled' } });
  const mount = vi.spyOn(await import('../../../src/surfaces/core/cli-human/internal/card-view.js'), 'mountCliCard');
  try {
    for (const [scenario, answer, sends, cards, notice] of [
      ['fresh refusal', 'yes', 0, 0, 'Run a1b2c3d4 is cancelled. No action was sent.'],
      ['conflict', 'yes', 1, 1, 'Run a1b2c3d4 is cancelled. No action was sent.'],
      ['decline', 'no', 0, 1, 'Run a1b2c3d4 was not cancelled.'],
      ['partial delivery', 'yes', 1, 1, 'Attention: termination not confirmed for 1 of 1 attempts.'],
    ] as const) {
      mount.mockReset().mockResolvedValue(answer);
      const s = store([scenario === 'fresh refusal' ? cancelled : view()]);
      const out = sinks();
      const deliver = vi.fn(async () => {
        if (scenario === 'conflict') {
          s.byId.set(LONG, { ...cancelled, revision: 8 });
          throw Object.assign(new Error('stale'), { code: 'RUN_STORE_CONFLICT' });
        }
        return { schemaVersion: 1, layout: {}, delivery: { schemaVersion: 2, runId: LONG, scopeId: 's', cancellationRequested: true,
          outcomes: [{ taskId: 't0', attemptId: 'a0', status: 'unresolved' }] } };
      });
      const code = await main(['run', 'cancel', '--scope', 's', '--id', LONG, '--lang', 'en'], { ...s.context, root,
        env: { HOME: join(root, 'h'), NO_COLOR: '1' }, initialize() {}, stdin: { isTTY: true, setRawMode() {} },
        stdout: { ...out.stdout, isTTY: true }, stderr: out.stderr, deliverRunCancellation: deliver } as never);
      expect.soft(code, scenario).toBe(1);
      expect(mount, scenario).toHaveBeenCalledTimes(cards);
      expect(deliver, scenario).toHaveBeenCalledTimes(sends);
      expect(s.calls, scenario).toEqual(scenario === 'conflict' ? ['ids:s', 'inspect:a1b2c3', 'inspect:a1b2c3'] : ['ids:s', 'inspect:a1b2c3']);
      expect(out.out.join(''), scenario).toContain(notice); expect(out.err).toEqual([]);
      if (scenario === 'partial delivery') expect(out.out.join('')).toContain('cancellation request recorded');
    }
  } finally { mount.mockRestore(); }
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
  const code = await runControlFlow('hold', s.context as never, { locale: 'tr', root, options: { env: {} }, ask: cards.ask as never, print: text => printed.push(text) }, { scopeId: 's', runId: 'a1b2c3' });
  expect.soft(code).toBe(0);
  expect(cards.asked).toHaveLength(2);
  expect(cards.asked[0]!.title).toContain('Month-end close');
  expect(cards.asked[0]!.body!.join('\n')).toContain('Kapsam: s'); expect(cards.asked[0]!.body!.join('\n')).toContain('revizyon 7');
  expect(cards.asked[1]!.body!.join('\n')).toContain('revizyon 9');
  expect(cards.asked[0]!.body!.join('\n')).toContain('Bekletmeyi deckent run resume kaldırır'); // no window key on a CLI card
  expect(cards.asked[1]!.body!.join('\n')).toContain('İş bu arada değişti');
  const write = s.calls.find(call => call.startsWith('apply:'))!;
  expect(JSON.parse(write.slice(6))).toMatchObject({ action: 'hold', runId: LONG, scopeId: 's', expectedRevision: 9, holdReason: 'Kişi deckent terminalinde bekletti.' });
  expect(JSON.parse(write.slice(6)).commandId).toMatch(/^cli-run-hold-/u);
  expect(printed.join('\n')).toContain('bekletme kaydedildi');
});

// J2e join (lead note on the C-RUN review flag "test-coverage"): the accepted card path of cancel and close, not only declines.
it('TTY cancel and close: a yes sends one command with a system command id at the revision read before the card; close advances the revision', async () => {
  const root = await project();
  for (const action of ['cancel', 'close'] as const) {
    const target = action === 'close' ? view([{ phase: 'pending' }], { state: { kind: 'parked', reason: 'operator-hold', note: 'Release window', since: 1, deadline: 2 } }) : view();
    const s = store([target]), printed: string[] = [], cards = scripted(['yes']);
    const code = await runControlFlow(action, s.context as never, { locale: 'en', root, options: { env: {} }, ask: cards.ask as never, print: text => printed.push(text) }, { scopeId: 's', runId: 'a1b2c3' });
    expect.soft(code, action).toBe(0);
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

it('run list names a hold laid over another park beside the park\'s own reason (EN and TR), not as a bare park', async () => {
  registerProviderConfig();
  const root = await project({ terminal: { scopeId: 's' } });
  const held = { ...view([{ phase: 'active' }]), runId: OTHER, state: { kind: 'parked', reason: 'quota-exhausted', since: 1, deadline: 2, operatorHold: { schemaVersion: 1, note: 'wait' } } };
  const s = store([held]);
  for (const [locale, words] of [['en', 'parked (provider quota exhausted, also held by an operator)'], ['tr', 'bekletildi: sağlayıcı kotası doldu, ayrıca operatör tarafından bekletiliyor']] as const) {
    const out = sinks();
    await runList(new Map(), false, { ...s.context, root, env: { HOME: join(root, 'h'), NO_COLOR: '1' }, locale, stdin: { isTTY: false }, stdout: out.stdout } as never, locale);
    expect(out.out.join('')).toContain(words);
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

it('PRE-1 B3: run inspect names an exit-code acceptance once, on the brief evaluation line (EN/TR)', async () => {
  const root = await project();
  const accepted = view([{ taskBrief: { ...brief('Reconcile the ledger'), criteria: [{ id: 'exit', description: 'Exit cleanly', evaluator: { id: 'process-exit', version: 1 } }] }, phase: 'accepted',
    resultBrief: { schemaVersion: 1, attemptId: 'a-1', claimLabel: 'CLAIM', evaluation: { verdict: 'accepted' }, report: null, runDelivery: null, openIssues: null, deliveryOutlook: 'none' } }]);
  for (const [locale, words] of [['en', 'exit code · content not independently verified'], ['tr', 'çıkış kodu · içerik bağımsız doğrulanmadı']] as const) {
    const text = (await run(['run', 'inspect', '--scope', 's', '--id', LONG, '--lang', locale], store([accepted]).context, root)).text;
    expect(text.split(words).length - 1).toBe(1);
  }
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
  expect(text).toContain('Kapsam: s (varsayılan)'); expect(text).toContain('a1b2c3d4'); expect(text).toContain('0e1f2a3b');
  expect(text).toContain(`--after ${identity.attemptId}`); expect(text).toContain('deckent run list');
  expect(text).not.toContain(ESC); expect(text).not.toContain('evil'); expect(text).not.toContain(LONG);
  await expect(inventoryCommand(['inventory', '--scope', 's', '--limit', '3', '--lang', 'tr'], { ...context, stdout: sinks().stdout } as never))
    .rejects.toMatchObject({ code: 'DISPATCH_INVENTORY_LIMIT', category: 'usage', suggestion: 'Sayfa başına en çok 2; --limit 2 kullanın.' });
  expect(queries).toHaveLength(1);
  const json = sinks();
  await inventoryCommand(['inventory', '--scope', 's', '--json'], { ...context, stdout: json.stdout } as never);
  expect(JSON.parse(json.out.join(''))).toEqual(page);
});

it('D4: run cancel/hold/resume/close/reserve/create off a terminal without --scope name the valid scopes (CLI_SCOPE_REQUIRED, exit 2), never blame another flag; nothing is written', async () => {
  const root = await project(), s = store([view()]), calls: string[] = [];
  const writer = async () => { calls.push('write'); return null; };
  const context = { ...s.context, applyRunLifecycle: writer, deliverRunCancellation: writer, reserveRunTasks: writer,
    configChoiceSources: () => ({ async list() { return [{ value: 's' }, { value: 'live' }]; } }) };
  for (const argv of [['cancel', '--id', LONG, '--command-id', 'c', '--expected-revision', '7'], ['close', '--id', LONG, '--command-id', 'c', '--expected-revision', '7'],
    ['hold', '--id', LONG, '--command-id', 'c', '--expected-revision', '7', '--reason', 'x'], ['resume', '--id', LONG, '--command-id', 'c', '--expected-revision', '7'],
    ['reserve', '--id', LONG, '--command-id', 'c', '--expected-revision', '7'], ['cancel']]) {
    const result = await run(['run', ...argv, '--json'], context, root);
    expect(result.code, argv.join(' ')).toBe(2);
    expect(JSON.parse(result.err), argv.join(' ')).toMatchObject({ code: 'CLI_SCOPE_REQUIRED', params: { scopes: 's, live' } });
  }
  expect(calls).toEqual([]);
});

it('report groups visible attempt usage by channel and leaves missing API or subscription measurements unknown', () => {
  const attempt = { schemaVersion: 1, identity: { scopeId: 's', runId: LONG, taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 },
    profile: { id: 'coding', version: 1 }, model: { channelId: 'channel-one', modelId: 'model', evidence: 'requested' }, effort: null,
    acceptance: { workClass: null, policyRevision: null, profileVersion: null, evaluationId: null, criteria: [], outcome: 'accepted', score: null, ceilingReasons: [] },
    axes: { cpuSeconds: null, sampledPeakBytes: null, kernelPeakBytes: null, wallMs: null, apiMoney: { basis: 'measured-tariff', amountUsdNanos: '1250000000', tariffDigest: 'a'.repeat(64) }, subscription: null, localModel: null, humanInterventions: null },
    quality: { reworkCount: null, rollbackCount: null, interventionCount: null, followup: 'unknown' }, coverage: 'partial', sampleCount: 0, gapCount: 1 };
  const second = { ...attempt, identity: { ...attempt.identity, taskId: 't2', attemptId: 'a2' }, axes: { ...attempt.axes, apiMoney: null, subscription: { calls: null, durationMs: null, limit: null } } };
  const third = { ...second, identity: { ...attempt.identity, taskId: 't3', attemptId: 'a3' }, model: null };
  const report = summarizeWorkCosts({ scopeId: 's', runId: LONG, runRevision: 1, observedAtMs: 1, withheld: 1, attempts: [attempt, second, third] as never });
  const text = renderHumanReport(report, view() as never, { env: {} } as never, 'en', false);
  expect(text).toContain('Usage by channel (this Run)');
  expect(text).toMatch(/channel-one\s+2\s+1.25\s+1\s+unknown/u);
  expect(text).toMatch(/unknown\s+1\s+unknown\s+1\s+unknown/u);
  expect(text).toContain('No billing period or reset is inferred'); expect(report.attempts).toHaveLength(3);
});

it('119-rev F4: transient unknown suspension asks for inspection without cancelling and reproposing (EN/TR)', async () => {
  const root = await project(), item = view(), st = store([item]), now = Date.now();
  const progression = { schemaVersion: 1, scopeId: 's', runId: LONG, revision: 7, observedAtMs: now, validUntilMs: now + 60000, actorClass: 'ai',
    state: 'unknown', reason: 'RUN_PROGRESSION_SESSION_UNVERIFIED', session: 'unknown', suspended: true, parkUnavailable: false, missing: [] };
  const handlers = { ...st.context, async inspectRun() { return { schemaVersion: 1, layout: {}, run: item, progression }; } };
  for (const locale of ['en', 'tr']) {
    const output = await run(['run', 'list', '--scope', 's', '--lang', locale], handlers, root);
    expect(output.code).toBe(0); expect(output.text).toContain('deckent run inspect --scope s --id a1b2c3d4');
    expect(output.text).not.toContain(locale === 'en' ? 'cancel this Run and propose it again' : 'bu işi iptal edip servis üzerinden yeniden önerin');
  }
});

it('119-C4: list and JSON keep RunView unchanged while showing the service diagnosis in both languages', async () => {
  const root = await project(), item = view([{ taskBrief: brief('Fix checkout') }]), st = store([item]), now = Date.now();
  const progression = { schemaVersion: 1, scopeId: 's', runId: LONG, revision: 7, observedAtMs: now, validUntilMs: now + 60000, actorClass: 'ai' as const,
    state: 'blocked', reason: 'RUN_PROGRESSION_REPROPOSE_REQUIRED', session: 'ineligible', suspended: false, parkUnavailable: false, missing: [] };
  const handlers = { ...st.context, async inspectRun() { return { schemaVersion: 1, layout: {}, run: item, progression }; } };
  for (const locale of ['en', 'tr']) {
    const output = await run(['run', 'list', '--scope', 's', '--lang', locale], handlers, root);
    expect(output.code).toBe(0); expect(output.text).toContain(locale === 'en' ? 'Propose again' : 'Yeniden önerin');
    expect(output.text).toContain('deckent run cancel --scope s --id a1b2c3d4');
    for (const reason of ['DENIED', 'APPROVAL_REQUIRED']) {
      const restricted = { ...handlers, async inspectRun() { return { schemaVersion: 1, layout: {}, run: item, progression: { ...progression, session: 'eligible',
        missing: [{ kind: 'run', id: LONG, action: 'reserve', scope: 's', reason, code: 'POLICY_DENIED' }] } }; } };
      const shown = await run(['run', 'list', '--scope', 's', '--lang', locale], restricted, root);
      expect(shown.text).toContain(reason === 'DENIED' ? locale === 'en' ? 'AI execution is explicitly denied' : 'Yapay zekâ yürütmesi açıkça reddedildi'
        : locale === 'en' ? 'AI execution requires approval' : 'Yapay zekâ yürütmesi için onay gerekiyor');
      expect(shown.text).not.toContain('--only ai-execution');
    }
  }
  for (const locale of ['en', 'tr']) for (const closed of [
    { ...item, state: { kind: 'terminal', outcome: 'completed', reason: 'completed' } },
    { ...item, cancellationRequested: true },
  ]) {
    const output = await run(['run', 'list', '--scope', 's', '--lang', locale], {
      ...handlers, async inspectRun() { return { schemaVersion: 1, layout: {}, run: closed, progression }; },
    }, root);
    expect(output.code).toBe(0); expect(output.text).toContain('a1b2c3d4'); expect(output.text).toContain('Fix checkout');
    expect(output.text).not.toContain(locale === 'en' ? 'Propose again' : 'Yeniden önerin');
    expect(output.text).not.toContain(locale === 'en' ? 'Inspect again for the current cause and next step:' : 'Güncel neden ve sonraki adım için yeniden inceleyin:');
    expect(output.text).toContain(locale === 'en' ? 'Details: deckent run inspect --id <short id>' : 'Ayrıntı: deckent run inspect --id <kısa kimlik>');
    expect(output.text).not.toContain('deckent run cancel');
    expect(output.text).not.toContain(locale === 'en' ? 'automatic progression' : 'otomatik ilerleme');
  }
  const json = await run(['run', 'list', '--scope', 's', '--json'], handlers, root), parsed = JSON.parse(json.text);
  expect(parsed.runs).toEqual([item]); expect(parsed.progression).toEqual([progression]); expect(item).not.toHaveProperty('progression');
});
