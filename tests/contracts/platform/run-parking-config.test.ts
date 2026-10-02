import { expect, it } from 'vitest';
import { CORE_SCHEMA } from '#platform/index.js';

it('defaults Run and evaluation parking to a versioned, lead-adjustable conservative 24 hours', () => {
  expect(CORE_SCHEMA.shape.runRuntime.parse({}).parking).toEqual({ schemaVersion: 1, timeoutMs: 86_400_000 });
  expect(CORE_SCHEMA.shape.runRuntime.parse({ parking: { schemaVersion: 1, timeoutMs: 5000 } }).parking)
    .toEqual({ schemaVersion: 1, timeoutMs: 5000 });
});

it.each([
  { schemaVersion: 2, timeoutMs: 10 }, { schemaVersion: 1, timeoutMs: 0 },
  { schemaVersion: 1, timeoutMs: -1 }, { schemaVersion: 1, timeoutMs: 0.5 },
  { schemaVersion: 1, timeoutMs: Number.MAX_SAFE_INTEGER + 1 },
  { schemaVersion: 1, timeoutMs: 10, silentlyAccept: true },
])('refuses unsafe or unsupported Run parking configuration %j', parking => {
  expect(() => CORE_SCHEMA.shape.runRuntime.parse({ parking })).toThrow();
});
