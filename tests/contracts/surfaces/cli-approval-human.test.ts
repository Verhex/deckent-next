import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { setImmediate as yieldToInput } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { clearConfigCache, t } from '#platform/index.js';
import { getDecisionSteps, type DecisionDelegationView, type ApprovalRecord } from '#domain/index.js';
import { mcpCapabilityRegistry } from '#engine/index.js';
import { answerOnCard, approvalPickLabel, cardIo, toggleDelegations, toggleMcp, type CardAsk } from '#surfaces/core/cli-approval/index.js';
import { decisionCommand } from '#surfaces/core/cli-decision/index.js';
import * as cards from '#surfaces/core/cli-human/index.js';
import { until } from '../support/workline-harness.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

/**
 * C-APPROVE (alpha.48, CLI review §approval, §decide, §policy): readable approval/decision/policy output, field-named input errors, `--schema`,
 * the terminal's approval card from the CLI and the TTY policy toggles over the existing governed changes. AI/MCP never decide.
 */
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project(config: Record<string, unknown> = { terminal: { scopeId: 'live' } }) {
  registerProviderConfig();
  const root = await mkdtemp(join(tmpdir(), 'dn-cli-approve-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') }, ...config }));
  return root;
}
async function run(argv: string[], handlers: Record<string, unknown>, root: string, env: Record<string, string> = {}, stdin?: Readable) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, { root, env: { HOME: join(root, 'h'), USERPROFILE: join(root, 'h'), NO_COLOR: '1', ...env }, initialize() {}, ...(stdin ? { stdin } : {}),
    stdout: { write(value: string) { out.push(value); } }, stderr: { write(value: string) { err.push(value); } }, ...handlers } as never);
  return { code, text: out.join(''), err: err.join('') };
}
const digest = 'a'.repeat(64), now = Date.now();
const requester = { id: 'u', issuer: 'host', subject: '1000' };
function approval(id: string, input: { status?: 'pending' | 'decided' | 'expired'; created?: number; ttl?: number; cell?: string; authority?: boolean; legacy?: boolean; summary?: string } = {}): ApprovalRecord {
  const createdAt = input.created ?? now - 60_000, status = input.status ?? 'pending';
  const facts = { risk: input.cell ? { source: 'cell', cell: input.cell } : { source: 'effect-class', effectClass: 'write', authority: input.authority ?? false },
    reversibility: { kind: 'none' }, onExpiry: 'nothing-runs', requiredAssurance: 'peer-session' };
  const shared = { approvalId: id, scopeId: 'live', subject: { kind: 'task', runId: 'run-1', taskId: `task-${id}` }, requester, actionDigest: digest, policyRevision: 'p1',
    summary: input.summary ?? `Run the tests for ${id}`, createdAt, expiresAt: createdAt + (input.ttl ?? 600_000) };
  const request = input.legacy ? { schemaVersion: 2, ...shared } : { schemaVersion: 3, ...shared, facts };
  const decision = status === 'decided' ? { schemaVersion: 4, commandId: 'c', decision: 'allow', actor: requester, sessionId: 's', channel: 'local-cli', reason: 'checked',
    decidedAt: createdAt + 1, requestDigest: digest, commandDigest: digest, idempotencyKeyHash: digest, assurance: 'peer-session', deciderClass: 'human-tty' } : null;
  return { request, revision: status === 'pending' ? 0 : 1, status, decision, keyId: 'k', mac: digest } as unknown as ApprovalRecord;
}
const lines = (text: string) => text.split('\n');

it('F5: approval list keeps inspectable full ids and bounds a long description without repeating the summary', async () => {
  const root = await project(), id = '1234567890abcdef'.repeat(4), record = approval(id, { summary: 'unbounded-summary '.repeat(50) });
  const result = await run(['approval', 'list', '--lang', 'tr'], { listApprovals: async () => [record] }, root);
  expect(result.code).toBe(0); expect(result.text).toContain(id);
  expect(result.text).not.toContain('unbounded-summary');
  const table = result.text.slice(result.text.indexOf('Kimlik'), result.text.indexOf('Tam ayrıntı:'));
  expect(lines(table).every(line => [...line].length <= 120)).toBe(true);
  expect(result.text).toContain('deckent approval inspect --schema');
});

