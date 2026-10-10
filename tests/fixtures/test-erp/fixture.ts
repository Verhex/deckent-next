import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { configuredApproval, executeConfiguredOperation, compensateConfiguredOperation, inspectConfiguredOperation } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import type { EffectCommand, EffectRecord } from '#domain/index.js';
import config from './config.json' with { type: 'json' };
import { startTestErp } from './server.js';
import { startInteractivePeer } from './terminal-peer.js';

export { config };
export async function testErpFixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-test-erp-'));
  const cleanup: (() => Promise<void>)[] = [() => rm(root, { recursive: true, force: true })];
  try {
    const server = await startTestErp(); cleanup.push(server.close);
    const terminal = await startInteractivePeer(); cleanup.push(terminal.close);
    const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
    const options = { env: { HOME: join(root, 'home') } };
    const descriptor = (operation: typeof config.operations.read, effectClass: 'read' | 'write', approval: 'policy' | 'required', compensation: typeof operation | null) => ({
      schemaVersion: 1, operation, targetKind: config.targetKind, effectClass, approval, precondition: effectClass === 'read' ? 'none' : 'record-version',
      compensation, inputMaxBytes: config.http.inputMaxBytes });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, operations: {
      catalog: [descriptor(config.operations.read, 'read', 'policy', null), descriptor(config.operations.approve, 'write', 'required', config.operations.undo),
        descriptor(config.operations.undo, 'write', 'required', null)],
      targets: [{ adapter: 'http-conditional', options: { kind: config.targetKind, baseUrl: server.baseUrl, timeoutMs: config.http.timeoutMs,
        responseMaxBytes: config.http.responseMaxBytes, idempotencyLookup: true } }] } }));
    registerProviderConfig();
    const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
    // A v2 policy requires a trusted bindings document even when its grants name principals directly.
    await writeFile(productResourcePath(opened.layout, 'bindings'), JSON.stringify({ schemaVersion: 2, revision: config.policy.revision,
      modes: [], bindings: [] }), { mode: 0o600 });
    const policy = async (fourEyes = false) => {
      await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 2, revision: config.policy.revision,
        roles: [], restrictions: [], grants: [
          { id: 'operations', effect: 'allow', actions: ['execute', 'compensate', 'inspect'], scopes: [config.scopeId],
            principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'operation', ids: 'all' } },
          { id: 'approvals', effect: 'allow', actions: 'all', scopes: [config.scopeId],
            principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'approval', ids: 'all' } }],
        separationOfDuties: fourEyes ? [{ id: config.policy.fourEyesRuleId, rule: 'requester-cannot-approve', scopes: [config.scopeId] }] : [] }), { mode: 0o600 });
    };
    await policy();
    const command = (commandId: string, changes: Partial<EffectCommand> = {}): EffectCommand => ({ schemaVersion: 1, commandId, scopeId: config.scopeId,
      operation: config.operations.approve, target: { kind: config.targetKind, id: config.recordId }, idempotencyKey: `${config.keyPrefix}-${commandId}`,
      input: { status: config.approvedStatus }, expectedVersion: server.etag(server.current().version), ...changes });
    const tracked = new Set<string>();
    const execute = (input: EffectCommand) => { tracked.add(input.commandId); return executeConfiguredOperation(project, input, options); };
    const compensate = (input: EffectCommand) => { tracked.add(input.commandId); return compensateConfiguredOperation(project, input, options); };
    const inspect = (commandId: string) => inspectConfiguredOperation(project, { scopeId: config.scopeId, commandId }, options);
    const decide = (approvalId: string, commandId: string, decision: 'allow' | 'deny' = 'allow') => configuredApproval(project, 'decide',
      { schemaVersion: 1, scopeId: config.scopeId, approvalId, commandId, expectedRevision: 0, decision, reason: 'Test operation card reviewed' }, options, terminal.peer);
    const approve = async (input: EffectCommand, action: 'execute' | 'compensate' = 'execute') => {
      const pending = await (action === 'execute' ? execute(input) : compensate(input));
      if (pending.status !== 'approval-pending') throw new Error(`expected operation card, got ${pending.status}`);
      const decision = await decide(pending.approval.approvalId, `allow-${input.commandId}`);
      return { pending, decision };
    };
    const checkpoints: { label: string; record: EffectRecord | null }[] = [];
    const checkpoint = async (label: string, commandId: string) => { const { record } = await inspect(commandId); checkpoints.push({ label, record }); return record; };
    const close = async (name: string) => {
      try {
        const destination = process.env['DECKENT_TEST_ERP_PROOF'];
        if (destination) {
          const effects = await Promise.all([...tracked].map(async id => ({ id, ...await inspect(id) })));
          await appendFile(join(destination, 'scenario-evidence.jsonl'), JSON.stringify({ name, record: server.current(), requests: server.requests,
            writes: server.writes, idempotency: [...server.idempotency], effects, checkpoints }) + '\n');
        }
      } finally { for (const finish of cleanup.reverse()) await finish(); clearConfigCache(); }
    };
    return { server, project, options, policy, command, execute, compensate, inspect, decide, approve, checkpoint, close };
  } catch (error) { for (const finish of cleanup.reverse()) await finish(); clearConfigCache(); throw error; }
}
