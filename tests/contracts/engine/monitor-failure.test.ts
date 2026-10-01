import { describe, expect, it } from 'vitest';
import { extractFirstFailure, summarizeMonitorEvent } from '#engine/index.js';
import type { WorkerEvent } from '#domain/index.js';

// MONITOR v1.1: the first failing line of a failed attempt's recorded output (real N1 dogfood shapes) and worker event summaries.
describe('first failure extraction (pure)', () => {
  it('finds the lint-arch violation of N1 d3-1b-verify', () => {
    const stdout = ['lint-arch: 870 src files', '\u001b[31m✗ [unit-budget] src/surfaces/core/cli — 2025 lines > unit budget 2000; split the unit or move behaviour to a higher tier\u001b[39m',
      'core-memory: 12 file(s), 0 violation(s)', 'Docker execution not assessed in sandbox'].join('\n');
    expect(extractFirstFailure(stdout, '')).toBe('✗ [unit-budget] src/surfaces/core/cli — 2025 lines > unit budget 2000; split the unit or move behaviour to a higher tier');
  });
  it('takes the first vitest FAIL line, not a guard banner that says FAILS, nor the later AssertionError', () => {
    const stdout = ['!! guard test (tests/contracts/adapters/bwrap-real-sandbox-guard.test.ts) FAILS on a host with user namespaces.',
      ' ❯ tests/contracts/surfaces/run.test.ts (3 tests | 1 failed) 900ms',
      ' FAIL  tests/contracts/surfaces/run.test.ts > compiled Run CLI and SDK > returns the same RunView',
      'AssertionError: expected 2 to be 1 // Object.is equality'].join('\n');
    expect(extractFirstFailure(stdout, '')).toBe('FAIL tests/contracts/surfaces/run.test.ts > compiled Run CLI and SDK > returns the same RunView');
    expect(extractFirstFailure('ok\nAssertionError: expected 1 to be 2\nmore', '')).toBe('AssertionError: expected 1 to be 2');
  });
  it('recognises tsc, eslint (with its file) and node coded errors', () => {
    expect(extractFirstFailure('> tsc\nsrc/a.ts(3,7): error TS2322: Type string is not assignable to type number.\nsrc/b.ts(1,1): error TS1005', ''))
      .toBe('src/a.ts(3,7): error TS2322: Type string is not assignable to type number.');
    expect(extractFirstFailure('\n/workspace/src/x.ts\n  12:5  error  \'y\' is assigned a value but never used  no-unused-vars\n\n✖ 1 problem', ''))
      .toBe('/workspace/src/x.ts 12:5 error \'y\' is assigned a value but never used no-unused-vars');
    expect(extractFirstFailure('', "node:internal/modules\n    throw new ERR_MODULE_NOT_FOUND(\nError [ERR_MODULE_NOT_FOUND]: Cannot find module '/vendor/chunk-OXXOQBJJ.js' imported from /run/deckent-bootstrap.mjs\n  code: 'ERR_MODULE_NOT_FOUND',\n}\n\nNode.js v24.21.0"))
      .toBe("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/vendor/chunk-OXXOQBJJ.js' imported from /run/deckent-bootstrap.mjs");
  });
  it('searches stdout before stderr, falls back to the last non-empty stderr then stdout line, bounds to 200 chars', () => {
    expect(extractFirstFailure('FAIL  a.test.ts > x', 'Error [ERR_X]: y')).toBe('FAIL a.test.ts > x');
    expect(extractFirstFailure('line 1\nlast out\n', 'warn\nRun deckent --help. [CLI_USAGE]\n\n')).toBe('Run deckent --help. [CLI_USAGE]');
    expect(extractFirstFailure('{"kind":"native-coding-exit","code":1,"failure":"model"}\n', '')).toBe('{"kind":"native-coding-exit","code":1,"failure":"model"}');
    expect(extractFirstFailure('\n \n', '')).toBeNull();
    const long = extractFirstFailure('✗ [rule] ' + 'x'.repeat(400), '')!;
    expect(long).toHaveLength(200); expect(long.endsWith('…')).toBe(true);
  });
});

describe('worker event summaries (untrusted, bounded)', () => {
  const base = { schemaVersion: 1 as const, sequence: 1, atMs: 5 };
  it('names what the worker did without raw content beyond the redacted excerpt', () => {
    const cases: [WorkerEvent, string, string][] = [
      [{ ...base, kind: 'tool.call', toolId: 't1', name: 'Edit', toolClass: 'edit', target: 'src/a.ts', detail: null } as WorkerEvent, 'tool.call', 'edit Edit src/a.ts'],
      [{ ...base, kind: 'tool.result', toolId: 't1', status: 'error', bytes: 10 }, 'tool.result', 'error'],
      [{ ...base, kind: 'session.started', provider: 'claude', model: 'claude-sonnet-5-5', cliVersion: null }, 'session.started', 'claude claude-sonnet-5-5'],
      [{ ...base, kind: 'message', role: 'assistant', textBytes: 3, thinking: false, excerpt: 'Fixing the failing test now' }, 'message', 'Fixing the failing test now'],
      [{ ...base, kind: 'limit', limit: 'max-turns', detail: '40 turns' }, 'limit', 'max-turns 40 turns'],
      [{ ...base, kind: 'dropped', reason: 'event-cap', count: 3 }, 'dropped', 'event-cap 3'],
    ];
    for (const [event, kind, summary] of cases) expect(summarizeMonitorEvent(event)).toEqual({ kind, summary });
    expect(summarizeMonitorEvent({ ...base, kind: 'message', role: 'assistant', textBytes: 3, thinking: false, excerpt: 'y'.repeat(240) }).summary).toHaveLength(120);
  });
});