it('AI path: a wrong approval input names the field (not INVENTORY_QUERY_INVALID) and sends nothing; --schema prints the contract', async () => {
  const root = await project(), seen: unknown[] = [];
  const handlers = { listApprovals: async (input: unknown) => { seen.push(input); return []; }, decideApproval: async (input: unknown) => { seen.push(input); return null; },
    inspectApproval: async (input: unknown) => { seen.push(input); return null; } };
  const listed = await run(['approval', 'list', '--input', '-', '--lang', 'en'], handlers, root, {}, Readable.from([JSON.stringify({ schemaVersion: 1, scopeId: 'live' })]));
  expect(listed.code).toBe(2); expect(listed.err).toContain('CLI_INPUT_FIELD_INVALID'); expect(listed.err).toContain('afterId'); expect(listed.err).toContain('is missing');
  expect(listed.err).not.toContain('INVENTORY_QUERY_INVALID'); expect(listed.err).toMatch(/\\?"limit\\?":20/u);
  // An AI (or any JSON) decision without a reason is refused before anything is sent.
  const noReason = await run(['approval', 'decide', '--input', '-', '--lang', 'tr'], handlers, root, {}, Readable.from([JSON.stringify({ schemaVersion: 1, scopeId: 'live',
    approvalId: 'a1', commandId: 'c1', expectedRevision: 0, decision: 'allow' })]));
  expect(noReason.code).toBe(2); expect(noReason.err).toContain('reason'); expect(noReason.err).toContain('eksik');
  const extra = await run(['approval', 'inspect', '--input', '-'], handlers, root, {}, Readable.from([JSON.stringify({ schemaVersion: 1, scopeId: 'live', approvalId: 'a1', limit: 1 })]));
  expect(extra.code).toBe(2); expect(extra.err).toContain('limit');
  expect(seen).toEqual([]);
  const schema = await run(['approval', 'decide', '--schema'], handlers, root);
  expect(schema.code).toBe(0); // The decision schema is a union (once, or "this session" for a tool call): the projection lists both shapes, each with its required fields.
  expect(JSON.parse(schema.text).anyOf[0].required).toEqual(['schemaVersion', 'scopeId', 'approvalId', 'commandId', 'expectedRevision', 'decision', 'reason']);
});

it('AI path: --input --json returns the service result unchanged; without --json a person reads a table, waiting first', async () => {
  const root = await project(), page = [approval('decided-1', { status: 'decided', created: now - 7_200_000 }), approval('wait-1', { created: now - 120_000 })];
  const handlers = { listApprovals: async () => page };
  const json = await run(['approval', 'list', '--input', '-', '--json'], handlers, root, {}, Readable.from([JSON.stringify({ schemaVersion: 1, scopeId: 'live', afterId: null, limit: 5 })]));
  expect(json.code).toBe(0); expect(JSON.parse(json.text)).toEqual(JSON.parse(JSON.stringify(page)));
  const text = await run(['approval', 'list', '--input', '-', '--lang', 'tr'], handlers, root, {}, Readable.from([JSON.stringify({ schemaVersion: 1, scopeId: 'live', afterId: null, limit: 5 })]));
  expect(text.code).toBe(0); expect(text.text).not.toContain('{'); expect(text.text.indexOf('wait-1')).toBeLessThan(text.text.indexOf('decided-'));
  expect(text.text).toMatch(/bekliyor · 8 dk \d+ sn kaldı|bekliyor · 7 dk \d+ sn kaldı/u);
});

it('person path: `approval list` reads the default scope, names it, waiting first, bounded pages; --json is the raw page', async () => {
  const root = await project(), calls: unknown[] = [];
  const pageA = [approval('old-1', { status: 'expired', created: now - 3_600_000, ttl: 60_000 }), approval('wait-2', { created: now - 30_000 }),
    { request: { schemaVersion: 9, approvalId: 'future-1' }, revision: 0, status: 'pending', decision: null }];
  const handlers = { listApprovals: async (input: { afterId: string | null }) => { calls.push(input); return input.afterId === null ? pageA : []; } };
  const listed = await run(['approval', 'list', '--lang', 'en'], handlers, root);
  expect(listed.code).toBe(0);
  expect(lines(listed.text)[0]).toContain('live'); expect(listed.text).toContain('1 waiting · 2 in total'); expect(listed.text).toContain('expired (nothing ran)');
  expect(listed.text.indexOf('wait-2')).toBeLessThan(listed.text.indexOf('old-1'));
  // A record this build cannot read is counted, never silently dropped.
  expect(listed.text).toContain('1 record(s) could not be read by this version');
  expect(calls).toEqual([{ schemaVersion: 1, scopeId: 'live', afterId: null, limit: 100 }]);
  const json = await run(['approval', 'list', '--json'], handlers, root);
  expect(JSON.parse(json.text)).toHaveLength(3);
});

it('decide without --input: off a terminal (pipe, AI agent) nothing is asked or decided; the missing --input is named with an example', async () => {
  const root = await project(), seen: unknown[] = [];
  const handlers = { listApprovals: async () => [approval('wait-3')], decideApproval: async (input: unknown) => { seen.push(input); return null; } };
  const tty = Object.assign(Readable.from([]), { isTTY: true, setRawMode() { return this; } });
  // A pipe, and an AI agent on a real-looking terminal: never a card.
  for (const [env, terminal] of [[{}, false], [{ CLAUDECODE: '1' }, true], [{ AI_AGENT: 'x' }, true]] as const) {
    const result = await run(['approval', 'decide', '--lang', 'en'], { ...handlers, ...(terminal ? { stdout: { write() {}, isTTY: true } } : {}) }, root, env,
      terminal ? tty : Object.assign(Readable.from([]), { isTTY: false }));
    expect(result.code).toBe(2); expect(result.err).toContain('CLI_ARGUMENT_MISSING'); expect(result.err).toContain('--input');
  }
  expect(seen).toEqual([]);
});

