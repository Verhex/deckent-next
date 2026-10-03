import { describe, expect, it } from 'vitest';
import * as worker from '#adapters/core/native-connection/index.js';

const base = { maxTurns: null, settings: null, promptChannel: 'inline' as const, structuredReport: null, modelUsageEvidence: 'none' as const };
const preflight = { schemaVersion: 1, cliVersion: 'fixture-1', helpArgs: ['exec', '--help'], requiredFlags: ['--print'] };

describe('registry capability routing in the mounted worker, without a provider identity input', () => {
  it('uses the declared prompt channel and refuses missing native custody arguments', () => {
    expect(worker.nativePromptArguments(['--', '__DECKENT_TASK_PROMPT__'], 'Core', 'Task', base)).toEqual(['--', 'Core\n\nTask']);
    const system = { ...base, promptChannel: 'claude-system-prompt' as const };
    expect(worker.nativePromptArguments(['--system-prompt', '__DECKENT_CORE_PROMPT__', '--', '__DECKENT_TASK_PROMPT__'], 'Core', 'Task', system))
      .toEqual(['--system-prompt', 'Core', '--', 'Task']);
    expect(() => worker.nativePromptArguments(['--', '__DECKENT_TASK_PROMPT__'], 'Core', 'Task', system)).toThrow();
    const file = { ...base, promptChannel: 'codex-instructions-file' as const };
    expect(worker.nativePromptArguments(['-c', 'model_instructions_file="/tmp/deckent-prompt/core.txt"', '-c', 'project_doc_max_bytes=0', '--', '__DECKENT_TASK_PROMPT__'], 'Core', 'Task', file).at(-1)).toBe('Task');
    expect(() => worker.nativePromptArguments(['--', '__DECKENT_TASK_PROMPT__'], 'Core', 'Task', file)).toThrow();
  });

  it('probes the configured hidden flag and exact parser refusal, then refuses the wrong refusal', () => {
    const capabilities = { ...base, maxTurns: { flag: '--limit', hiddenHelpProbe: { args: ['--limit', 'invalid'], refusal: 'fixture numeric refusal' } } };
    const probe = { ...preflight, requiredFlags: ['--limit'] };
    const calls: string[][] = [];
    const run = (args: readonly string[]) => { calls.push([...args]); if (args[0] === '--version') return 'fixture-1'; if (args[0] === 'exec') return ''; throw { stderr: 'fixture numeric refusal' }; };
    expect(worker.nativePreflightCapabilities(capabilities, probe, run)).toBe(false);
    expect(calls).toEqual([['--version'], ['exec', '--help'], ['--limit', 'invalid']]);
    expect(() => worker.nativePreflightCapabilities(capabilities, probe, args => args[0] === '--version' ? 'fixture-1' : args[0] === 'exec' ? '' : (() => { throw { stderr: 'different refusal' }; })())).toThrow();
    expect(() => worker.nativePreflightCapabilities(base, probe, args => args[0] === '--version' ? 'fixture-1' : '')).toThrow();
  });

  it('uses the configured report flag and encoding, and rejects version or required flag drift', () => {
    const inline = { ...base, structuredReport: { flag: '--fixture-schema', channel: 'inline-json' as const } };
    const run = (args: readonly string[]) => args[0] === '--version' ? 'fixture-1' : '--print --fixture-schema';
    expect(worker.nativePreflightCapabilities(inline, preflight, run)).toBe(true);
    expect(worker.nativePreflightCapabilities(base, preflight, run)).toBe(false);
    expect(worker.nativePreflightCapabilities(inline, preflight, args => args[0] === '--version' ? 'fixture-1' : '--print')).toBe(false);
    expect(() => worker.nativePreflightCapabilities(inline, preflight, () => 'wrong-version')).toThrow();
    expect(() => worker.nativePreflightCapabilities(inline, preflight, args => args[0] === '--version' ? 'fixture-1' : '--fixture-schema')).toThrow();
    expect(worker.nativeReportArguments(inline, '{}')).toEqual(['--fixture-schema', '{}']);
    expect(worker.nativeReportArguments({ ...inline, structuredReport: { flag: '--fixture-output', channel: 'schema-file' } }, '{}'))
      .toEqual(['--fixture-output', '/tmp/deckent-report-schema.json']);
    expect(worker.nativeReportArguments(base, '{}')).toEqual([]);
  });
});
