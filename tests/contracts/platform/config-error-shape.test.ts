import { describe, expect, it } from 'vitest';
import { ConfigValidationError, validateConfig, type ConfigIssue } from '#platform/core/config/index.js';
import { registerProviderConfig } from '../../../src/adapters/index.js';

registerProviderConfig();

/**
 * ZOD4-PREP step 1 (owner 2026-09-29, zod4-migration-plan.md §1.2): the exact `ConfigValidationError.issues` users and surfaces see
 * today (zod 3.25.76). `reason` is the zod issue `code` verbatim (validate/sections.ts) and is rendered into the localized message
 * (`config.valueInvalid`: "{path}: invalid value ({reason})"), so a renamed code or a changed issue count is a user-visible change.
 * Arrays are compared exactly (codes, paths, order and count). Guards, per https://zod.dev/v4/changelog (read 2026-09-29):
 * - ZodInvalidEnumValueIssue and ZodInvalidLiteralIssue "merged into z.core.$ZodIssueInvalidValue" (v4 code `invalid_value`);
 * - ZodInvalidStringIssue → $ZodIssueInvalidStringFormat (v4 code `invalid_format`) for regex and url;
 * - ZodNotFiniteIssue removed ("infinite values no longer accepted"); `.int()` "accepts safe integers only" — issue counts change
 *   (observed 3.25.76 vs 4.6.5: Infinity 2 → 1 issues, 2**53 against `.int().max()` 1 → 2 issues; proof logs/probe-v*.json);
 * - `.refine()`/`.superRefine()` "ctx.path removed" — custom issue paths must stay as authored;
 * - unrecognized_keys (`.strict()`, deprecated in v4 for z.strictObject) keeps the object path, not the key path.
 * The migration decides (plan §5) between a v3-code mapping in validate/sections.ts or an accepted reason change; either way this
 * table changes only in a reviewed commit.
 */
function issues(input: unknown): readonly ConfigIssue[] {
  try { validateConfig(input); } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    return (error as ConfigValidationError).issues;
  }
  throw new Error('expected CONFIG_VALIDATION');
}
const one = (path: string, reason: string) => [{ path, reason }];
const cases: readonly (readonly [string, unknown, readonly ConfigIssue[]])[] = [
  ['non-object root', null, one('$', 'OBJECT_REQUIRED')],
  ['unknown top-level key', { nope: 1 }, one('nope', 'unrecognized_keys')],
  ['unknown nested key (object path)', { layout: { extra: 1 } }, one('layout', 'unrecognized_keys')],
  ['wrong type', { mcp: { maxConcurrentCalls: 'x' } }, one('mcp.maxConcurrentCalls', 'invalid_type')],
  ['null for an object', { layout: null }, one('layout', 'invalid_type')],
  ['missing required nested field', { cancellation: {} }, one('cancellation.maxConcurrentDeliveries', 'invalid_type')],
  ['float for int', { mcp: { maxConcurrentCalls: 1.5 } }, one('mcp.maxConcurrentCalls', 'invalid_type')],
  ['Infinity for a safe positive int', { mcp: { maxConcurrentCalls: Infinity } }, [{ path: 'mcp.maxConcurrentCalls', reason: 'invalid_type' }, { path: 'mcp.maxConcurrentCalls', reason: 'too_big' }]],
  ['unsafe integer above max', { runRuntime: { pollIntervalMs: 2 ** 53 } }, one('runRuntime.pollIntervalMs', 'too_big')],
  ['bad enum', { mode: 'turbo' }, one('mode', 'invalid_enum_value')],
  ['bad literal', { storage: { driver: 'postgres' } }, one('storage.driver', 'invalid_literal')],
  ['bad schema_version literal', { schema_version: 99 }, one('schema_version', 'invalid_literal')],
  ['regex mismatch', { approvals: { keyFile: '../key' } }, one('approvals.keyFile', 'invalid_string')],
  ['invalid url', { toolchains: { currency: { registryEndpoint: 'not a url' } } }, one('toolchains.currency.registryEndpoint', 'invalid_string')],
  ['union mismatch', { max_workers: 'x' }, one('max_workers', 'invalid_union')],
  ['too big', { inspection: { workers: { heartbeatMs: 60_001 } } }, one('inspection.workers.heartbeatMs', 'too_big')],
  ['too small number', { inspection: { workers: { heartbeatMs: 99 } } }, one('inspection.workers.heartbeatMs', 'too_small')],
  ['too small array', { cancellationRuntime: { scopeIds: [] } }, one('cancellationRuntime.scopeIds', 'too_small')],
  ['record value too small', { layout: { resources: { data: '' } } }, one('layout.resources.data', 'too_small')],
  ['superRefine custom with authored path', { service: { maxConcurrentExecutions: 16 } }, one('service.maxConcurrentExecutions', 'custom')],
  ['refine custom on an element', { inspection: { workers: { sources: [{ id: 'current', kind: 'next-project', path: 'p', scopeId: 's' }] } } },
    one('inspection.workers.sources.0.id', 'custom')],
  ['object refine custom (no path)', { inspection: { workers: { sources: [
    { id: 'a', kind: 'next-project', path: 'p', scopeId: 's' }, { id: 'a', kind: 'legacy-tasks', path: 'q', scopeId: 's' }] } } }, one('inspection.workers', 'custom')],
  ['several fields, schema order', { mode: 'x', language: 'de' }, [{ path: 'language', reason: 'invalid_enum_value' }, { path: 'mode', reason: 'invalid_enum_value' }]],
  ['section: unknown key', { terminal: { nope: 1 } }, one('terminal', 'unrecognized_keys')],
  ['section: bad enum in optional sub-object', { terminal: { shell: { schemaVersion: 1, realm: 'x' } } }, one('terminal.shell.realm', 'invalid_enum_value')],
  ['section: refine message on array element', { terminal: { fetch: { schemaVersion: 1, allowedHosts: ['127.0.0.1'] } } }, one('terminal.fetch.allowedHosts.0', 'custom')],
  ['section: missing required fields', { provider_spending: {} }, [{ path: 'provider_spending.schemaVersion', reason: 'invalid_literal' }, { path: 'provider_spending.budgets', reason: 'invalid_type' }]],
];

describe('config error shape (zod 4 issue-code guard)', () => {
  it.each(cases)('%s', (_name, input, expected) => {
    expect(issues(input)).toEqual(expected);
  });

  it('the localized message carries the reason verbatim in both catalogs', () => {
    const error = (() => { try { validateConfig({ mode: 'turbo' }, 'tr'); } catch (caught) { return caught as ConfigValidationError; } throw new Error('expected'); })();
    expect(error.code).toBe('CONFIG_VALIDATION');
    expect(error.message).toContain('mode: geçersiz değer (invalid_enum_value)');
    expect(error.localize?.('en').message).toContain('mode: invalid value (invalid_enum_value)');
  });
});
