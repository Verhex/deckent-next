import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { getPolicyVocabulary } from '../../../src/index.js';
import { evaluatePolicy } from '#domain/index.js';
const exec = promisify(execFile);
it('exposes the same versioned action/resource matrix through compiled CLI and SDK without requiring a project', async () => {
  const result = await exec(process.execPath, [resolve('dist/composition/core/cli/internal/entry.js'), 'policy', 'vocabulary', '--json'], { cwd: '/tmp' });
  expect(JSON.parse(result.stdout)).toEqual(getPolicyVocabulary());
  expect(getPolicyVocabulary().resources.map(r => r.kind)).toEqual(['attempt', 'scope', 'run']);
  expect(getPolicyVocabulary().resources.find(r => r.kind === 'attempt')!.actions).toContain('recover-output');
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
