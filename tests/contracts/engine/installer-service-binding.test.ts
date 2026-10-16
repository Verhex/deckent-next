import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FilePolicySource } from '#adapters/index.js';
import { firstRunPolicyTemplate, type AuditEvent } from '#domain/index.js';
import { upgradeInstalledPolicyTemplate, type FirstRunServiceIdentityPort } from '#engine/index.js';

// POLICY-V12 (Astra 2596, 2598): the installer upgrade binds the runtime service identity it chose to the policy it publishes. The identity is
// re-read after it is settled, inside the configuration layers' write lock (`hold`), and the policy is published inside that same lock: an
// identity that changed at any point before publication is a typed conflict, and nothing is published outside the lock.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const person = { issuer: 'host', subject: 'owner' };
const toolNames = { readToolNames: ['read_file'], scratchToolNames: ['scratch_write'], scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['run_shell'],
  writeOperationId: 'workspace.file.write', shellOperationId: 'host.shell.run', proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' };
const V12 = ['first-run-scope-inspect', 'first-run-service-shutdown'];
const identity = (serviceId: string) => ({ scopeId: 's', serviceId });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-installer-service-')); roots.push(root);
  const template = firstRunPolicyTemplate({ scopeId: 's', principal: person, ...toolNames });
  const policyPath = join(root, 'policy.json'), bindingsPath = join(root, 'bindings.json');
  await writeFile(policyPath, JSON.stringify({ ...template.policy, revision: 'first-run-template-v11', grants: template.policy.grants.filter(rule => !V12.includes(rule.id)) }), { mode: 0o600 });
  await writeFile(bindingsPath, JSON.stringify(template.bindings), { mode: 0o600 });
  const source = new FilePolicySource({ path: policyPath, bindingsPath, archivePath: join(root, 'archive'), ownerUid: process.getuid!(), maxBytes: 65_536 });
  const events: AuditEvent[] = [], writes: unknown[] = [], published: boolean[] = [];
  let held = false;
  // Every authority write records whether it ran inside `hold` (the configuration layers' lock).
  const writer: Pick<FilePolicySource, 'updateAuthority'> = { updateAuthority: (work, key) => source.updateAuthority(snapshot => {
    const planned = work(snapshot); if (planned.write) published.push(held); return planned; }, key) };
  const port = (reads: () => ReturnType<FirstRunServiceIdentityPort['read']>): FirstRunServiceIdentityPort => ({ read: reads,
    write: async value => { writes.push(value); }, hold: async work => { held = true; try { return await work(); } finally { held = false; } } });
  const run = (ports: FirstRunServiceIdentityPort, apply: boolean, expect?: string) => upgradeInstalledPolicyTemplate(writer, ports, { scopeId: 's', principal: person, toolNames, owner: true,
    apply, peopleLimit: 10, now: () => 1000, ...(expect === undefined ? {} : { expect }), openAudit: async () => ({ record: event => { events.push(event); }, close() {} }) });
  return { run, port, events, writes, published, bytes: () => readFile(policyPath, 'utf8') };
}
const sequence = (...values: (string | null)[]) => { const queue = [...values];
  return async () => ({ identity: (() => { const next = queue.length > 1 ? queue.shift()! : queue[0]!; return next === null ? null : identity(next); })(), digest: null }); };

it.skipIf(process.platform !== 'linux')('settle → locked read: an identity changed after it was settled is a conflict inside the lock, nothing published', async () => {
  const f = await fixture(), before = await f.bytes();
  // plan read: a; settle re-read: a (kept); the read inside the lock: b.
  expect(await f.run(f.port(sequence('a', 'a', 'b')), true)).toMatchObject({ status: 'conflict', reason: 'service-identity-changed', rules: [], serviceIdentity: { status: 'kept' } });
  expect(await f.bytes()).toBe(before); expect(f.events).toEqual([]); expect(f.published).toEqual([]);
  // A missing identity written by settle must still be the one configured inside the lock.
  expect(await f.run(f.port(sequence(null, null, 'other')), true)).toMatchObject({ status: 'conflict', reason: 'service-identity-changed', serviceIdentity: { status: 'written' } });
  expect(f.writes).toEqual([identity('s-runtime')]); expect(await f.bytes()).toBe(before);
});

it.skipIf(process.platform !== 'linux')('plan → settle: an identity that changes before it is settled is a conflict before any identity or policy write', async () => {
  const f = await fixture(), before = await f.bytes();
  expect(await f.run(f.port(sequence('a', 'b')), true)).toMatchObject({ status: 'conflict', reason: 'service-identity-changed', serviceIdentity: { status: 'changed', identity: identity('b') } });
  expect(await f.bytes()).toBe(before); expect(f.writes).toEqual([]); expect(f.events).toEqual([]);
});

it.skipIf(process.platform !== 'linux')('locked read → publish: the policy is published only inside the configuration lock, naming the identity read there', async () => {
  const f = await fixture();
  const preview = await f.run(f.port(sequence('a')), false);
  expect(preview).toMatchObject({ status: 'preview', serviceIdentity: { status: 'kept' } });
  expect(await f.run(f.port(sequence('a')), true, preview.expect!)).toMatchObject({ status: 'upgraded' });
  expect(f.published).toEqual([true]);
  expect((JSON.parse(await f.bytes()) as { grants: { id: string; resource: unknown }[] }).grants.find(rule => rule.id === V12[1])?.resource).toEqual({ kind: 'service', ids: ['a'] });
  expect(f.events).toHaveLength(1);
});

it.skipIf(process.platform !== 'linux')('the apply token binds the identity: another identity\'s token or a bare revision writes nothing', async () => {
  const f = await fixture(), before = await f.bytes();
  const token = (await f.run(f.port(sequence('a')), false)).expect!;
  expect(token).toMatch(/^first-run-template-v11~[a-f0-9]{12}$/u);
  expect(await f.run(f.port(sequence('b')), true, token)).toMatchObject({ status: 'conflict', reason: 'service-identity-changed' });
  expect(await f.run(f.port(sequence('a')), true, 'first-run-template-v11')).toMatchObject({ status: 'conflict', reason: 'service-identity-unbound' });
  expect(await f.bytes()).toBe(before); expect(f.events).toEqual([]); expect(f.published).toEqual([]);
});
