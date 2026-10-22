import { describe, expect, it } from 'vitest';
import * as worker from '#adapters/core/native-connection/index.js';

const base = { maxTurns: null, settings: null, discovery: null, promptChannel: 'inline' as const, structuredReport: null, modelUsageEvidence: 'none' as const, eventStream: 'cursor-agent-stream-json' as const };
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

  it('runs every discovery probe only for disabled discovery and refuses a CLI that accepts or differently refuses a probe value', () => {
    const probes = [{ args: ['exec', '-c', 'key.one=probe'], refusal: 'expected a boolean\nin `key.one`' }, { args: ['exec', '-c', 'key.two=probe'], refusal: 'expected a boolean\nin `key.two`' }];
    const capabilities = { ...base, discovery: { requiredFlags: ['--strict-config'], hiddenProbes: probes } };
    const disabled = { ...preflight, requiredFlags: ['--strict-config'], discovery: 'disabled' };
    const cli = (refusals: Record<string, string | null>) => { const calls: string[][] = []; return { calls, run: (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === '--version') return 'fixture-1';
      if (args[1] === '--help') return '--strict-config';
      const refusal = refusals[args.at(-1)!];
      if (refusal === null || refusal === undefined) return '';
      throw { stderr: `Error loading config.toml: ${refusal}\n` };
    } }; };
    const known = { 'key.one=probe': 'invalid type: string "probe", expected a boolean\nin `key.one`', 'key.two=probe': 'invalid type: string "probe", expected a boolean\nin `key.two`' };
    const ok = cli(known);
    expect(worker.nativePreflightCapabilities(capabilities, disabled, ok.run)).toBe(false);
    expect(ok.calls).toEqual([['--version'], ['exec', '--help'], probes[0]!.args, probes[1]!.args]);
    // An unknown key under strict config draws a different refusal; a CLI that accepts the value never refuses: both stop before credentials.
    expect(() => worker.nativePreflightCapabilities(capabilities, disabled, cli({ ...known, 'key.two=probe': 'unknown configuration field `key.two`' }).run)).toThrow();
    expect(() => worker.nativePreflightCapabilities(capabilities, disabled, cli({ ...known, 'key.one=probe': null }).run)).toThrow();
    // Disabled discovery on a CLI without a discovery capability fails closed.
    expect(() => worker.nativePreflightCapabilities(base, disabled, cli(known).run)).toThrow();
    // Repository discovery (and a preflight recorded before the mode was carried) runs no discovery probe.
    for (const mode of [{ discovery: 'repository' }, {}]) {
      const plain = cli({}); expect(worker.nativePreflightCapabilities(capabilities, { ...preflight, requiredFlags: ['--strict-config'], ...mode }, plain.run)).toBe(false);
      expect(plain.calls).toEqual([['--version'], ['exec', '--help']]);
    }
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

  it('treats the flagless final-text-json channel as supported without a help flag and delivers its schema only in the prompt', () => {
    const text = { ...base, structuredReport: { flag: null, channel: 'final-text-json' as const } };
    const calls: string[][] = [];
    expect(worker.nativePreflightCapabilities(text, preflight, args => { calls.push([...args]); return args[0] === '--version' ? 'fixture-1' : '--print'; })).toBe(true);
    expect(calls).toEqual([['--version'], ['exec', '--help']]);
    // The flagless channel never weakens version or required-flag custody.
    expect(() => worker.nativePreflightCapabilities(text, preflight, () => 'wrong-version')).toThrow();
    expect(() => worker.nativePreflightCapabilities(text, preflight, args => args[0] === '--version' ? 'fixture-1' : '')).toThrow();
    expect(worker.nativeReportArguments(text, '{"type":"object"}')).toEqual([]);
    const instruction = worker.nativeReportInstruction(text, '{"type":"object"}');
    expect(instruction).toMatch(/^### report:final-text-json@1\n.*exactly one JSON object.*no code fence\.\n\{"type":"object"\}$/s);
    expect(worker.nativeReportInstruction(base, '{}')).toBeNull();
    expect(worker.nativeReportInstruction({ ...base, structuredReport: { flag: '--fixture-schema', channel: 'inline-json' as const } }, '{}')).toBeNull();
  });
});