it('the approval card: once / no only (a hard floor never "always"), system ids, default or own reason; cancel decides nothing; stored reviews govern whether Yes is available', async () => {
  const sent: Record<string, unknown>[] = [], requests: CliCardRequest[] = [];
  const context = { decideApproval: async (input: Record<string, unknown>) => { sent.push(input); return { ...approval('wait-4', { status: 'decided' }) }; } };
  const ask = (answer: string | null): CardAsk => async request => { requests.push(request); return answer; };
  for (const [record, answer, reason] of [[approval('wait-4'), 'once', undefined], [approval('floor-1', { cell: 'edit-floor' }), 'no', 'Not this file'],
    [approval('legacy-1', { legacy: true }), 'once', undefined], [approval('auth-1', { authority: true }), null, undefined]] as const) {
    await answerOnCard(record, reason, 'live', context as never, ask(answer), 'tr');
  }
  for (const request of requests) {
    expect(request.options.map(option => option.id)).toEqual(['once', 'no']);
    expect(request.options.some(option => option.id === 'always' || option.id === 'session')).toBe(false);
  }
  expect(requests[1]!.body!.join('\n')).toContain('Sert taban'); expect(requests[2]!.body!.join('\n')).toContain('Sert taban'); expect(requests[0]!.body!.join('\n')).not.toContain('Sert taban');
  expect(sent).toHaveLength(3);
  expect(sent[0]).toMatchObject({ approvalId: 'wait-4', decision: 'allow', expectedRevision: 0, channel: 'local-cli', reason: 'Terminalde onaylandı' });
  expect(String(sent[0]!['commandId'])).toMatch(/^cli-[0-9a-f-]{36}$/u); expect(sent[0]).not.toHaveProperty('approverNote');
  expect(sent[1]).toMatchObject({ approvalId: 'floor-1', decision: 'deny', reason: 'Not this file', approverNote: true });
  expect(sent[2]).toMatchObject({ approvalId: 'legacy-1', decision: 'allow' });
  // Picker rows are drawn as given by the card view, so the label itself is redacted (L-KIT: no secret in any rendered field).
  const token = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const label = approvalPickLabel(approval('secret-1', { summary: `curl -H "x-api-key: ${token}" https://api.example` }), 'en');
  expect(label).not.toContain('sk-ant-api03-AAAA'); expect(label).toContain('curl');
  expect(requests[0]!.body!.join('\n')).not.toContain('sk-ant');

  const pending = approval('packages'), heading = 'Review worker inputs';
  const firstRow = `pkg/first.js · pattern:url-userinfo · SHA-256 ${digest}`;
  const text = `${heading}\r${firstRow}\r\npkg/last\uFE0F.js\npkg/${token}.js`;
  if (pending.request.schemaVersion !== 3) throw new Error('Expected a v3 approval');
  const subject = { kind: 'run-create', runId: 'run-1', commandId: 'create', inputDigest: digest, admissionDigest: digest, decisionRecordId: 'd' } as const;
  const cut = { shown: 1, total: 4, bytes: Buffer.byteLength(heading), totalBytes: Buffer.byteLength(text), digest, kept: '/fixture/package-review.txt' };
  const truncated = { ...pending, request: { ...pending.request, subject,
    preview: { schemaVersion: 1 as const, argsDigest: digest, text: heading, cut } } };
  const complete = { ...truncated, request: { ...truncated.request, preview: { ...truncated.request.preview, text, cut: null } } };

  // The application also refuses a Yes supplied by the prompt adapter itself.
  await answerOnCard(truncated, undefined, 'live', context as never, ask('once'), 'tr');
  const card = requests.at(-1)!;
  expect(card.options.map(option => option.id)).toEqual(['once', 'no']);
  expect(card.options[0]).toMatchObject({ disabled: true });
  expect(card.body).toContain('Tam metin: /fixture/package-review.txt');
  expect(sent).toHaveLength(3);

  // Exercise the numbered and lettered options with a fresh TTY for each stored review.
  {
    const reasons = {
      en: 'This approval cannot be granted because its stored package review is incomplete. If the package is too large, you can use deckent coding template --allow-dependencies --kind <kind> --scope <id> to approve reuse before requesting the work again.',
      tr: 'Saklanan paket incelemesi eksik olduğu için bu kayıt onaylanamaz. Paket çok büyükse işi yeniden istemeden önce deckent coding template --allow-dependencies --kind <kind> --scope <id> ile yeniden kullanıma izin verebilirsiniz.',
    };
    for (const locale of ['en', 'tr'] as const) {
      expect(t('terminal.approval.window.reviewIncomplete', {}, locale)).toBe(reasons[locale]);
      expect(t('terminal.approval.window.choice.unavailable', {}, locale)).toBe(locale === 'en' ? 'Yes unavailable' : 'Evet kullanılamıyor');
    }
    for (const [kind, locale, record] of [['complete', 'tr', complete], ['cut', 'en', truncated]] as const) {
      const decisions: unknown[] = [], controller = new AbortController();
      let rendered = '';
      const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
      const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { rendered += String(chunk); done(); } }), { isTTY: true, columns: 280, rows: 40 });
      const context = { stdin, stdout, env: { TERM: 'xterm-256color', NO_COLOR: '1' }, signal: controller.signal,
        decideApproval: async (input: unknown) => { decisions.push(input); return null; } };
      const { ask } = cardIo(context, locale, 10_000);
      const answer = answerOnCard(record, undefined, 'live', context as never, (request, expiresAt) => {
        expect.soft(request.options.map(option => option.id)).toEqual(['once', 'no']);
        return ask(request, expiresAt);
      }, locale);
      try {
        const ready = locale === 'en' ? 'Enter confirm' : 'Enter onayla';
        await until(() => rendered.includes(ready), 'armed CLI approval', 120);
        if (process.env.DECKENT_L1_FRAME_PROOF) await writeFile(`${process.env.DECKENT_L1_FRAME_PROOF}-cli-${locale}-${kind}.txt`, rendered);
        if (kind === 'cut') {
          expect.soft(rendered).not.toContain(locale === 'en' ? 'Yes, once' : 'Evet, bu sefer');
          expect.soft(rendered).toContain(locale === 'en' ? '1. Yes unavailable (y)' : '1. Evet kullanılamıyor (y)');
          expect.soft(rendered).toContain(locale === 'en' ? '2. No (n)' : '2. Hayır (n)');
          expect.soft(rendered).toContain(reasons[locale]);
          for (const [key, move, selected] of [['1', '\u001b[A', '› 1.'], ['y', '\u001b[B', '› 2.']] as const) {
            const start = rendered.length;
            // Keep the shortcut and the navigation in separate reads so Ink cannot discard them as a burst.
            const read = once(stdin, 'readable');
            stdin.write(key);
            await read;
            await yieldToInput();
            stdin.write(move);
            await until(() => rendered.includes(selected, start), 'cut CLI approval highlight');
            expect.soft(decisions).toEqual([]);
            expect.soft(rendered.slice(start)).toContain(reasons[locale]);
          }
          stdin.write('2'); await answer;
          expect.soft(decisions).toEqual([expect.objectContaining({ decision: 'deny' })]);
        } else {
          expect(rendered).toContain('1. Evet, bu sefer (y)');
          expect.soft(rendered).not.toContain(reasons[locale]);
          expect.soft(rendered).toContain('pkg/last<U+FE0F>.js');
          expect.soft(rendered).toContain('1 gizli karakter');
          expect.soft(rendered).toContain(firstRow);
          expect.soft(rendered.split('\n').find(line => line.includes(firstRow)) ?? '').not.toContain('pkg/last<U+FE0F>.js');
          expect.soft(rendered).not.toContain(token);
          expect.soft(rendered).toContain('[REDACTED]');
          stdin.write('1'); await answer;
          expect.soft(decisions).toEqual([expect.objectContaining({ decision: 'allow' })]);
        }
      } finally { controller.abort(); await answer; }
    }
  }
});

