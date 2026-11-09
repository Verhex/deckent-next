import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilePolicySource } from '#adapters/index.js';
import { evaluatePolicy, policySchema } from '#domain/index.js';

// Monitor 2026-10-17: one snapshot evaluated the same loaded policy document for hundreds of attempts and re-validated it every time.
const owner = { issuer: 'host', subject: '1000' };
const principal = { id: '1000@host', ...owner, assurance: 'os-user' as const, scopeIds: ['proj'] };
const request = (id: string) => ({ principal, scopeId: 'proj', action: 'read-output', resource: { kind: 'attempt', id } });
const raw = () => ({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: [{ id: 'read', effect: 'allow', scopes: ['proj'], actions: ['read-output'],
  resource: { kind: 'attempt', ids: 'all' }, principals: [owner] }] });
afterEach(() => { vi.restoreAllMocks(); });
// KG5 F1: the file source keeps one parsed snapshot per content digest, so every load of unchanged bytes is that object (one parse for all of
// them); a changed byte, even one that keeps the revision, is a new object decided as written. Every load still reads and checks the file.
describe.skipIf(process.platform === 'win32')('the file source snapshot', () => {
it('a policy file replaced with identical bytes loads as the same object, validated once; a changed grant is a new decision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-policy-snapshot-')), path = join(root, 'policy.json');
  const replace = async (document: unknown) => { await writeFile(`${path}.next`, JSON.stringify(document), { mode: 0o600 }); await rename(`${path}.next`, path); };
  const load = () => new FilePolicySource({ path, ownerUid: process.getuid!(), maxBytes: 4096 }).load();
  try {
    await replace(raw()); const first = await load(), spy = vi.spyOn(policySchema, 'safeParse'), loaded = [first];
    for (let index = 0; index < 4; index++) { await replace(raw()); loaded.push(await load()); }
    for (const document of loaded) expect(document).toBe(first);
    const decisions = loaded.flatMap(document => Array.from({ length: 10 }, (_, index) => evaluatePolicy(document, request(`a${index}`))));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(new Set(decisions.map(value => JSON.stringify(value)))).toEqual(new Set([JSON.stringify({ decision: 'allow', revision: 'p1', reason: 'GRANTED', ruleId: 'read' })]));
    const changed = raw(); changed.grants[0]!.effect = 'deny'; await replace(changed);
    const next = await load();
    expect(next).not.toBe(first);
    expect(evaluatePolicy(next, request('a'))).toMatchObject({ decision: 'deny', revision: 'p1', reason: 'DENIED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
});
it('re-validates a mutable document on every call, so a later change is decided as written', () => {
  const document = raw(), spy = vi.spyOn(policySchema, 'safeParse');
  expect(evaluatePolicy(document, request('a'))).toMatchObject({ decision: 'allow' });
  document.grants[0]!.effect = 'deny';
  expect(evaluatePolicy(document, request('a'))).toMatchObject({ decision: 'deny', reason: 'DENIED' });
  document.grants[0]!.effect = 'unknown-effect';
  expect(() => evaluatePolicy(document, request('a'))).toThrow();
  expect(spy).toHaveBeenCalledTimes(3);
});
