import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { clearConfigCache, ErrorRegistry, PACKAGE_VERSION, t } from '#platform/index.js';
import { main } from '#surfaces/index.js';
import { openConfiguredTerminalSessions } from '#composition/core/cli/index.js';
import { registerProviderConfig, terminalConfigSchema } from '#adapters/index.js';
import { createProviderSpendCheckpoint, runAgentTurn, agentTurnAdmission, agentCompactionExpected } from '#engine/index.js';
import { terminalAdminPorts } from '#surfaces/core/terminal-admin/index.js';
import { EMPTY_SESSION_USAGE, addSessionUsage, serviceAbsenceWatch } from '#surfaces/core/terminal-kit/index.js';
import { infoModelText } from '#surfaces/core/terminal-window/index.js';
import { terminalPanelLabels, workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { homeEnv } from '../support/host-platform.js';
import { terminalBuffers } from '../../fixtures/terminal-screen.js';

const roots: string[] = [], views: ReturnType<typeof mountWorkline>[] = [];
afterEach(async () => { for (const view of views.splice(0)) view.instance.unmount(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-w2-')); roots.push(root);
  await mkdir(join(root, '.deckent'));
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ provider_spending: { schemaVersion: 1,
    budgets: [{ schemaVersion: 1, scopeId: 's', budgetId: 'configured', revision: 1, currency: 'USD', limitMinorUnits: 0 }] } }));
  return root;
}

it('opens /usage with the current ledger account before the stale config choices, in the actual Ink window; a failed read never promotes config', async () => {
  registerProviderConfig();
  const root = await project(), queries: unknown[] = [];
  const checkpoint = createProviderSpendCheckpoint({ schemaVersion: 2,
    budget: { schemaVersion: 1, scopeId: 's', budgetId: 'live-budget', revision: 4, currency: 'USD', limitMinorUnits: 1500 },
    settledMinorUnits: 1025, settledExactMinorUnits: '1024.5', reservedMinorUnits: 100, frozen: true }, 44, 43);
  const admin = terminalAdminPorts({ root, scopeId: 's', options: { env: homeEnv(join(root, 'h')) }, locale: 'tr', context: {
    async inspectProviderSpendAccount(_root, query) { queries.push(query); return { schemaVersion: 2, scopeId: 's', budgetId: 'live-budget', budgetRevision: 4,
      checkpoint, audit: null, spendingHistoryIntegrity: 'not-recorded' }; } }, status: async () => '', doctor: async () => undefined });
  const model = (await admin.info.ports.usage!({ usage: EMPTY_SESSION_USAGE })).model;
  const text = infoModelText(model).join('\n');
  expect(queries).toEqual([{ schemaVersion: 1, scopeId: 's', current: true }]);
  expect(text.indexOf('Canlı harcama hesabı')).toBeLessThan(text.indexOf('configured'));
  expect(model.sections[0]!.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ value: 'live-budget' }), expect.objectContaining({ value: '4' }),
    // FOLLOWUPS 2026-10-09 item 5: a USD account reads in dollars, never in minor units (cents).
    expect.objectContaining({ value: '15,00 USD' }), expect.objectContaining({ value: '3,75 USD' }), expect.objectContaining({ value: '10,245 USD' }),
  ]));
  expect(text).not.toContain('alt birim');
  const view = mountWorkline({ info: admin.info, labels: WORKLINE_TEST_LABELS }); views.push(view);
  await until(() => view.stdout.frame.includes('READY'), 'ready'); view.stdin.write('/usage\r');
  await until(() => view.stdout.frame.includes('Canlı harcama hesabı'), 'live account visible without selecting a budget');
  expect(view.stdout.frame).toContain('live-budget'); expect(view.stdout.frame).toContain('Bütçe revizyonu'); expect(view.stdout.frame).not.toContain('\u001b[');
  // A failed live account read is shown as failed; a config value is never promoted to a ledger amount.
  const failed = terminalAdminPorts({ root, scopeId: 's', options: { env: homeEnv(join(root, 'h')) }, locale: 'en', context: {
    async inspectProviderSpendAccount() { throw ErrorRegistry.createError('PROVIDER_SPEND_UNAVAILABLE'); } }, status: async () => '', doctor: async () => undefined });
  const refused = (await failed.info.ports.usage!({ usage: EMPTY_SESSION_USAGE })).model;
  expect(refused.sections[0]!.chip?.state).toBe('fail'); expect(refused.sections[0]!.rows).toBeUndefined();
});

