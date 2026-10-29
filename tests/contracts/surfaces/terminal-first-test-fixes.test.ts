import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearConfigCache, ErrorRegistry, PACKAGE_VERSION } from '#platform/index.js';
import { registerProviderConfig, terminalConfigSchema } from '#adapters/index.js';
import { createProviderSpendCheckpoint, runAgentTurn, agentTurnAdmission, agentCompactionExpected } from '#engine/index.js';
import { terminalAdminPorts } from '#surfaces/core/terminal-admin/index.js';
import { EMPTY_SESSION_USAGE, addSessionUsage, serviceAbsenceWatch } from '#surfaces/core/terminal-kit/index.js';
import { infoModelText } from '#surfaces/core/terminal-window/index.js';
import { terminalPanelLabels, workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { homeEnv } from '../support/host-platform.js';

const roots: string[] = [], views: ReturnType<typeof mountWorkline>[] = [];
afterEach(async () => { for (const view of views.splice(0)) view.instance.unmount(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-w2-')); roots.push(root);
  await mkdir(join(root, '.deckent'));
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ provider_spending: { schemaVersion: 1,
    budgets: [{ schemaVersion: 1, scopeId: 's', budgetId: 'configured', revision: 1, currency: 'USD', limitMinorUnits: 0 }] } }));
  return root;
}

it('opens /usage with the current ledger account before the stale config choices, in the actual Ink window', async () => {
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
});

it('shows a failed live account read instead of promoting a config value to a ledger amount', async () => {
  const root = await project();
  const admin = terminalAdminPorts({ root, scopeId: 's', options: { env: homeEnv(join(root, 'h')) }, locale: 'en', context: {
    async inspectProviderSpendAccount() { throw ErrorRegistry.createError('PROVIDER_SPEND_UNAVAILABLE'); } }, status: async () => '', doctor: async () => undefined });
  const model = (await admin.info.ports.usage!({ usage: EMPTY_SESSION_USAGE })).model;
  expect(model.sections[0]!.chip?.state).toBe('fail'); expect(model.sections[0]!.rows).toBeUndefined();
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
  // The workline shows the line in the error tone when the host's watch reports it.
  let report: ((text: string) => void) | undefined;
  const view = mountWorkline({ serviceLost: (listener: (text: string) => void) => { report = listener; return () => { report = undefined; }; } } as never); views.push(view);
  await settle(40); report!('SERVICE STOPPED UNDER YOU'); await until(() => view.stdout.text.includes('SERVICE STOPPED UNDER YOU'), 'service lost line');
});