it('an approval card closes at the earlier deadline and sends nothing for an answer at expiry', async () => {
  const record = approval('short-lived', { created: now - 1_000, ttl: 2_000 });
  const decideApproval = vi.fn(async () => null), context = { env: {}, decideApproval };
  const clock = vi.spyOn(Date, 'now'), timeout = vi.spyOn(AbortSignal, 'timeout'), card = vi.spyOn(cards, 'askCliCard');
  try {
    for (const [ttl, elapsed, answer, bound, locale, message] of [
      [5_000, 1_000, null, 1_000, 'en', 'This approval expired. No decision was recorded.'],
      [5_000, 1_000, 'once', 1_000, 'en', 'This approval expired. No decision was recorded.'],
      [5_000, 1_000, 'no', 1_000, 'tr', 'Bu onayın süresi doldu. Karar kaydedilmedi.'],
      [5_000, 999, null, 1_000, 'en', 'No answer; nothing was decided.'],
      [500, 500, null, 500, 'en', 'No answer; nothing was decided.'],
    ] as const) {
      clock.mockReturnValue(now);
      card.mockImplementationOnce(async () => { clock.mockReturnValue(now + elapsed); return answer; });
      const result = await answerOnCard(record, undefined, 'live', context, cardIo(context, locale, ttl).ask, locale);
      expect(timeout).toHaveBeenLastCalledWith(bound);
      expect(decideApproval).not.toHaveBeenCalled();
      expect(result).toBe(message);
    }
  } finally { card.mockRestore(); timeout.mockRestore(); clock.mockRestore(); }
});