// Batch A (Jev 280abf6b, owner decision open): the streamed agent path keeps the whole history for runtime compaction (Astra 2091 R1);
// the absolute token threshold bounds growth. historyMessages windows only the plain path.
it('sends the whole streamed history with complete tool-call exchanges, keeping the first instruction (Astra 2091 R1)', async () => {
  const captured: Array<readonly { role: string; content: string }[]> = [];
  const view = mountWorkline({ historyMessages: 4, streamTurn: async function* (messages) {
    captured.push([...messages]);
    yield { kind: 'message', message: { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read_file', argumentsJson: '{}' }] } };
    yield { kind: 'message', message: { role: 'tool', name: 'read_file', toolCallId: 'c', content: 'bounded result' } };
    yield { kind: 'message', message: { role: 'assistant', content: 'answer', toolCalls: [] } };
    yield { kind: 'text', text: 'answer' }; yield { kind: 'done', finish: 'stop' };
  } }); views.push(view);
  await until(() => view.stdout.frame.includes('READY'), 'ready');
  for (const text of ['first', 'second', 'third']) { view.stdin.write(`${text}\r`); await until(() => captured.length === ['first', 'second', 'third'].indexOf(text) + 1 && view.stdout.frame.includes('READY'), text); await settle(); }
  const third = captured[2]!;
  expect(third).toHaveLength(10); expect(third[1]).toMatchObject({ role: 'user', content: 'first' }); expect(third.at(-1)).toMatchObject({ content: 'third' });
  // Every tool result follows the assistant call it answers: no orphan tool message is sent.
  third.forEach((message, index) => { if (message.role === 'tool') expect(third[index - 1]!.role).toBe('assistant'); });
});

it.each(['tr', 'en'] as const)('renders spend refusal from the turn loop in %s with a budget next step', async language => {
  const view = mountWorkline({ streamTurn: async function* (messages) {
    const result = await runAgentTurn({ messages, tools: [], language, emit: () => undefined, signal: new AbortController().signal }, {
      invokeRound: async () => ({ status: 'failed', state: 'PROVIDER_SPEND_EXHAUSTED' }), authorize: async () => 'deny',
      describe: () => null, execute: async () => ({ status: 'denied', content: '' }), now: () => 0,
    });
    yield { kind: 'done', finish: result.finish, note: result.note };
  } }); views.push(view);
  await until(() => view.stdout.frame.includes('READY'), 'ready'); view.stdin.write('go\r');
  await until(() => view.stdout.text.includes('PROVIDER_SPEND_EXHAUSTED'), 'localized refusal');
  // SPEND-HOLDS: the budget next step moved to /usage (reconcile held reservations or change budget).
  expect(view.stdout.text).toContain(language === 'tr' ? '/usage → Bekleyen rezervasyonları uzlaştır veya Bütçeyi değiştir' : '/usage → Reconcile held reservations or Change budget');
  expect(view.stdout.text).not.toContain('The model round ended without an answer');
});

it('applies the registry defaults and the absolute threshold independently of the million-token window', () => {
  const chat = terminalConfigSchema.parse({ chat: { schemaVersion: 1 } }).chat!;
  expect(chat).toMatchObject({ maxCompletionTokens: 16384, historyMessages: 40, compactionThresholdTokens: 100000 });
  const messages = [{ role: 'system' as const, content: 'system' }, ...Array.from({ length: 12 }, (_, index) => ({ role: 'user' as const, content: String(index) }))];
  const admission = agentTurnAdmission(chat.maxCompletionTokens, 8_000_000, chat.compactionThresholdTokens);
  expect(agentCompactionExpected(messages, { promptTokens: 99999, windowTokens: 1_000_000 }, admission)).toBe(false);
  expect(agentCompactionExpected(messages, { promptTokens: 100000, windowTokens: 1_000_000 }, admission)).toBe(true);
  expect(agentCompactionExpected(messages, { promptTokens: 100000, windowTokens: null }, admission)).toBe(true);
  expect(terminalPanelLabels('tr').budget.belowSettled).toContain('kayıtlı harcama');
  expect(workSurfaceLabels('tr').live!.tasksHints).toContain('x iptal (onay)');
  expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u); // the running version, not a pinned release (survives each bump)
});

it.each(['tr', 'en'] as const)('renders session cache reads, writes and hit ratio, with partial and missing reports explicit (%s)', async locale => {
  const root = await project();
  const admin = terminalAdminPorts({ root, scopeId: 's', options: { env: homeEnv(join(root, 'h')) }, locale, context: {}, status: async () => '', doctor: async () => undefined });
  const measured = addSessionUsage(EMPTY_SESSION_USAGE, { promptTokens: 100, completionTokens: 20, reasoningTokens: null,
    cache: { readTokens: 60, writeTokens: 10, promptTokens: 100 } });
  const missing = addSessionUsage(measured, { promptTokens: 900, completionTokens: 20, reasoningTokens: null });
  const usageView = async (usage: typeof measured) => (await admin.info.ports.usage!({ usage })).model;
  const text = infoModelText(await usageView(measured)).join('\n');
  expect(text).toContain('60.0'); expect(text).toContain('60/100'); expect(text).toContain('10');
  const partial = infoModelText(await usageView(missing)).join('\n');
  expect(partial).toContain(locale === 'tr' ? 'tüm oturum bilinmiyor' : 'full session unknown'); expect(partial).not.toContain('6.0%');
  const none = infoModelText(await usageView(addSessionUsage(EMPTY_SESSION_USAGE, { promptTokens: 1, completionTokens: 1, reasoningTokens: null }))).join('\n');
  expect(none).toMatch(locale === 'tr' ? /Önbellek isabet oranı\s+ölçülmedi/u : /Cache hit ratio\s+not measured/u);
  const view = mountWorkline({ info: { ...admin.info, ports: { ...admin.info.ports, usage: () => admin.info.ports.usage!({ usage: measured }) } } }, 200, { rows: 60 }); views.push(view);
  await until(() => view.stdout.frame.includes('READY'), 'ready'); view.stdin.write('/usage\r');
  await until(() => view.stdout.frame.includes(locale === 'tr' ? 'Önbellek isabet oranı' : 'Cache hit ratio'), 'settled cache projection visible in Ink');
  expect(view.stdout.frame).toContain('60.0'); expect(view.stdout.frame).not.toContain('\u001b[');
});

// BeUser AYSE-21: a scope whose budget was never created says plainly that no paid call ran here and how to allow one; no contradicting
// "no budget configured" section follows the live account.
it.each(['tr', 'en'] as const)('/usage without a created budget says no paid call ran here and names /model → Create budget (%s)', async locale => {
  const root = await project();
  const admin = terminalAdminPorts({ root, scopeId: 's', options: { env: homeEnv(join(root, 'h')) }, locale, status: async () => '', doctor: async () => undefined,
    context: { inspectProviderSpendAccount: async () => ({ schemaVersion: 2, scopeId: 's', budgetId: 'scope-budget', budgetRevision: 1, checkpoint: null, audit: null, spendingHistoryIntegrity: 'not-recorded' }) as never } });
  const text = infoModelText((await admin.info.ports.usage!({ usage: EMPTY_SESSION_USAGE })).model).join('\n');
  expect(text).toContain(locale === 'tr' ? 'ücretli çağrı yok' : 'no paid calls'); expect(text).toContain(locale === 'tr' ? '/model → Bütçe oluştur' : '/model → Create budget');
  expect(text).not.toMatch(/provider_spending|snapshot|anlık görüntü/u);
});

it.each(['tr', 'en'] as const)('CACHE-SLICE1 /usage: raw read, 5m and 1h writes and the same-request net benefit as an estimate, negative shown as is (%s)', async locale => {
  const root = await project();
  const admin = terminalAdminPorts({ root, scopeId: 's', options: { env: homeEnv(join(root, 'h')) }, locale, context: {}, status: async () => '', doctor: async () => undefined });
  const view = async (usage: ReturnType<typeof addSessionUsage>) => infoModelText((await admin.info.ports.usage!({ usage })).model).join('\n');
  const measured = addSessionUsage(EMPTY_SESSION_USAGE, { promptTokens: 126_000, completionTokens: 500, reasoningTokens: null,
    cache: { readTokens: 100_000, writeTokens: 25_000, promptTokens: 126_000, write5mTokens: 20_000, write1hTokens: 5_000, netBenefitUsdE10: 1_700_000_000 } });
  const text = await view(measured);
  expect(text).toContain(locale === 'tr' ? 'Önbelleğe yazılan (5 dk)' : 'Cache write (5 min)'); expect(text).toContain(locale === 'tr' ? '20.000' : '20,000');
  expect(text).toContain(locale === 'tr' ? 'Önbelleğe yazılan (1 saat)' : 'Cache write (1 hour)'); expect(text).toContain(locale === 'tr' ? '5.000' : '5,000');
  expect(text).toContain(locale === 'tr' ? '0,1700 USD' : '0.1700 USD'); expect(text).toContain(locale === 'tr' ? 'tahmin' : 'estimate');
  const negative = await view(addSessionUsage(EMPTY_SESSION_USAGE, { promptTokens: 10, completionTokens: 1, reasoningTokens: null,
    cache: { readTokens: 0, writeTokens: 1_000_000, promptTokens: 1_000_010, write5mTokens: 1_000_000, write1hTokens: 0, netBenefitUsdE10: -5_000_000_000 } }));
  expect(negative).toContain(locale === 'tr' ? '-0,5000 USD' : '-0.5000 USD');
  // A report without a measured benefit keeps the figure partial, never a zero for the whole session.
  const partial = await view(addSessionUsage(measured, { promptTokens: 1, completionTokens: 1, reasoningTokens: null }));
  expect(partial).toMatch(locale === 'tr' ? /ölçülen raporlarda 0,1700 USD, tahmin \(1\/2\)/u : /0\.1700 USD, estimate, in measured reports \(1\/2\)/u);
});
it.each([true, false])('BeUser M-09: a turn that finds the runtime service absent starts it once and sends the line again (start port %s)', async withPort => {
  let calls = 0, starts = 0; const users: number[] = [];
  const view = mountWorkline({ ...(withPort ? { startService: async () => { starts++; return 'SERVICE STARTED'; } } : {}),
    errorText: error => `ERR ${(error as { code?: string }).code}`,
    streamTurn: async function* (messages: readonly { role: string; content: string }[]) { users.push(messages.filter(row => row.role === 'user' && row.content.startsWith('hello')).length);
      if (calls++ === 0) throw ErrorRegistry.createError('LOCAL_RUNTIME_UNAVAILABLE');
      yield { kind: 'text' as const, text: 'answered\n' }; yield { kind: 'done' as const, finish: 'stop' as const }; } } as never); views.push(view);
  await settle(40); view.stdin.write('hello\r');
  await until(() => view.stdout.text.includes(withPort ? 'answered' : 'ERR LOCAL_RUNTIME_UNAVAILABLE'), 'turn outcome');
  expect([calls, starts]).toEqual(withPort ? [2, 1] : [1, 0]); expect(view.stdout.text.includes('SERVICE STARTED')).toBe(withPort);
  expect(view.stdout.text.includes('ERR LOCAL_RUNTIME_UNAVAILABLE')).toBe(!withPort);
  if (withPort) expect(users).toEqual([1, 1]); // D11-M2: the resent line reaches the model once, not twice // a started service sends the line again as a new turn
});

it('BeUser D-05: the open terminal says once per absence that the runtime service stopped under it, never for a service it never reached', async () => {
  const answers: boolean[] = [], heard: string[] = [];
  const describe = async () => { if (!answers.shift()) throw ErrorRegistry.createError('LOCAL_RUNTIME_UNAVAILABLE'); };
  const never = serviceAbsenceWatch(describe, false, () => 'STOPPED'); never.subscribe(text => heard.push(`never ${text}`));
  answers.push(false); await never.tick(); expect(heard).toEqual([]);
  const watch = serviceAbsenceWatch(describe, true, () => 'STOPPED'), stop = watch.subscribe(text => heard.push(text));
  answers.push(false, false, true, false); for (let beat = 0; beat < 4; beat++) await watch.tick();
  expect(heard).toEqual(['STOPPED', 'STOPPED']); stop(); answers.push(true, false); await watch.tick(); await watch.tick(); expect(heard).toHaveLength(2);
  // alpha.60 B: the opening's start answers after the frame; the watch made before it is armed then, and only then hears an absence.
  const later = serviceAbsenceWatch(describe, false, () => 'STOPPED'); later.subscribe(text => heard.push(`later ${text}`));
  answers.push(false); await later.tick(); expect(heard).toHaveLength(2); later.arm(); answers.push(false); await later.tick(); expect(heard.at(-1)).toBe('later STOPPED');
  // The workline shows the line in the error tone when the host's watch reports it.
  let report: ((text: string) => void) | undefined;
  const view = mountWorkline({ serviceLost: (listener: (text: string) => void) => { report = listener; return () => { report = undefined; }; } } as never); views.push(view);
  await settle(40); report!('SERVICE STOPPED UNDER YOU'); await until(() => view.stdout.text.includes('SERVICE STOPPED UNDER YOU'), 'service lost line');
});

// alpha.60 B (P3 draw-first): the launch draws before the runtime service answers. One start (single flight); a line sent meanwhile waits behind one
// notice and goes once after the first mode read; Ctrl+C sends nothing; a failed start gives the line its typed error and back as the draft; a stored
// full-access start mode is applied by that first read, before any turn. The inline layout keeps the old path (no launch shell).
// alpha.60 C (`shell`): in the full window the shell is drawn before the host loads; its draft and sent lines (at most the registry bound, one
// note for the rest) go to the Workline exactly, in order; `--full-access` alone keeps the old path.
it.each(['ready', 'cancel', 'failed', 'stored', 'shell'] as const)('alpha.60 B/C: frame before the host and the service, one start, lines sent meanwhile go once in order (%s)', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-opening-')); roots.push(root);
  await mkdir(join(root, '.deckent')); await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ terminal: { ...(scenario === 'shell' ? {} : { layout: 'inline' }), notify: 'off' } }));
  let output = '', answer!: (value: unknown) => void, refuse!: (error: unknown) => void, hostReady!: () => void;
  const tty = (sink: (text: string) => void) => Object.assign(new Writable({ write(chunk, _encoding, done) { sink(String(chunk)); done(); } }), { isTTY: true, columns: 160, rows: 40 });
  const screen = tty(text => { output += text; }), keys = () => { const stream = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stream; }, ref() { return stream; }, unref() { return stream; } }); return stream; };
  const input = keys(), order: string[] = [], asked: string[] = [], stop = new AbortController(), wait = t('terminal.opening.wait', {}, 'en'), loading = new Promise<void>(resolve => { hostReady = resolve; });
  let answered = false, returned = false; const ensure = vi.fn(() => new Promise((resolve, reject) => { answer = value => { answered = true; resolve(value); }; refuse = error => { answered = true; reject(error); }; })), readiness = { mode: 'connected', instanceId: 'i', pid: null, logPath: null, shutdownAvailable: true, build: null };
  const view = (mode: string) => ({ schemaVersion: 1, scopeId: 's', supported: true, mode, askEdits: false, revision: 'r1', eligible: true, fullAccess: true });
  const stream = vi.fn(async function* (_root: string, request: { fullAccess?: true; messages: readonly { role: string; content: string }[] }) { order.push(request.fullAccess ? 'turn full-access' : 'turn');
    asked.push(String(request.messages.filter(row => row.role === 'user').at(-1)?.content).split('\n')[0]!); yield { kind: 'text' as const, text: 'ANSWERED' }; yield { kind: 'done' as const, finish: 'stop' as const }; });
  // Astra 2858 B-R3 (ready, failed): the real session store is opened only after the service attempt settled (either way), never before.
  const sessionsSeen = scenario === 'ready' || scenario === 'failed', sessionOpens: number[] = [], writes: string[] = [], previous = t('terminal.session.previous', {}, 'en');
  if (sessionsSeen) { registerProviderConfig(); await (await openConfiguredTerminalSessions(root, { env: homeEnv(join(root, 'h')) }))!.save({ schemaVersion: 1, scopeId: 's', sessionId: '11111111-2222-4333-8444-555555555555',
    updatedAtMs: Date.now(), messages: [{ role: 'user', content: 'saved' }, { role: 'assistant', content: 'reply', toolCalls: [] }] }); }
  const context = { root, env: homeEnv(join(root, 'h')), initialize: registerProviderConfig, ...(sessionsSeen ? { openTerminalSessions: (async (...args: Parameters<typeof openConfiguredTerminalSessions>) => {
    sessionOpens.push(ensure.mock.results.length && answered ? 1 : 0); const real = (await openConfiguredTerminalSessions(...args))!;
    // A turn's save still in flight when the view closes (slowed here): it settles before the terminal reports done, never after.
    return { ...real, save: async (...save: Parameters<typeof real.save>) => { await settle(150); await real.save(...save); writes.push(returned ? 'after-return' : 'before-return'); } }; }) as never } : {}), async ensureTerminalIdentity() { return { installationId: 'installation', projectId: 'project' }; }, completeTerminalChat: vi.fn() };
  const run = main(['--scope', 's', '--lang', 'en'], { ...context, signal: stop.signal, stdout: screen as unknown as NodeJS.WriteStream, stderr: screen as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream,
    streamTerminalChat: stream as never, ensureRuntimeService: ensure as never, inspectPermissionMode: (async () => { order.push('mode'); return view(scenario === 'stored' ? 'full-access' : 'standart'); }) as never,
    setPermissionMode: vi.fn() as never, ...(scenario === 'shell' ? { loadHost: async () => { await loading; return {}; } } : {}) });
  try {
    if (scenario === 'shell') {
      const dropped = t('terminal.shell.dropped', {}, 'en').slice(0, 30);
      await until(() => output.includes(t('terminal.shell.preparing', {}, 'en')), 'the shell frame before the host loads'); expect(ensure).not.toHaveBeenCalled();
      for (let line = 1; line <= 9; line++) { input.write(`line ${line}`); await settle(15); input.write('\r'); await settle(15); }
      input.write('draft-x'); await until(() => output.includes(dropped), 'one note for the line over the bound');
      hostReady(); await until(() => ensure.mock.calls.length === 1, 'the launch went on'); answer(readiness);
      await until(() => asked.length === 8, 'the kept lines sent'); await settle(150);
      expect(asked).toEqual(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`)); expect(terminalBuffers(output, 160, 40).text).toMatch(/│ ?draft-x/u); // the draft is the Workline's composer now
      let alone = ''; const lone = keys(); // `deckent --full-access` keeps the old path: no shell, no full window before its own refusal here
      expect(await main(['--full-access', '--lang', 'en'], { ...context, stdout: tty(text => { alone += text; }) as unknown as NodeJS.WriteStream, stderr: tty(text => { alone += text; }) as unknown as NodeJS.WriteStream, stdin: lone as unknown as NodeJS.ReadStream })).not.toBe(0);
      expect(alone).not.toContain(t('terminal.shell.preparing', {}, 'en')); expect(alone).not.toContain('\u001b[?1049h'); lone.destroy();
      // A scope with control characters (flag or configuration) fails the scope rule and the control-character projection: no shell, nothing
      // of it written raw; the old path goes on (here to an identity stop, exit 78).
      const hostile = 's\u001b]0;pwned\u0007', other = await mkdtemp(join(tmpdir(), 'deckent-opening-')); roots.push(other);
      await mkdir(join(other, '.deckent')); await writeFile(join(other, '.deckent/config.json'), JSON.stringify({ terminal: { scopeId: hostile } }));
      for (const [where, argv] of [[root, ['--scope', hostile, '--lang', 'en']], [other, ['--lang', 'en']]] as const) {
        let seen = ''; const keysIn = keys(), sink = tty(text => { seen += text; }) as unknown as NodeJS.WriteStream;
        expect(await main(argv, { ...context, root: where, stdout: sink, stderr: sink, stdin: keysIn as unknown as NodeJS.ReadStream,
          async ensureTerminalIdentity() { throw ErrorRegistry.createError('INSTALLATION_IDENTITY_RELOCATED'); } })).toBe(78);
        expect(seen).not.toContain('\u001b[?1049h'); expect(seen).not.toContain('\u001b]0;pwned'); expect(seen).not.toContain(t('terminal.shell.preparing', {}, 'en')); keysIn.destroy();
      }
      return;
    }
    await until(() => output.includes('Ask anything'), 'the frame before the service answers');
    expect(ensure).toHaveBeenCalledOnce(); expect(order).toEqual([]); expect(output).not.toContain(t('terminal.shell.preparing', {}, 'en'));
    input.write('hello'); await settle(20); input.write('\r'); await until(() => output.includes(wait), 'the wait notice'); expect(sessionOpens).toEqual([]);
    if (scenario === 'cancel') { input.write('\u0003'); await settle(80); answer(readiness); await settle(150); }
    else if (scenario === 'failed') {
      refuse(ErrorRegistry.createError('RUNTIME_AUTOSTART_FAILED', { params: { log: '/state/runtime-service.log' } }));
      await until(() => output.includes('RUNTIME_AUTOSTART_FAILED'), 'the typed error on the waiting line');
      await until(() => /│ ?hello/u.test(output.slice(output.lastIndexOf('RUNTIME_AUTOSTART_FAILED'))), 'the line back as the draft');
    } else { answer(readiness); await until(() => output.includes('ANSWERED'), 'delivered'); }
    expect(order.slice(0, 2)).toEqual({ ready: ['mode', 'turn'], cancel: ['mode'], failed: [], stored: ['mode', 'turn full-access'] }[scenario]); // a turn then refreshes the mode
    expect(output.split(wait)).toHaveLength(2); expect(ensure).toHaveBeenCalledOnce();
    if (sessionsSeen) { await until(() => output.includes(previous), 'the saved-conversation notice after the service result'); expect(sessionOpens).toEqual([1]); }
    if (scenario === 'stored') expect(output).toContain(t('terminal.fullAccess.banner', {}, 'en').slice(0, 40));
  } finally { stop.abort(); hostReady(); await run; returned = true; input.destroy(); }
  if (scenario === 'ready') { await settle(300); expect(writes).toEqual(['before-return']); } // the turn's save settled before `main` returned
});
