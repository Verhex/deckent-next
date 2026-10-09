import { expect, it } from 'vitest';
import { RuntimeServiceLifecycle } from '#engine/core/runtime/index.js';
import { readLocalOsIdentity, withLocalPrincipalChannel } from '#adapters/index.js';
import { evaluatePolicy } from '#domain/index.js';

// P0 (batch C, 2026-10-09): the runtime service enters the request's local-principal channel (MCP or owner) before bounded admission.
// A request that waits in the admission queue is started by `pump()` from another request's completion; its actor must be the one it was
// admitted with, never the finishing request's. Real channel context and real local identity; only the wait deadline is a fake that never fires.
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(value => { resolve = value; }); return { promise, resolve }; }
const neverExpires = { wait: () => new Promise<void>(() => undefined) };
const owner = readLocalOsIdentity();
/** Only the owner holds the grant: an MCP actor must be refused, the owner allowed. */
const policy = { schemaVersion: 1, revision: 'owner-only', restrictions: [],
  grants: [{ id: 'owner-run', effect: 'allow', actions: ['create'], scopes: ['scope'], principals: [{ issuer: owner.issuer, subject: owner.subject }],
    resource: { kind: 'run', ids: 'all' } }] };
const decide = () => {
  const actor = readLocalOsIdentity();
  return { issuer: actor.issuer, decision: evaluatePolicy(policy, { principal: { ...actor, scopeIds: ['scope'] }, scopeId: 'scope', action: 'create',
    resource: { kind: 'run', id: 'run-1' } }).decision };
};

async function queuedBehind(running: 'mcp' | undefined, queued: 'mcp' | undefined) {
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1, admissionWaitMs: 60_000 }, () => {}, neverExpires);
  const first = deferred<void>(), second = deferred<void>();
  const holders = [first, second].map(gate => withLocalPrincipalChannel(running, () => lifecycle.admitBounded(() => gate.promise)));
  // Both request slots are taken: this request waits in the bounded admission queue.
  const waiting = withLocalPrincipalChannel(queued, () => lifecycle.admitBounded(decide));
  let started = false; void waiting.then(() => { started = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(started).toBe(false);
  first.resolve(); // the running request finishes; its completion hands the slot to the waiter
  const result = await waiting; second.resolve(); await Promise.all(holders);
  return result;
}

it('a queued MCP request runs as the MCP actor (refused without a named grant) after an owner request frees the slot', async () => {
  expect(await queuedBehind(undefined, 'mcp')).toEqual({ issuer: `${owner.issuer}/mcp`, decision: 'deny' });
});

it('a queued owner request runs as the owner (allowed) after an MCP request frees the slot', async () => {
  expect(await queuedBehind('mcp', undefined)).toEqual({ issuer: owner.issuer, decision: 'allow' });
});
