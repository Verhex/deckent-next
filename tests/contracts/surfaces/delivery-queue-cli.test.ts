import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { queueCommand, renderQueueList } from '#surfaces/core/delivery-queue/index.js';
import { DELIVERY_RENDER_LIMITS } from '#surfaces/core/delivery-summary/index.js';
import { renderQueueConsent } from '#surfaces/core/effect-confirmation/index.js';
import { clearConfigCache, ErrorRegistry } from '#platform/index.js';
import { queueTicketCommandIds, targetQueueViewSchema } from '#engine/index.js';
import { deliverySummaryFixture } from '../support/delivery-summary-fixture.js';
import { registerProviderConfig } from '#adapters/index.js';
import { homeEnv } from '../support/host-platform.js';

const sampleView = (commandId: string, over: Record<string, unknown> = {}) => targetQueueViewSchema.parse({
  schemaVersion: 1, commandId, identity: { runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', scopeId: 's', layoutRevision: 'layout-1', generation: 1 },
  operation: 'delivery', target: { kind: 'git-ref', id: 'refs/heads/main' },
  display: { schemaVersion: 1, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' },
  state: 'awaiting-confirmation', outcome: null, revision: 3, observedAt: 1_760_000_000_000, freshness: 'last-known', position: 1, nextAction: 'confirm-batch',
  responsibility: 'human', basis: null, verification: { phase: 'accepted', receipt: 'b'.repeat(64) }, evidenceRefs: [], reason: null, ...over });
registerProviderConfig(); // the `terminal` section (terminal.scopeId) is registered by the composed entry
/** A project root with an optional `language` and a stand-in queue client recording each call. */
function project(language?: string) {
  const root = mkdtempSync(join(tmpdir(), 'deckent-queue-cli-')); mkdirSync(join(root, '.deckent'));
  writeFileSync(join(root, '.deckent', 'config.json'), JSON.stringify(language ? { language } : {})); clearConfigCache();
  const calls: string[] = [], output: string[] = [], locales: string[] = [];
  const record = (name: string) => async (input: unknown) => { calls.push(`${name} ${JSON.stringify(input)}`);
    return name === 'inspect' ? { schemaVersion: 1, record: sampleView('q1') } : sampleView('q1'); };
  const context = { root, env: { ...homeEnv(join(root, 'home')), LANG: 'C.UTF-8' }, stdout: { write: (text: string) => { output.push(text); } }, stderr: { write: () => {} },
    onLocale: (locale: string) => { locales.push(locale); },
    deliveryQueue: { inspectTargetQueue: record('inspect'), enqueueTargetQueueRollback: record('rollback'), enqueueTargetQueue: record('enqueue'), listTargetQueue: record('list') },
    confirmDeliveryQueue: async () => { calls.push('confirm'); return { settledPrefix: 0, items: [] }; } };
  return { context: context as never, calls, output, locales };
}

describe('delivery queue CLI flags (QUEUE-SMALL 6)', () => {
  it('inspect and confirm refuse --source-command-id and unknown flags with CLI_USAGE before any queue call; rollback keeps it', async () => {
    const p = project();
    for (const argv of [['task', 'integration-queue-inspect', '--scope', 's', '--command-id', 'q1', '--source-command-id', 'q0'],
      ['task', 'integration-queue-confirm', '--scope', 's', '--command-id', 'q1', '--source-command-id', 'q0'],
      ['task', 'integration-queue-inspect', '--scope', 's', '--command-id', 'q1', '--target', 'refs/heads/x'],
      ['task', 'integration-queue-list', '--scope', 's', '--command-id', 'q1'],
      ['task', 'integration-queue-enqueue', '--input', '-', '--scope', 's']])
      await expect(queueCommand(argv, p.context), argv.join(' ')).rejects.toMatchObject({ code: 'CLI_USAGE' });
    expect(p.calls).toEqual([]);
    await queueCommand(['task', 'integration-queue-rollback', '--scope', 's', '--source-command-id', 'q0', '--command-id', 'r1'], p.context);
    await queueCommand(['task', 'integration-queue-inspect', '--scope', 's', '--command-id', 'q1'], p.context);
    expect(p.calls).toEqual(['rollback {"schemaVersion":1,"scopeId":"s","commandId":"r1","sourceCommandId":"q0"}', 'inspect {"schemaVersion":1,"scopeId":"s","commandId":"q1"}']);
  });
});

describe('delivery queue CLI language (QUEUE-SMALL 7)', () => {
  it('the configured language wins over LANG=C.UTF-8 (the N1 wrapper); --lang still wins over the configuration', async () => {
    const turkish = project('tr');
    await queueCommand(['task', 'integration-queue-inspect', '--scope', 's', '--command-id', 'q1'], turkish.context);
    expect(turkish.locales.at(-1)).toBe('tr'); expect(turkish.output.join('')).toContain('Teslim bileti q1');
    const explicit = project('tr');
    await queueCommand(['task', 'integration-queue-inspect', '--scope', 's', '--command-id', 'q1', '--lang', 'en'], explicit.context);
    expect(explicit.locales.at(-1)).toBe('en'); expect(explicit.output.join('')).toContain('Delivery ticket q1');
    const unset = project();
    await queueCommand(['task', 'integration-queue-inspect', '--scope', 's', '--command-id', 'q1'], unset.context);
    expect(unset.locales.at(-1)).toBe('en');
  });
});

/** alpha.53 D1: scope defaults, typed errors and human ticket views (MAP-CLI-INSAN S1). */
describe('delivery queue CLI scope and typed errors (alpha.53 D1)', () => {
  function configured(scope?: string) {
    const p = project(); const root = (p.context as { root: string }).root;
    writeFileSync(join(root, '.deckent', 'config.json'), JSON.stringify(scope ? { terminal: { scopeId: scope } } : {})); clearConfigCache();
    return p;
  }
  it('a read without --scope uses the configured scope and says so; --json stays the client page', async () => {
    const p = configured('live');
    await queueCommand(['task', 'integration-queue-inspect', '--command-id', 'q1'], p.context);
    expect(p.calls).toEqual(['inspect {"schemaVersion":1,"scopeId":"live","commandId":"q1"}']);
    expect(p.output.join('')).toMatch(/^scope: live \(default\)\n/);
    p.output.length = 0; await queueCommand(['task', 'integration-queue-list', '--json'], p.context);
    expect(p.output.join('')).not.toContain('scope: live'); expect(p.calls.at(-1)).toContain('"scopeId":"live"');
  });
  it('without --scope and no configured scope a read and a change get CLI_SCOPE_REQUIRED, never a raw validation array', async () => {
    const p = configured();
    for (const argv of [['task', 'integration-queue-list'], ['task', 'integration-queue-inspect', '--command-id', 'q1'],
      ['task', 'integration-queue-rollback', '--source-command-id', 'q0', '--command-id', 'r1'], ['task', 'integration-queue-confirm', '--command-id', 'q1']])
      await expect(queueCommand(argv, p.context), argv.join(' ')).rejects.toMatchObject({ code: 'CLI_SCOPE_REQUIRED' });
    expect(p.calls).toEqual([]);
  });
  it('a change never takes the configured default scope', async () => {
    const p = configured('live');
    await expect(queueCommand(['task', 'integration-queue-rollback', '--source-command-id', 'q0', '--command-id', 'r1'], p.context)).rejects.toMatchObject({ code: 'CLI_SCOPE_REQUIRED' });
    expect(p.calls).toEqual([]);
  });
  it('a missing argument is CLI_ARGUMENT_MISSING naming it; an invalid value is CLI_USAGE naming the flag', async () => {
    const p = project();
    await expect(queueCommand(['task', 'integration-queue-inspect', '--scope', 's'], p.context)).rejects.toMatchObject({ code: 'CLI_ARGUMENT_MISSING', message: expect.stringContaining('--command-id') });
    await expect(queueCommand(['task', 'integration-queue-rollback', '--scope', 's', '--command-id', 'r1'], p.context)).rejects.toMatchObject({ code: 'CLI_ARGUMENT_MISSING', message: expect.stringContaining('--source-command-id') });
    await expect(queueCommand(['task', 'integration-queue-enqueue'], p.context)).rejects.toMatchObject({ code: 'CLI_ARGUMENT_MISSING', message: expect.stringContaining('--input') });
    await expect(queueCommand(['task', 'integration-queue-list', '--scope', 's', '--limit', 'many'], p.context)).rejects.toMatchObject({ code: 'CLI_USAGE', message: expect.stringContaining('--limit') });
    await expect(queueCommand(['task', 'integration-queue-inspect', '--scope', ' bad', '--command-id', 'q1'], p.context)).rejects.toMatchObject({ code: 'CLI_USAGE', message: expect.stringContaining('--scope') });
    expect(p.calls).toEqual([]);
  });
  for (const [language, expected] of [['en', ['Delivery ticket q1 · task task-1 · delivery', 'Target — Integration target: refs/heads/main', 'State: Awaiting human confirmation', 'Position in the queue: 1',
    'Verification: passed', 'Next step: Confirm exact batch', 'Confirm in this terminal: deckent task integration-queue-confirm --scope s --command-id q1']],
  ['tr', ['Teslim bileti q1 · görev task-1 · teslim', 'Hedef — Entegrasyon hedefi: refs/heads/main']]] as const) {
    it(`inspect, enqueue and rollback print a human ${language} ticket view, not JSON; --json is unchanged`, async () => {
      const p = project(language);
      for (const argv of [['task', 'integration-queue-inspect', '--scope', 's', '--command-id', 'q1'], ['task', 'integration-queue-rollback', '--scope', 's', '--source-command-id', 'q0', '--command-id', 'q1']]) {
        p.output.length = 0; await queueCommand(argv, p.context);
        const text = p.output.join(''); for (const line of expected) expect(text).toContain(line);
        for (const raw of ['{', 'schemaVersion', 'labelKey', 'queue.state.', 'nextAction']) expect(text).not.toContain(raw);
      }
      p.output.length = 0; await queueCommand(['task', 'integration-queue-inspect', '--scope', 's', '--command-id', 'q1', '--json'], p.context);
      expect(JSON.parse(p.output.join('')).record.commandId).toBe('q1');
    });
  }
  it('confirm prints the settled prefix and one line per ticket with its typed reason', async () => {
    const p = project();
    (p.context as { confirmDeliveryQueue: unknown }).confirmDeliveryQueue = async () => ({ settledPrefix: 1, items: [
      { commandId: 'q1', published: true, state: 'settled' }, { commandId: 'q2', published: false, state: 'refused', reason: 'QUEUE_VERIFICATION_NOT_ADMITTED' }] });
    await queueCommand(['task', 'integration-queue-confirm', '--scope', 's', '--command-id', 'q1'], p.context);
    const text = p.output.join('');
    expect(text).toContain('Confirmed batch: 1 of 2 ticket(s) settled'); expect(text).toContain('q1: settled (published)');
    expect(text).toContain(`q2: refused (not published). ${ErrorRegistry.createError('QUEUE_VERIFICATION_NOT_ADMITTED', { locale: 'en' }).message}`);
    expect(text).not.toContain('{');
  });
});

/** Owner CLI review 2026-10-19 (C-PRIO): the human list is a table where a parked delivery is visible; `--json` keeps today's bytes. */
describe('delivery queue list table (C-PRIO)', () => {
  const digest = 'a'.repeat(64);
  const ticket = (commandId: string, taskId: string, state: string, outcome: string | null, nextAction: string, reason: string | null = null) => targetQueueViewSchema.parse({
    schemaVersion: 1, commandId, identity: { runId: 'run-1', taskId, attemptId: `attempt-${taskId}`, scopeId: 's', layoutRevision: 'layout-1', generation: 1 },
    operation: 'delivery', target: { kind: 'git-ref', id: 'refs/heads/main' },
    display: { schemaVersion: 1, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' },
    state, outcome, revision: 3, observedAt: 1_760_000_000_000, freshness: 'last-known', position: state === 'queued' ? 1 : null, nextAction,
    responsibility: 'service', basis: null, verification: outcome === 'verification-failed' ? { phase: 'failed', receipt: digest } : null, evidenceRefs: [], reason });
  // The five states the owner named: adopted, verification failed, waiting, stale base, parked; page order is the service's (command id).
  const page = { schemaVersion: 1 as const, records: [
    ticket('q-adopted', 'task-adopt', 'settled', 'adopted', 'inspect-receipt'),
    ticket('q-failed', 'task-verify', 'settled', 'verification-failed', 'new-attempt'),
    ticket('q-parked', 'task-park', 'parked', null, 'prepare-current', 'QUEUE_VERIFICATION_NOT_ADMITTED'),
    ticket('q-stale', 'task-stale', 'settled', 'stale-refused', 'prepare-current'),
    ticket('q-waiting', 'task-wait', 'queued', null, 'wait-service')] };
  function listing(language: string) {
    const p = project(language);
    (p.context as { deliveryQueue: { listTargetQueue: (input: unknown) => Promise<unknown> } }).deliveryQueue.listTargetQueue = async input => { p.calls.push(`list ${JSON.stringify(input)}`); return page; };
    return p;
  }
  for (const [language, expected] of [['en', [
    'Delivery queue · scope s · tickets: 5 (in flight first)',
    'Task         Target           State                    Next step                   Ticket',
    'task-wait    refs/heads/main  Queued                   Wait for service            q-waitin',
    'task-adopt   refs/heads/main  Adopted                  Inspect durable receipt     q-adopte',
    'task-verify  refs/heads/main  Verification failed      Create a new attempt        q-failed',
    'task-park    refs/heads/main  Parked                   Re-prepare on current base  q-parked',
    `    Reason: ${ErrorRegistry.createError('QUEUE_VERIFICATION_NOT_ADMITTED', { locale: 'en' }).message}`,
    'task-stale   refs/heads/main  Stale candidate refused  Re-prepare on current base  q-stale']],
  ['tr', [
    'Teslim kuyruğu · kapsam s · bilet: 5 (sürmekte olanlar önce)',
    'Görev        Hedef            Durum                  Sonraki adım                    Bilet',
    'task-wait    refs/heads/main  Sırada                 Servisi bekle                   q-waitin',
    'task-adopt   refs/heads/main  Benimsendi             Kalıcı makbuzu incele           q-adopte',
    'task-verify  refs/heads/main  Doğrulama başarısız    Yeni deneme oluştur             q-failed',
    'task-park    refs/heads/main  Park edildi            Güncel tabanda yeniden hazırla  q-parked',
    `    Neden: ${ErrorRegistry.createError('QUEUE_VERIFICATION_NOT_ADMITTED', { locale: 'tr' }).message}`,
    'task-stale   refs/heads/main  Bayat aday reddedildi  Güncel tabanda yeniden hazırla  q-stale']]] as const) {
    it(`renders the five owner states as a ${language} table: in flight first, parked visible with its reason, no raw JSON`, async () => {
      const p = listing(language);
      await queueCommand(['task', 'integration-queue-list', '--scope', 's'], p.context);
      const text = p.output.join('');
      expect(text).toBe(expected.join('\n') + '\n');
      for (const raw of ['{', 'schemaVersion', 'labelKey', 'queue.git', 'queue.state.', 'nextAction']) expect(text).not.toContain(raw);
      expect(p.calls).toEqual(['list {"schemaVersion":1,"scopeId":"s","after":null,"limit":' + JSON.parse(p.calls[0]!.slice(5)).limit + '}']);
    });
  }
  it('J1: tickets show the L-KIT short id unique on the page; --verbose prints the full id; the --after cursor stays the full id', async () => {
    const uuid = (n: number) => `0f3c9a2e-${String(n).padStart(4, '0')}-4d1b-9c7e-5a6b7c8d9e0f`;
    const records = [ticket(uuid(1), 'task-one', 'queued', null, 'wait-service'), ticket(uuid(2), 'task-two', 'queued', null, 'wait-service')];
    const p = listing('en');
    (p.context as { deliveryQueue: { listTargetQueue: () => Promise<unknown> } }).deliveryQueue.listTargetQueue = async () => ({ schemaVersion: 1, records });
    await queueCommand(['task', 'integration-queue-list', '--scope', 's', '--limit', '2'], p.context);
    const short = p.output.join('');
    // The two ids share their first 13 characters: each shows the shortest prefix (from 8) that names only itself, never the full UUID.
    expect(short).toContain('0f3c9a2e-0001\n'); expect(short).toContain('0f3c9a2e-0002\n'); expect(short).not.toContain(`${uuid(1)}\n`);
    expect(short.trimEnd().split('\n').at(-1)).toBe(`More tickets exist: rerun with --after ${uuid(2)}.`);
    p.output.length = 0;
    await queueCommand(['task', 'integration-queue-list', '--scope', 's', '--verbose'], p.context);
    expect(p.output.join('')).toContain(`${uuid(1)}\n`); expect(p.output.join('')).toContain(`${uuid(2)}\n`);
    // --verbose is a list-only, single flag: repeated or on another action it is a usage error, as before.
    await expect(queueCommand(['task', 'integration-queue-list', '--scope', 's', '--verbose', '--verbose'], p.context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
    await expect(queueCommand(['task', 'integration-queue-inspect', '--scope', 's', '--command-id', 'c', '--verbose'], p.context)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  });
  it('inside each group the service page order stays (protocol v29 has no submission time, Astra 2661 R2); JSON keeps the page order', async () => {
    const records = [ticket('q-b', 'task-b', 'queued', null, 'wait-service'), ticket('q-done', 'task-done', 'settled', 'adopted', 'inspect-receipt'),
      ticket('q-a', 'task-a', 'queued', null, 'wait-service'), ticket('q-old', 'task-old', 'settled', 'adopted', 'inspect-receipt')];
    const rows = renderQueueList({ records }, 's', 10, 'en').split('\n').slice(2).map(line => line.split(/\s+/)[0]);
    expect(rows).toEqual(['task-b', 'task-a', 'task-done', 'task-old']);
    expect(records.map(view => view.commandId)).toEqual(['q-b', 'q-done', 'q-a', 'q-old']);
  });
  it('--json prints the client page byte-identical (one JSON line), and the page itself is never reordered', async () => {
    const p = listing('tr'), before = JSON.stringify(page);
    await queueCommand(['task', 'integration-queue-list', '--scope', 's', '--json'], p.context);
    expect(p.output.join('')).toBe(before + '\n');
    await queueCommand(['task', 'integration-queue-list', '--scope', 's'], p.context);
    expect(JSON.stringify(page)).toBe(before);
  });
  it('an empty page says so in words; a full page names the --after cursor (the last ticket of the service page)', async () => {
    const empty = project('en');
    (empty.context as { deliveryQueue: { listTargetQueue: () => Promise<unknown> } }).deliveryQueue.listTargetQueue = async () => ({ schemaVersion: 1, records: [] });
    await queueCommand(['task', 'integration-queue-list', '--scope', 's'], empty.context);
    expect(empty.output.join('')).toBe('No delivery queue tickets in scope s.\n');
    const full = listing('en');
    await queueCommand(['task', 'integration-queue-list', '--scope', 's', '--limit', '5'], full.context);
    expect(full.output.join('').trimEnd().split('\n').at(-1)).toBe('More tickets exist: rerun with --after q-waiting.');
  });
  it('control characters in a ticket field cannot reach the terminal', () => {
    const hostile = { ...page.records[0]!, identity: { ...page.records[0]!.identity, taskId: 'task\u001b[2Jx' }, target: { kind: 'git-ref', id: 'refs/heads/\u009b31mred' } };
    const text = renderQueueList({ records: [hostile] }, 's', 10, 'en');
    expect([...text].filter(char => char === '\u001b' || char === '\u009b')).toEqual([]);
  });
});

/** alpha.53 A3 (TESLIM-KARTI-OZET): every human queue view carries the ticket's summary; the shadow is list/inspect only; --json is untouched. */
describe('delivery queue CLI card summaries (alpha.53 A3)', () => {
  const shadow = { verdict: 'would-hold', reasons: ['target-unknown'] } as const;
  function summarized(language?: string, fail = false) {
    const p = project(language), requests: unknown[] = [], shadows: string[] = [];
    (p.context as { deliveryQueue: { listTargetQueue: () => Promise<unknown> } }).deliveryQueue.listTargetQueue = async () => ({ schemaVersion: 1, records: [sampleView('q1')] });
    Object.assign(p.context as object, {
      describeDeliverySummaries: async (_root: string, input: readonly unknown[]) => { requests.push(...input); if (fail) throw new Error('ledger-gone'); return input.map(() => deliverySummaryFixture()); },
      readAutonomyShadow: async (_root: string, scopeId: string, commandId: string) => { shadows.push(`${scopeId}/${commandId}`); return shadow; } });
    return { ...p, requests, shadows };
  }
  it('inspect shows the summary under the ticket title and the rule-off line; the request names the ticket, its verification Run and the git verdict', async () => {
    const p = summarized();
    await queueCommand(['task', 'integration-queue-inspect', '--scope', 's', '--command-id', 'q1'], p.context);
    const lines = p.output.join('').split('\n');
    expect(lines[0]).toBe('Delivery ticket q1 · task task-1 · delivery');
    expect(lines.slice(1, 4)).toEqual(['Work: Login banner fix', 'Move refs/heads/integration to this result', "Worker's own report (a claim, not checked): Banner fixed."]);
    expect(lines).toContain('Rule off · would have held: target unknown');
    expect(lines.indexOf('Rule off · would have held: target unknown')).toBeLessThan(lines.findIndex(line => line.startsWith('Target — ')));
    expect(p.requests).toEqual([{ schemaVersion: 1, identity: sampleView('q1').identity, operation: 'adopt', target: { id: 'refs/heads/main', protected: null },
      verificationRunId: queueTicketCommandIds('s', 'q1').verificationRun, topPaths: DELIVERY_RENDER_LIMITS.cardTopPaths }]);
    expect(p.shadows).toEqual(['s/q1']);
  });
  it('enqueue and rollback results show the summary but never the shadow line', async () => {
    const p = summarized('tr');
    await queueCommand(['task', 'integration-queue-rollback', '--scope', 's', '--source-command-id', 'q0', '--command-id', 'q1'], p.context);
    const text = p.output.join('');
    expect(text).toContain('İş: Login banner fix'); expect(text).not.toContain('Kural kapalı'); expect(p.shadows).toEqual([]);
  });
  it('the list gains a title, a one-word risk and the rule-off column; --json is the client page and reads no summary', async () => {
    const p = summarized();
    await queueCommand(['task', 'integration-queue-list', '--scope', 's'], p.context);
    const [, header, row] = p.output.join('').split('\n');
    expect(header!.split(/\s{2,}/u)).toEqual(['Task', 'Title', 'Target', 'State', 'Next step', 'Risk', 'Rule (off)', 'Ticket']);
    expect(row!.split(/\s{2,}/u)).toEqual(['task-1', 'Login banner fix', 'refs/heads/main', 'Awaiting human confirmation', 'Confirm exact batch', 'small', 'would hold', 'q1']);
    const json = summarized();
    await queueCommand(['task', 'integration-queue-list', '--scope', 's', '--json'], json.context);
    expect(JSON.parse(json.output.join(''))).toEqual({ schemaVersion: 1, records: [sampleView('q1')] }); expect(json.requests).toEqual([]); expect(json.shadows).toEqual([]);
  });
  it('a failed summary read never fails the command: the ticket says the summary is not available', async () => {
    const p = summarized('en', true);
    await queueCommand(['task', 'integration-queue-inspect', '--scope', 's', '--command-id', 'q1'], p.context);
    expect(p.output.join('')).toContain('Summary: not available (no permission or no record)');
    expect(p.output.join('')).toContain('Next step: Confirm exact batch');
  });
  it('confirm puts each asked ticket\'s summary ABOVE the exact card and no shadow line on it (law-audit fold 3)', async () => {
    const p = summarized(); let written = '';
    const input = Object.assign(new PassThrough(), { isTTY: true }), consent = { schemaVersion: 1, digest: 'd'.repeat(64), operation: 'publish', expiresAt: Date.now() + 60_000,
      target: { kind: 'git-ref', id: 'refs/heads/integration' }, display: sampleView('q1').display,
      items: [{ commandId: 'q1', from: 'a'.repeat(40), to: 'b'.repeat(40), candidateDigest: 'c'.repeat(64), verificationReceipt: 'e'.repeat(64), changes: ['note.txt'] }] };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { written += String(chunk); return true; });
    try {
      Object.assign(p.context as object, { stdin: input, confirmDeliveryQueue: async (_query: unknown, ask: (view: unknown) => Promise<boolean>) => {
        setTimeout(() => input.write('n\r'), 20); expect(await ask(consent)).toBe(false); return { settledPrefix: 0, items: [] }; } });
      await queueCommand(['task', 'integration-queue-confirm', '--scope', 's', '--command-id', 'q1'], p.context);
    } finally { stderr.mockRestore(); }
    const above = written.indexOf('Summary (your yes approves the exact card below, nothing else):'), card = written.indexOf(renderQueueConsent(consent as never, 'en').split('\n')[0]!);
    expect(above).toBeGreaterThanOrEqual(0); expect(card).toBeGreaterThan(above);
    expect(written).toContain('Work: Login banner fix'); expect(written).toContain(renderQueueConsent(consent as never, 'en').split('\n').slice(0, 4).join('\n'));
    expect(written).not.toMatch(/Rule off|would have/u); expect(p.shadows).toEqual([]);
    expect(p.requests).toMatchObject([{ operation: 'deliver', topPaths: 0 }]);
  });
});
