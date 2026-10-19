import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { queueCommand, renderQueueList } from '#surfaces/core/delivery-queue/index.js';
import { clearConfigCache, ErrorRegistry } from '#platform/index.js';
import { targetQueueViewSchema } from '#engine/index.js';
import { homeEnv } from '../support/host-platform.js';

/** A project root with an optional `language` and a stand-in queue client recording each call. */
function project(language?: string) {
  const root = mkdtempSync(join(tmpdir(), 'deckent-queue-cli-')); mkdirSync(join(root, '.deckent'));
  writeFileSync(join(root, '.deckent', 'config.json'), JSON.stringify(language ? { language } : {})); clearConfigCache();
  const calls: string[] = [], output: string[] = [], locales: string[] = [];
  const record = (name: string) => async (input: unknown) => { calls.push(`${name} ${JSON.stringify(input)}`); return { schemaVersion: 1, record: null }; };
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
    expect(turkish.locales.at(-1)).toBe('tr'); expect(turkish.output.join('')).toContain('Kuyruk sonucu:');
    const explicit = project('tr');
    await queueCommand(['task', 'integration-queue-inspect', '--scope', 's', '--command-id', 'q1', '--lang', 'en'], explicit.context);
    expect(explicit.locales.at(-1)).toBe('en'); expect(explicit.output.join('')).toContain('Queue result:');
    const unset = project();
    await queueCommand(['task', 'integration-queue-inspect', '--scope', 's', '--command-id', 'q1'], unset.context);
    expect(unset.locales.at(-1)).toBe('en');
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