it('approval decide and decisions started from list require a matching recorded decision, including Deny', async () => {
  const root = await project(), record = approval('pending-1'), tty = Object.assign(Readable.from([]), { isTTY: true });
  const listApprovals = vi.fn(async (): Promise<ApprovalRecord[]> => [record]);
  const decided = approval('pending-1', { status: 'decided' });
  const decideApproval = vi.fn(async (input: { commandId: string }): Promise<unknown> => ({ ...decided, decision: { ...decided.decision!, commandId: input.commandId, decision: 'deny' as const } }));
  const out: string[] = [];
  const handlers = { listApprovals, decideApproval, configChoiceSources: () => ({ list: async () => [{ value: 'live' }] }),
    stdout: { isTTY: true, write: (value: string) => { out.push(value); } } };
  const invoke = (cmd: string, ...args: string[]) => run(['approval', cmd, '--lang', 'en', ...args], handlers, root, { TERM: 'xterm' }, tty);
  const card = vi.spyOn(cards, 'askCliCard'), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    card.mockResolvedValueOnce(null);
    expect.soft((await invoke('decide')).code, 'scope picker cancelled').toBe(1);
    expect(listApprovals).not.toHaveBeenCalled();
    listApprovals.mockResolvedValueOnce([]);
    expect.soft((await invoke('decide', '--scope', 'live')).code, 'no eligible record').toBe(1);
    card.mockResolvedValueOnce(null);
    expect.soft((await invoke('decide', '--scope', 'live')).code, 'approval picker cancelled').toBe(1);
    card.mockResolvedValueOnce(record.request.approvalId).mockResolvedValueOnce(null).mockResolvedValueOnce('-leave');
    expect.soft((await invoke('decide', '--scope', 'live')).code, 'card unanswered').toBe(1);
    expect(out.join('')).toContain('No answer; nothing was decided.');
    card.mockResolvedValueOnce(record.request.approvalId).mockImplementationOnce(async () => {
      clock.mockReturnValue(record.request.expiresAt);
      return 'once';
    });
    expect.soft((await invoke('decide', '--scope', 'live')).code, 'card expired').toBe(1);
    expect(out.join('')).toContain('This approval expired. No decision was recorded.');
    expect(decideApproval).not.toHaveBeenCalled();
    clock.mockReturnValue(now);
    card.mockResolvedValueOnce(record.request.approvalId).mockResolvedValueOnce('no');
    listApprovals.mockResolvedValueOnce([record]).mockResolvedValueOnce([]);
    expect((await invoke('decide', '--scope', 'live')).code).toBe(0);
    expect(decideApproval).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ approvalId: record.request.approvalId, decision: 'deny' }));
    card.mockResolvedValueOnce('-leave');
    expect((await invoke('list', '--scope', 'live')).code).toBe(0);
    card.mockResolvedValueOnce(record.request.approvalId).mockResolvedValueOnce(null).mockResolvedValueOnce('-leave');
    expect.soft((await invoke('list', '--scope', 'live')).code, 'list decision unanswered').toBe(1);
    for (const [command, result, label] of [
      ['decide', () => null, 'null receipt from decide'],
      ['list', () => null, 'null receipt from list'],
      ['list', (input: { commandId: string }) => ({ ...decided, request: approval('another').request, decision: { ...decided.decision, commandId: input.commandId, decision: 'deny' } }), 'different approval id'],
      ['decide', () => record, 'old pending revision'],
      ['decide', () => ({ ...decided, decision: { ...decided.decision, decision: 'deny' } }), 'different command id'],
    ] as const) {
      out.length = 0;
      card.mockResolvedValueOnce(record.request.approvalId).mockResolvedValueOnce('no').mockResolvedValueOnce('-leave');
      decideApproval.mockImplementationOnce(async input => result(input));
      expect.soft((await invoke(command, '--scope', 'live')).code, label).toBe(1);
      expect(out.join('')).toContain(label.startsWith('null') ? 'No such approval in this scope.' : 'The service did not confirm this decision.');
    }
    out.length = 0;
    card.mockResolvedValueOnce(record.request.approvalId).mockResolvedValueOnce('no');
    listApprovals.mockResolvedValueOnce([record]).mockResolvedValueOnce([]);
    expect((await invoke('list', '--scope', 'live')).code).toBe(0);
    const later = approval('pending-2');
    for (const command of ['list', 'decide']) {
      // Leave on the first pick: the list was shown (0); a decision was asked for and none was made (1).
      card.mockResolvedValueOnce('-leave');
      expect.soft((await invoke(command, '--scope', 'live')).code, `${command}: leave without selecting`).toBe(command === 'decide' ? 1 : 0);
      // Leaving after a recorded decision keeps what the session did.
      listApprovals.mockResolvedValueOnce([record, later]).mockResolvedValueOnce([later]);
      card.mockResolvedValueOnce(record.request.approvalId).mockResolvedValueOnce('no').mockResolvedValueOnce('-leave');
      expect.soft((await invoke(command, '--scope', 'live')).code, `${command}: leave after a recorded Deny`).toBe(0);
      for (const answer of ['no', null]) {
        out.length = 0;
        decideApproval.mockClear();
        listApprovals.mockResolvedValueOnce([record, later]).mockResolvedValueOnce([later]).mockResolvedValueOnce([later]);
        card.mockResolvedValueOnce(record.request.approvalId).mockResolvedValueOnce('no')
          .mockResolvedValueOnce(later.request.approvalId).mockResolvedValueOnce(answer).mockResolvedValueOnce('-leave');
        const tr = await run(['approval', command, '--scope', 'live', '--lang', 'tr'], handlers, root, { TERM: 'xterm' }, tty);
        expect.soft(tr.code, `${command}: ${answer === null ? 'unanswered' : 'mismatched receipt'} after recorded Deny`).toBe(1);
        expect(decideApproval).toHaveBeenNthCalledWith(1, expect.objectContaining({ approvalId: record.request.approvalId, decision: 'deny' }));
        expect(out.join('')).toContain('Karar: reddedildi');
        expect(out.join('')).toContain(answer === null ? 'Yanıt verilmedi; hiçbir karar kaydedilmedi.' : 'Hizmet bu kararı doğrulamadı.');
      }
    }
    // Without a default scope the list first asks for one; a cancelled pick shows no list.
    const bare = await project({});
    for (const [lang, sentence] of [['en', 'Cancelled. No scope was chosen, so nothing was shown.'], ['tr', 'Vazgeçildi. Kapsam seçilmediği için hiçbir şey gösterilmedi.']] as const) {
      listApprovals.mockClear(); card.mockClear(); card.mockResolvedValueOnce(null);
      const cancelled = await run(['approval', 'list', '--lang', lang], handlers, bare, { TERM: 'xterm' }, tty);
      expect.soft(cancelled.code, `list scope pick cancelled (${lang})`).toBe(1);
      expect(card).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ options: [expect.objectContaining({ id: 'live' })] }), expect.anything());
      expect(listApprovals).not.toHaveBeenCalled(); expect(cancelled.err.trim()).toBe(sentence);
    }
  } finally { card.mockRestore(); clock.mockRestore(); }
});

