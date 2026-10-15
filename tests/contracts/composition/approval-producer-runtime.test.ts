import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerApprovalAssuranceProducer } from '../../../src/extensions.js';
import { CORE_TURN_ASSURANCE_REFERENCE } from '#platform/core/config-fields/index.js';
import { clearConfigCache } from '#platform/index.js';
import { closeModeRuntimes, modeRuntime, principal, rule } from '../support/agent-turn-modes.js';
import { terminalRequest } from '../support/approval-terminal.js';
import type { AgentTurnStreamEvent } from '#domain/index.js';

// Host-only wiring fixture: this trusted fake Enterprise attester tests composition, not IdP or proof of a human.
const manifest = { schemaVersion: 1 as const, id: 'enterprise.fixture', version: 1, level: 'enterprise-fixture-step-up', rank: 2 };
registerApprovalAssuranceProducer({ manifest, create: () => ({ attests: evidence => evidence.scopeId === 'scope'
  && evidence.decider.issuer === principal.issuer && evidence.decider.subject === principal.subject && evidence.peerPid !== null }) });
afterEach(closeModeRuntimes);

it.skipIf(process.platform !== 'linux')('[requires host real PTY, socket and processes] approve-card-then-assert: config-selected extension attests the risky input through the real service; disabling it refuses the same allow', async () => {
  const f = await modeRuntime({ grants: [rule('edit-tool', 'agent-tool', ['write_file'], 'allow'), rule('file-write', 'operation', ['workspace.file.write'], 'allow')], mode: null });
  const configPath = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
  const policyPath = join(f.data, 'policy.json'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
  policy.approvalAssurance = [{ id: 'enterprise-required', scopes: ['scope'], subject: 'agent-tool-call', cells: ['edit-floor'], minimum: manifest.level }];
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  for (const enabled of [true, false]) {
    config.approvals = { assuranceProducers: enabled ? [CORE_TURN_ASSURANCE_REFERENCE, { id: manifest.id, version: manifest.version }] : [] };
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); clearConfigCache();
    f.script('write_file', { path: 'package.json', content: enabled ? '{"approved":true}\n' : '{"forbidden":true}\n' });
    const pending: Promise<void>[] = [];
    await f.client.chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: enabled ? 'enabled' : 'disabled', messages: [{ role: 'user', content: 'go' }] }, (event: AgentTurnStreamEvent) => {
      if (event.kind !== 'approval.requested') return;
      pending.push((async () => {
        const command = { schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, expectedRevision: event.revision,
          commandId: enabled ? 'allow-enabled' : 'allow-disabled', decision: 'allow', reason: 'Reviewed package.json' };
        const result = await terminalRequest(f, 'decideApproval', command);
        if (enabled) expect(result.response).toMatchObject({ ok: true, result: { status: 'decided', decision: { assurance: manifest.level, decision: 'allow' } } });
        else {
          expect(result.response).toMatchObject({ ok: false, error: { code: 'APPROVAL_ASSURANCE_INSUFFICIENT' } });
          expect(await f.client.inspectApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId })).toMatchObject({ status: 'pending' });
          const denied = await terminalRequest(f, 'decideApproval', { ...command, commandId: 'withdraw-disabled', decision: 'deny' });
          expect(denied.response).toMatchObject({ ok: true, result: { decision: { decision: 'deny' } } });
        }
      })());
    });
    await Promise.all(pending); expect(pending).toHaveLength(1);
    expect(await readFile(join(f.project, 'package.json'), 'utf8')).toBe('{"approved":true}\n');
    expect(f.audit(true).filter(record => record.event.subject.kind === 'approval-assurance-registration').at(-1)?.event.subject).toMatchObject({ schemaVersion: 1,
      producers: expect.arrayContaining([expect.objectContaining({ ...manifest, active: enabled })]) });
  }
}, 60_000);
