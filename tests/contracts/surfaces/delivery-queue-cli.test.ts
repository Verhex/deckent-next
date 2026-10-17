import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { queueCommand } from '#surfaces/core/delivery-queue/index.js';
import { clearConfigCache } from '#platform/index.js';
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
