import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The probe prints one JSON line with exactly these fields and never fails: a missing capability is data, not an error.
test('shell capability probe reports user namespace and Landlock ABI as one JSON line', () => {
  const out = execFileSync(resolve(import.meta.dirname, '../build/Release/shell-capabilities'), { encoding: 'utf8' });
  assert.equal(out.trim().split('\n').length, 1);
  const probe = JSON.parse(out);
  assert.deepEqual(Object.keys(probe).sort(), ['landlockAbi', 'landlockErrno', 'userNamespace']);
  assert.equal(typeof probe.userNamespace, 'boolean');
  assert.ok(Number.isInteger(probe.landlockAbi) && Number.isInteger(probe.landlockErrno));
  assert.ok(probe.landlockAbi > 0 ? probe.landlockErrno === 0 : probe.landlockErrno > 0);
});
