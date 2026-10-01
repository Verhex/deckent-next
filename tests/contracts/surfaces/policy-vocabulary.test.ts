import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { getPolicyVocabulary } from '../../../src/index.js';
import { evaluatePolicy } from '#domain/index.js';
const exec = promisify(execFile);
it('exposes the same versioned action/resource matrix through compiled CLI and SDK without requiring a project', async () => {
  const result = await exec(process.execPath, [resolve('dist/composition/core/cli/internal/entry.js'), 'policy', 'vocabulary', '--json'], { cwd: tmpdir() });
  expect(JSON.parse(result.stdout)).toEqual(getPolicyVocabulary());
  expect(getPolicyVocabulary().resources.map(r => r.kind)).toEqual(['approval', 'task', 'attempt', 'operation', 'scope', 'pool', 'run', 'service', 'model-activation', 'model-invocation', 'provider-spend-account', 'agent-tool', 'permission-mode', 'agent-tool-call', 'secret', 'work-target']);
  expect(getPolicyVocabulary().resources.find(r => r.kind === 'attempt')!.actions).toContain('recover-output');
  expect(getPolicyVocabulary().resources.find(r => r.kind === 'service')!.actions).toEqual(['shutdown']);
  expect(getPolicyVocabulary().resources.find(r => r.kind === 'operation')!.actions).toEqual(['execute', 'compensate', 'inspect']);
  expect(getPolicyVocabulary().resources.find(r => r.kind === 'model-activation')!.actions).toEqual(['activate', 'deactivate', 'inspect']);
  expect(getPolicyVocabulary().resources.find(r => r.kind === 'provider-spend-account')!.actions).toEqual(['inspect', 'audit']);
  // Terminal agent tools (T-L3): the tool name is the resource id; every loop call is authorized with invoke.
  expect(getPolicyVocabulary().resources.find(r => r.kind === 'agent-tool')!.actions).toEqual(['invoke']);
  // T-L4 slice 4c: a person sets their own terminal permission mode; the resource id is the target mode.
  expect(getPolicyVocabulary().resources.find(r => r.kind === 'permission-mode')!.actions).toEqual(['set']);
  // PERSISTENT-APPROVALS G6: a person's standing approval of one call pattern; the resource id is the pattern key.
  expect(getPolicyVocabulary().resources.find(r => r.kind === 'agent-tool-call')!.actions).toEqual(['invoke']);
  // SECRET-WRITE (owner 2026-09-29 option A): a change of one stored secret; the resource id is the secret's name.
  expect(getPolicyVocabulary().resources.find(r => r.kind === 'secret')!.actions).toEqual(['set', 'delete']);
  // WORK-TARGETS (owner 2026-09-30 K2 = A): one configured work target; use at admission/reservation, adopt when its branch moves.
  expect(getPolicyVocabulary().resources.find(r => r.kind === 'work-target')!.actions).toEqual(['use', 'adopt']);
  // K5 typed pool hold (owner 2026-09-30 option A): hold/resume are installation-level, inspect reads the status.
  expect(getPolicyVocabulary().resources.find(r => r.kind === 'pool')!.actions).toEqual(['use', 'hold', 'resume', 'inspect']);
});
it('catalog metadata cannot be mutated and never grants authority', () => {
  const catalog = getPolicyVocabulary(); expect(Object.isFrozen(catalog.resources)).toBe(true);
  const principal = { id: 'u', issuer: 'host', subject: '1', assurance: 'os-user', scopeIds: ['s'] };
  for (const resource of catalog.resources) {
    expect(Object.isFrozen(resource)).toBe(true); expect(Object.isFrozen(resource.actions)).toBe(true);
    for (const action of resource.actions) expect(evaluatePolicy({ schemaVersion: 1, revision: 'p', grants: [], restrictions: [] },
      { principal, action, scopeId: 's', resource: { kind: resource.kind, id: 'r' } }).decision).toBe('deny');
  }
});
it('keeps custom policy vocabulary available without advertising unimplemented core operations', () => {
  const request = { principal: { id: 'u', issuer: 'host', subject: '1', assurance: 'os-user', scopeIds: ['s'] }, action: 'review-order', scopeId: 's', resource: { kind: 'purchase-order', id: '1' } };
  const policy = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [{ id: 'custom', effect: 'allow', actions: ['review-order'], scopes: ['s'], principals: 'all', resource: { kind: 'purchase-order', ids: ['1'] } }] };
  expect(evaluatePolicy(policy, request).decision).toBe('allow'); expect(JSON.stringify(getPolicyVocabulary())).not.toContain('purchase-order');
});