it('decide: `{}` names the missing field (no "model call" text), --schema prints the contract, bare decide lists recent decisions', async () => {
  const root = await project(), queries: unknown[] = [];
  const empty = await run(['decide', 'inspect', '--input', '-', '--lang', 'en'], { inspectDecision: async () => { throw new Error('sent'); } }, root, {}, Readable.from(['{}']));
  expect(empty.code).toBe(2); expect(empty.err).toContain('CLI_INPUT_FIELD_INVALID'); expect(empty.err).toContain('schemaVersion'); expect(empty.err).not.toMatch(/model call/iu);
  expect(empty.err).toContain('is missing');
  const schema = await run(['decide', 'record', '--schema'], {}, root);
  expect(schema.code).toBe(0); expect(schema.text).toContain('selectedOption');
  const item = (id: string, claimedAtMs: number, selected?: string) => ({ schemaVersion: 1, status: 'advised', decisionId: id, caseDigest: digest, adviceDigest: digest, invocationId: 'i',
    advice: { schemaVersion: 1, choice: 'a', probabilities: { a: 0.9, none_of_the_above: 0.05, insufficient_information: 0.05 }, confidence: 0.8, sufficiency: 0.9, checks: {}, model: 'm',
      usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 }, thresholds: { choice: 0.85, sufficiency: 0.67 },
    record: selected ? { actor: { selectedOption: selected, rationale: 'fits' }, outcome: null } : null, replayed: false, claimedAtMs,
    case: { objective: `Pick the release for ${id}`, options: [{ id: 'a', action: 'ship', tradeoffs: [], evidenceIds: [] }] } });
  const out: string[] = [];
  await decisionCommand(['decide', '--lang', 'tr'], { root, env: { HOME: join(root, 'h'), NO_COLOR: '1' }, stdout: { write: (text: string) => { out.push(text); } },
    listDecisions: async (_root: string, query: unknown) => { queries.push(query); return { schemaVersion: 1, scopeId: 'live', items: [item('dec-new', now - 60_000, 'a'), item('dec-old', now - 7_200_000)] }; } } as never);
  expect(queries).toEqual([{ schemaVersion: 1, scopeId: 'live', limit: 20 }]);
  const text = out.join('');
  expect(text).toContain('live'); expect(text.indexOf('dec-new')).toBeLessThan(text.indexOf('dec-old')); expect(text).toContain('Pick the release'); expect(text).not.toContain(digest);
});

