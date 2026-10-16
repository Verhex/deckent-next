import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FilePolicySource } from '#adapters/index.js';
import { firstRunPolicyTemplate, type AuditEvent } from '#domain/index.js';
import { upgradeInstalledPolicyTemplate, type FirstRunServiceIdentityPort } from '#engine/index.js';

// POLICY-V12 (Astra 2596): the installer upgrade binds the runtime service identity it chose to the policy it publishes. An identity that changes
// after the plan (re-read before any write) or a configuration that changes while the policy is being published (checked under the authority
// writer's lock) is a typed conflict: the policy, the identity and the audit stay untouched.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const person = { issuer: 'host', subject: 'owner' };
const toolNames = { readToolNames: ['read_file'], scratchToolNames: ['scratch_write'], scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['run_shell'],
  writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run', proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' };
const V12 = ['first-run-scope-inspect', 'first-run-service-shutdown'];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-installer-service-')); roots.push(root);
  const template = firstRunPolicyTemplate({ scopeId: 's', principal: person, ...toolNames });
  const policyPath = join(root, 'policy.json'), bindingsPath = join(root, 'bindings.json');
  await writeFile(policyPath, JSON.stringify({ ...template.policy, revision: 'first-run-template-v11', grants: template.policy.grants.filter(rule => !V12.includes(rule.id)) }), { mode: 0o600 });
  await writeFile(bindingsPath, JSON.stringify(template.bindings), { mode: 0o600 });
  const writer = new FilePolicySource({ path: policyPath, bindingsPath, archivePath: join(root, 'archive'), ownerUid: process.getuid!(), maxBytes: 65_536 });
  const events: AuditEvent[] = [], writes: unknown[] = [];
  const run = (port: FirstRunServiceIdentityPort, apply: boolean, expect?: string) => upgradeInstalledPolicyTemplate(writer, port, { scopeId: 's', principal: person, toolNames, owner: true,
    apply, peopleLimit: 10, now: () => 1000, ...(expect === undefined ? {} : { expect }), openAudit: async () => ({ record: event => { events.push(event); }, close() {} }) });
  return { run, events, writes, bytes: () => readFile(policyPath, 'utf8') };
}
const identity = (serviceId: string) => ({ scopeId: 's', serviceId });

it.skipIf(process.platform !== 'linux')('an identity that changes after the plan was chosen is a conflict before any identity or policy write', async () => {
  const f = await fixture(), before = await f.bytes();
  const reads = [identity('a'), identity('b')];
  const port: FirstRunServiceIdentityPort = { read: async () => ({ identity: reads.shift() ?? identity('b'), digest: null }), write: async value => { f.writes.push(value); }, fingerprint: () => 'same' };
  expect(await f.run(port, true)).toMatchObject({ status: 'conflict', reason: 'service-identity-changed', rules: [], serviceIdentity: { status: 'changed', identity: identity('b') } });
  expect(await f.bytes()).toBe(before); expect(f.events).toEqual([]); expect(f.writes).toEqual([]);
});

it.skipIf(process.platform !== 'linux')('a configuration change while the policy is published (under the writer\'s lock) publishes nothing', async () => {
  const f = await fixture(), before = await f.bytes();
  let generation = 0;
  const port: FirstRunServiceIdentityPort = { read: async () => ({ identity: identity('a'), digest: null }), write: async () => undefined, fingerprint: () => `g${generation++}` };
  expect(await f.run(port, true)).toMatchObject({ status: 'conflict', reason: 'service-identity-changed', rules: [] });
  expect(await f.bytes()).toBe(before); expect(f.events).toEqual([]);
  // Unchanged configuration: the same upgrade publishes the stop rule for exactly the identity read, once audited.
  const stable: FirstRunServiceIdentityPort = { ...port, fingerprint: () => 'stable' };
  const preview = await f.run(stable, false);
  expect(preview).toMatchObject({ status: 'preview', serviceIdentity: { status: 'kept' } });
  expect(await f.run(stable, true, preview.expect!)).toMatchObject({ status: 'upgraded' });
  expect((JSON.parse(await f.bytes()) as { grants: { id: string; resource: unknown }[] }).grants.find(rule => rule.id === V12[1])?.resource).toEqual({ kind: 'service', ids: ['a'] });
  expect(f.events).toHaveLength(1);
});

it.skipIf(process.platform !== 'linux')('the apply token binds the identity: another identity\'s token or a bare revision writes nothing', async () => {
  const f = await fixture(), before = await f.bytes();
  const at = (serviceId: string): FirstRunServiceIdentityPort => ({ read: async () => ({ identity: identity(serviceId), digest: null }), write: async () => undefined, fingerprint: () => 'x' });
  const token = (await f.run(at('a'), false)).expect!;
  expect(token).toMatch(/^first-run-template-v11~[a-f0-9]{12}$/u);
  expect(await f.run(at('b'), true, token)).toMatchObject({ status: 'conflict', reason: 'service-identity-changed' });
  expect(await f.run(at('a'), true, 'first-run-template-v11')).toMatchObject({ status: 'conflict', reason: 'service-identity-unbound' });
  expect(await f.bytes()).toBe(before); expect(f.events).toEqual([]);
});
