import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../fixtures/cli-input.js';
import { clearConfigCache } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const query = { schemaVersion: 1, scopeId: 'scope', decisionId: 'decision' };
const advice = { schemaVersion: 1, choice: 'option-a', probabilities: { 'option-a': 0.6, none_of_the_above: 0.25, insufficient_information: 0.15 },
  confidence: 0.9, sufficiency: 0.4, checks: {}, model: 'fixture', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 };
const result = { schemaVersion: 1, status: 'below-threshold', decisionId: 'decision', caseDigest: 'a'.repeat(64), adviceDigest: 'b'.repeat(64),
  advice, thresholds: { choice: 0.8, sufficiency: 0.75 }, invocationId: 'invocation', record: null, replayed: false };
const decisionCase = { schemaVersion: 1, objective: 'Choose a reversible action', scope: 'scope', revision: 'r1', constraints: [], unknowns: [],
  evidence: [{ id: 'e1', source: 'fixture', observedAt: '2026-01-01T00:00:00Z', observation: 'A measured observation' }],
  options: [{ id: 'option-a', action: 'Observe', tradeoffs: ['No write'], evidenceIds: ['e1'] }], checks: [],
  process: { stage: 'review', currentState: 'prepared', acceptedDecisions: [], nextStep: 'Choose', reopenReason: null } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-decision-cli-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home); await mkdir(join(root, '.deckent'));
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ cli: { invocationInputMaxBytes: 4096 } }));
  return { root, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
}
it('routes strict file (POSIX) / stdin inspection and renders both abstentions and sufficiency against configured thresholds in EN/TR', async () => {
  const f = await fixture(), path = join(f.root, 'query.json'); await writeFile(path, JSON.stringify(query));
  for (const language of ['en', 'tr']) {
    let output = '', calls = 0;
    const code = await main(['decide', 'inspect', '--input', language === 'en' ? path : '-', '--lang', language], {
      ...f, stdin: Readable.from([JSON.stringify(query)]), stdout: { write(text) { output += text; } },
      inspectDecision: async (_root: string, input: unknown) => { calls++; expect(input).toEqual(query); return result; },
    } as never);
    expect(code).toBe(0); expect(calls).toBe(1); expect(output).toContain('none_of_the_above'); expect(output).toContain('insufficient_information');
    expect(output).toContain('0.25'); expect(output).toContain('0.15'); expect(output).toContain('0.4'); expect(output).toContain('0.75');
    expect(output).toContain(language === 'en' ? 'Below threshold' : 'Eşik altında');
    expect(output.split('\n')).toContain(language === 'en'
      ? 'Choice: option-a · choice probability 0.6 (threshold 0.8) · confidence 0.9'
      : 'Seçim: option-a · seçim olasılığı 0.6 (eşik 0.8) · güven 0.9');
    expect(output).toContain(language === 'en' ? 'Selection grants no authority' : 'Seçim yetki vermez');
  }
});
it('preserves unknown as JSON without inventing advice', async () => {
  const f = await fixture(); let output = '';
  const absent = { ...result, status: 'unknown', advice: null, adviceDigest: null };
  const code = await main(['decide', 'inspect', '--input', '-', '--json'], { ...f, stdin: Readable.from([JSON.stringify(query)]),
    stdout: { write(text) { output += text; } }, inspectDecision: async () => absent } as never);
  expect(code).toBe(0); expect(JSON.parse(output)).toEqual(absent);
});
it('rejects extended query input before calling inspection', async () => {
  const f = await fixture(); let calls = 0;
  const code = await main(['decide', 'inspect', '--input', '-'], { ...f, stdin: Readable.from([JSON.stringify({ ...query, selectedOption: 'option-a' })]),
    stderr: { write() {} }, inspectDecision: async () => { calls++; return result; } } as never);
  expect(code).not.toBe(0); expect(calls).toBe(0);
});
it('registers decision help without reading configuration or invoking an application', async () => {
  let output = '';
  const code = await main(['decide', '--help', '--lang', 'tr'], { stdout: { write(text) { output += text; } } });
  expect(code).toBe(0); expect(output).toContain('prepare|ask|record|outcome|inspect'); expect(output).toContain('--input <file|->');
});
it('forwards prepare, ask, record and outcome to one typed application each without starting the selected action', async () => {
  const f = await fixture(), controller = new AbortController(), calls: string[] = [];
  const inputs = {
    prepare: { schemaVersion: 1, case: decisionCase },
    ask: { schemaVersion: 1, commandId: 'ask-command', scopeId: 'scope', case: decisionCase,
      invocation: { reference: { providerId: 'fixture', providerVersion: 1, modelId: 'fixture', modelVersion: 1 }, catalogRevision: 'r1',
        expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: 'c'.repeat(64) } } },
    record: { ...query, commandId: 'record-command', selectedOption: 'option-a', rationale: 'Actor judgement' },
    outcome: { ...query, commandId: 'outcome-command', outcome: { observedAt: '2026-01-02T00:00:00Z', observation: 'Observed later' } },
  };
  for (const action of ['prepare', 'ask', 'record', 'outcome'] as const) {
    let output = '';
    const code = await main(['decide', action, '--input', '-', '--json'], { ...f, signal: controller.signal,
      stdin: Readable.from([JSON.stringify(inputs[action])]), stdout: { write(text: string) { output += text; } },
      prepareDecision: async (_root: string, input: unknown) => { expect(input).toEqual(inputs.prepare); calls.push('prepare'); return { schemaVersion: 1, case: decisionCase, caseDigest: result.caseDigest, thresholds: result.thresholds }; },
      askDecision: async (_root: string, input: unknown, _options: unknown, signal: AbortSignal) => { expect(input).toEqual(inputs.ask); expect(signal).toBe(controller.signal); calls.push('ask'); return result; },
      recordDecision: async (_root: string, input: unknown) => { expect(input).toEqual(inputs.record); calls.push('record'); return { schemaVersion: 1, replayed: false, record: {} }; },
      outcomeDecision: async (_root: string, input: unknown) => { expect(input).toEqual(inputs.outcome); calls.push('outcome'); return { schemaVersion: 1, replayed: false, record: {} }; },
      executeOperation: async () => { throw new Error('SELECTION_MUST_NOT_EXECUTE'); },
      createRun: async () => { throw new Error('SELECTION_MUST_NOT_ADMIT'); },
    } as never);
    expect(code).toBe(0); expect(JSON.parse(output)).toHaveProperty('schemaVersion', 1);
  }
  expect(calls).toEqual(['prepare', 'ask', 'record', 'outcome']);
});
it('reports unavailable wiring as an operation error and never fabricates a successful advice', async () => {
  const f = await fixture(); let output = '', error = '';
  const code = await main(['decide', 'ask', '--input', '-', '--json'], { ...f, stdin: Readable.from([JSON.stringify({ schemaVersion: 1,
    commandId: 'ask-command', scopeId: 'scope', case: decisionCase,
    invocation: { reference: { providerId: 'fixture', providerVersion: 1, modelId: 'fixture', modelVersion: 1 }, catalogRevision: 'r1',
      expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: 'c'.repeat(64) } } })]), stdout: { write(text) { output += text; } }, stderr: { write(text) { error += text; } } });
  expect(code).not.toBe(0); expect(output).toBe(''); expect(error).toContain('DECISION_UNAVAILABLE');
});