it('policy: summary (labelled admin, counts, hashes only with --verbose), own grants by default, --all refused before any read, vocabulary table', async () => {
  const root = await project(), reads: string[] = [];
  const status = { schemaVersion: 1, scopeId: 'live', revision: 'rev-123', admins: [{ issuer: 'host', subject: 'DESKTOP/1000' }], usableAdminCount: 1,
    template: { kind: 'hand-built', version: null, recognition: 'revision-only' }, bootstrapRequired: false, recoveryRequired: false, identityReadiness: 'not-verified' };
  const view: DecisionDelegationView = { schemaVersion: 1, scopeId: 'live', revision: 'p', resourceId: null, principal: { issuer: 'host/mcp', subject: 'p' },
    steps: getDecisionSteps().map((step, index) => ({ step, managed: index === 0 ? 'granted' : 'none', effective: index === 0 ? 'allowed' : 'denied' })) };
  const handlers = { inspectPolicyAdministration: async () => { reads.push('status'); return status; },
    listStandingGrants: async () => { reads.push('grants'); return [{ id: 'standing-1', key: 'k', tool: 'shell', kind: 'command', text: 'npm test' }]; },
    delegations: { inspect: async () => view, change: async () => { throw new Error('no change'); } },
    mcpCapabilities: { listMcpCapabilityScopes: async () => ['live'], changeMcpCapabilities: async () => { throw new Error('no change'); },
      inspectMcpCapabilities: async () => { throw Object.assign(new Error('denied'), { code: 'POLICY_DENIED' }); } } };
  const summary = await run(['policy', 'status', '--lang', 'tr'], handlers, root);
  expect(summary.code).toBe(0);
  expect(summary.text).toContain('Yönetici: host/DESKTOP/1000'); expect(summary.text).toContain('kullanılabilir yönetici'); expect(summary.text).toContain('Kalıcı onaylarım: 1');
  expect(summary.text).toContain(`${getDecisionSteps().length} içinde 1 açık`); expect(summary.text).toContain('okunamadı: POLICY_DENIED'); expect(summary.text).not.toContain('rev-123');
  expect(summary.text).toContain('Benimsemeyi geri alma: attempt / rollback-integration; deliver-working-tree kuralından ayrı yönetilir.');
  const english = await run(['policy', 'show', '--lang', 'en'], handlers, root);
  expect(english.code).toBe(0);
  expect(english.text).toContain('Undo adoption: attempt / rollback-integration; managed separately from deliver-working-tree.');
  expect((await run(['policy', 'show', '--lang', 'tr'], handlers, root)).text).toBe(summary.text);
  expect((await run(['policy', 'status', '--verbose'], handlers, root)).text).toContain('rev-123');
  expect(JSON.parse((await run(['policy', 'status', '--json'], handlers, root)).text)).toEqual(status);
  expect(JSON.parse((await run(['policy', 'show', '--json'], handlers, root)).text)).toEqual(status);
  reads.length = 0;
  const own = await run(['policy', 'grants', '--lang', 'en'], handlers, root);
  expect(own.code).toBe(0); expect(own.text).toContain('standing-1'); expect(reads).toEqual(['grants']);
  reads.length = 0;
  const all = await run(['policy', 'grants', '--all'], handlers, root);
  expect(all.code).toBe(2); expect(all.err).toContain('CLI_POLICY_GRANTS_ALL_UNAVAILABLE'); expect(reads).toEqual([]);
  // No --lang: the installation's configured language (tr here), not the English of the environment.
  const trRoot = await project({ terminal: { scopeId: 'live' }, language: 'tr' });
  const vocabulary = await run(['policy', 'vocabulary'], {}, trRoot, { LANG: 'C' });
  expect(vocabulary.code).toBe(0); expect(vocabulary.text).not.toContain('{'); expect(vocabulary.text).toContain('Kaynak'); expect(vocabulary.text).toContain('yetki vermez');
  const delegations = await run(['policy', 'delegations', '--lang', 'en'], handlers, root);
  expect(delegations.code).toBe(0); expect(delegations.text).toContain('live'); expect(delegations.text).toContain(' on'); expect(delegations.text).toContain(' off');
});

it('TTY toggles: declined or cancelled → no governed change; yes → the existing change with the reviewed revision / preview digest', async () => {
  const root = await project(), changes: unknown[] = [], confirmed: boolean[] = [];
  const view: DecisionDelegationView = { schemaVersion: 1, scopeId: 'live', revision: 'rev-1', resourceId: null, principal: { issuer: 'host/mcp', subject: 'p' },
    steps: getDecisionSteps().map(step => ({ step, managed: 'none', effective: 'denied' })) };
  const delegations = { inspect: async () => view, change: async (_root: string, command: unknown, confirm: (reviewed: DecisionDelegationView) => Promise<boolean>) => {
    changes.push(command); const yes = await confirm(view); confirmed.push(yes); return { status: yes ? 'applied' : 'cancelled', view } as const; } };
  const cards: CliCardRequest[] = [];
  const answers = (...ids: (string | null)[]): CardAsk => async request => { cards.push(request); return ids.shift() ?? null; };
  const context = { root, env: { HOME: join(root, 'h'), NO_COLOR: '1' }, stdout: { write() {} }, delegations } as never;
  const step = getDecisionSteps()[0]!.id;
  expect.soft(await toggleDelegations(context, 'en', 'live', 1000, answers(step, 'no'))).toBe(1);
  expect.soft(await toggleDelegations(context, 'en', 'live', 1000, answers(step, null))).toBe(1);
  expect((await toggleDelegations(context, 'en', 'live', 1000, answers('-leave'))) ?? 0).toBe(0);
  expect(confirmed).toEqual([false, false]);
  // The preview card speaks plain words (off → on), never the policy revision hash.
  expect(cards[1]!.body!.join('\n')).toContain('off → on'); expect(cards[1]!.body!.join('\n')).not.toContain('rev-1');
  expect(cards[0]!.options.map(option => option.label).join(' ')).toContain('· off');
  expect((await toggleDelegations(context, 'en', 'live', 1000, answers(step, 'apply'))) ?? 0).toBe(0);
  expect(confirmed).toEqual([false, false, true]);
  expect(changes.at(-1)).toMatchObject({ scopeId: 'live', step, action: 'grant', actor: 'mcp', expectedRevision: 'rev-1' });
  const group = mcpCapabilityRegistry.list()[0]!, mcpCalls: Record<string, unknown>[] = [];
  const preview = { schemaVersion: 1, status: 'preview', revision: 'r', digest: 'preview-digest', principal: { issuer: 'host/mcp', subject: 'p' }, rules: [], change: null, missing: [],
    action: 'grant', scopeId: 'live', groupId: group.id };
  const mcpCapabilities = { listMcpCapabilityScopes: async () => ['live'],
    inspectMcpCapabilities: async () => ({ schemaVersion: 1, scopeId: 'live', revision: 'r', principal: preview.principal, groups: [{ group, managed: 'none', effective: 'denied' }] }),
    changeMcpCapabilities: vi.fn(async (_root: string, input: Record<string, unknown>) => {
      mcpCalls.push(input); return { ...preview, status: input['mode'] === 'apply' ? 'applied' : 'preview' };
    }) };
  const mcpContext = { root, env: { HOME: join(root, 'h'), NO_COLOR: '1' }, stdout: { write() {} }, mcpCapabilities } as never;
  expect.soft(await toggleMcp(mcpContext, 'tr', 'live', 1000, answers(group.id, 'no'))).toBe(1);
  expect(mcpCalls.map(call => call['mode'])).toEqual(['preview']);
  expect((await toggleMcp(mcpContext, 'tr', 'live', 1000, answers(group.id, 'apply'))) ?? 0).toBe(0);
  expect(mcpCalls.at(-1)).toMatchObject({ mode: 'apply', expect: 'preview-digest', action: 'grant', groupId: group.id, scopeId: 'live' });
  mcpCapabilities.changeMcpCapabilities.mockResolvedValueOnce({ ...preview, missing: ['delegation'] });
  expect.soft(await toggleMcp(mcpContext, 'tr', 'live', 1000, answers(group.id))).toBe(1);
  mcpCapabilities.changeMcpCapabilities.mockResolvedValueOnce({ ...preview, status: 'current' });
  expect((await toggleMcp(mcpContext, 'tr', 'live', 1000, answers(group.id))) ?? 0).toBe(0);
  mcpCapabilities.changeMcpCapabilities.mockResolvedValueOnce(preview).mockResolvedValueOnce({ ...preview, status: 'conflict' });
  await expect(toggleMcp(mcpContext, 'tr', 'live', 1000, answers(group.id, 'apply'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  // Without a default scope each menu first asks for one; a cancelled pick shows no table and changes nothing.
  const bare = await project({}), err: string[] = [], seen = { cards: cards.length, changes: changes.length, mcp: mcpCalls.length };
  const picking = (port: object) => ({ root: bare, env: { HOME: join(bare, 'h'), NO_COLOR: '1' }, stdout: { write() {} }, stderr: { write: (value: string) => { err.push(value); } },
    configChoiceSources: () => ({ list: async () => [{ value: 'live' }, { value: 'other' }] }), ...port }) as never;
  expect.soft(await toggleDelegations(picking({ delegations }), 'en', undefined, 1000, answers(null))).toBe(1);
  expect.soft(await toggleMcp(picking({ mcpCapabilities }), 'tr', undefined, 1000, answers(null))).toBe(1);
  expect(cards.slice(seen.cards).map(card => card.options.map(option => option.id))).toEqual([['live', 'other'], ['live', 'other']]);
  expect([changes.length, mcpCalls.length]).toEqual([seen.changes, seen.mcp]);
  expect(err.map(line => line.trim())).toEqual(['Cancelled. No scope was chosen, so nothing was shown.', 'Vazgeçildi. Kapsam seçilmediği için hiçbir şey gösterilmedi.']);
});

it('MCP-NO-DECIDE kept: the MCP surface has no approval or decision decide tool', async () => {
  const { createMcpServer } = await import('#surfaces/core/mcp/index.js');
  const { Client } = await import('@modelcontextprotocol/client'), { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const server = createMcpServer({} as never, { maxConcurrentCalls: 1, responseMaxBytes: 65536 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'no-decide', version: '1' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).not.toContain('decide_approval'); expect(names).not.toContain('record_decision');
    expect(names.filter(name => /decide|record_decision|outcome_decision/u.test(name))).toEqual([]);
  } finally { await client.close(); }
});
