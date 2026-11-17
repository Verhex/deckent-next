import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { nativeAgentToolResultSchema, nativeAgentInitReason } from '#capabilities/index.js';
import { parseBrainDraft } from '#capabilities/core/run-planner/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { AI_PROPOSAL_TOOL_SPECS } from '#engine/index.js';
import { recordAttempt } from '../../fixtures/same-turn-planning/record-attempt.mjs';

const base = new URL('../../fixtures/same-turn-planning/', import.meta.url);
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
it('retains recording failure stages, unknown invocation and known results across cleanup failures without retry', async () => {
  const fault = (code: string) => Object.assign(new Error('private error detail must not enter metadata'), { code });
  const evidence = { started: true, reason: 'exit', exitCode: 0, signal: null, stdoutTruncated: false, stderrTruncated: false,
    limit: null, egress: { connected: 1, refused: 0, hosts: {}, other: 0 } };
  const run = vi.fn(async () => evidence), capture = vi.fn(async () => undefined), closed: string[] = [];
  const cleanup = [['bridge-close', async () => { closed.push('bridge'); }], ['launch-dispose', async () => { closed.push('launch'); }]];
  const beforeRunner = await recordAttempt({ prepare: async (at: (stage: string) => void) => { at('binary-realpath'); throw fault('ENOENT'); }, run, capture, cleanup });
  expect(JSON.parse(JSON.stringify(beforeRunner))).toMatchObject({ attemptStage: 'binary-realpath', invocationState: 'not-started', invocationCount: 0,
    failure: { stage: 'binary-realpath', code: 'ENOENT' }, process: null, cleanupFailures: [] });
  expect(run).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled(); expect(closed).toEqual(['bridge', 'launch']);

  const prepare = async () => undefined;
  // A runner can throw before spawn OR after an effect with no returned ProcessEvidence. Neither proves zero calls.
  const throwsBefore = vi.fn(async () => { throw fault('HEADLESS_ISOLATION_UNAVAILABLE'); });
  const unknownBefore = await recordAttempt({ prepare, run: throwsBefore, capture, cleanup: [] });
  expect(unknownBefore).toMatchObject({ attemptStage: 'runner', invocationState: 'unknown', invocationCount: null,
    failure: { stage: 'runner', code: 'HEADLESS_ISOLATION_UNAVAILABLE' }, process: null });
  let fakeEffects = 0;
  const throwsAfter = vi.fn(async () => { fakeEffects++; throw fault('REALM_FAILED_AFTER_PROCESS'); });
  const unknownAfter = await recordAttempt({ prepare, run: throwsAfter, capture, cleanup });
  expect(unknownAfter).toMatchObject({ invocationState: 'unknown', invocationCount: null,
    failure: { stage: 'runner', code: 'REALM_FAILED_AFTER_PROCESS' }, process: null });
  expect(throwsBefore).toHaveBeenCalledTimes(1); expect(throwsAfter).toHaveBeenCalledTimes(1); expect(fakeEffects).toBe(1);
  expect(capture).not.toHaveBeenCalled();

  const notStarted = await recordAttempt({ prepare, run: async () => ({ ...evidence, started: false, reason: 'cancelled', exitCode: null }), capture, cleanup: [] });
  expect(notStarted).toMatchObject({ invocationState: 'not-started', invocationCount: 0, process: { reason: 'cancelled', exitCode: null } });

  const disposal = vi.fn(async () => { throw fault('DISPOSE_FAILED'); });
  const cleanupOnly = await recordAttempt({ prepare, run, capture,
    cleanup: [['bridge-close', async () => { throw fault('CLOSE_FAILED'); }], ['launch-dispose', disposal]] });
  expect(JSON.parse(JSON.stringify(cleanupOnly))).toMatchObject({ attemptStage: 'bridge-close', invocationState: 'started', invocationCount: 1,
    failure: null, process: { reason: 'exit', exitCode: 0, egress: evidence.egress },
    cleanupFailures: [{ stage: 'bridge-close', code: 'CLOSE_FAILED' }, { stage: 'launch-dispose', code: 'DISPOSE_FAILED' }] });
  expect(disposal).toHaveBeenCalledTimes(1);
  const captureFailed = await recordAttempt({ prepare, run, capture: async () => { throw fault('EACCES'); }, cleanup: [] });
  expect(captureFailed).toMatchObject({ attemptStage: 'capture', invocationState: 'started', invocationCount: 1,
    failure: { stage: 'capture', code: 'EACCES' }, process: { reason: 'exit', exitCode: 0 } });
  expect(run).toHaveBeenCalledTimes(2); expect(JSON.stringify(captureFailed)).not.toContain('private error detail');
});
it('pins declared synthetic provenance and bytes for each CLI, positive framing and all five negative groups', async () => {
  for (const cli of ['codex', 'claude']) {
    for (const group of ['positive', 'group-1', 'group-2', 'group-3', 'group-4', 'group-5']) {
      const dir = new URL(`${cli}/${group}/`, base);
      const manifest = JSON.parse(await readFile(new URL('manifest.json', dir), 'utf8'));
      expect(manifest.recording).toBe(false);
      expect(manifest.provenance).toBe(group === 'positive' ? 'hand-built' : 'mutation');
      for (const record of manifest.files) {
        const bytes = await readFile(new URL(record.file, dir));
        expect({ sha256: sha(bytes), bytes: bytes.length, lines: bytes.toString().trimEnd().split('\n').length }).toEqual({ sha256: record.sha256, bytes: record.bytes, lines: record.lines });
      }
      if (group !== 'positive') {
        const cases = (await readFile(new URL('cases.jsonl', dir), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
        expect(cases.length).toBeGreaterThan(0);
        expect(cases.map(row => row.id)).toEqual(manifest.changes.map((row: { case: string }) => row.case));
        for (const row of cases) {
          expect(row.mutations.length, row.id).toBeGreaterThan(0);
          const changes = manifest.changes.find((change: { case: string }) => change.case === row.id).bytesChanged;
          expect(changes, row.id).toEqual(row.mutations.map((mutation: { path: string; replacement: unknown }) => ({ path: mutation.path,
            replacementSha256: sha(JSON.stringify(mutation.replacement)), replacementBytes: Buffer.byteLength(JSON.stringify(mutation.replacement)) })));
          expect(row.expected.additionalSends ?? 0, row.id).toBe(0);
          // Mutations are materialized native wire plus explicit host-side custody observations, never a shadow production verifier.
          expect(Array.isArray(row.wire), row.id).toBe(true);
          expect(row.host, row.id).toHaveProperty('finish');
        }
        continue;
      }
      const host = JSON.parse(await readFile(new URL('host.json', dir), 'utf8'));
      const wire = (await readFile(new URL('stdout.jsonl', dir), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
      const terminal = cli === 'codex' ? wire.at(-2).item.text : wire.at(-2).message.content[0].text;
      expect(terminal).toBe(`DECKENT-PLAN-CHALLENGE/1 ${host.challenge}\n${host.D}`);
      expect(host.challenge).toMatch(/^[a-f0-9]{64}$/u);
      expect(sha(host.D)).toBe(host.D_sha256); expect(sha(host.P)).toBe(host.P_sha256);
      expect(parseBrainDraft(host.D)).toHaveProperty('graph.tasks');
      const envelope = JSON.parse(cli === 'codex' ? wire[4].item.result.content[0].text : wire[3].message.content[0].content[0].text);
      expect(nativeAgentToolResultSchema.parse(envelope)).toMatchObject({ turnId: host.turnId, generation: host.generation, deckentCallId: host.deckentCallId, outcome: { status: 'ok', text: host.P } });
      expect(host.events.indexOf('durable-settlement-ok')).toBeLessThan(host.events.indexOf('native-release'));
      expect(host.events.indexOf('response-retained')).toBeLessThan(host.events.indexOf('card'));
      expect(JSON.stringify(host.publicSinks)).not.toContain(host.challenge);
      if (cli === 'claude') {
        const entry = nativeCliAgent('claude-code-stream-json')!;
        expect(nativeAgentInitReason(entry.agent, entry.bridge, { schemaVersion: 1, turnId: host.turnId, generation: host.generation,
          approvalTtlMs: 60_000, tools: AI_PROPOSAL_TOOL_SPECS.filter(tool => tool.name === 'propose_work') }, wire[0])).toBeNull();
        expect(wire.at(-1)).toMatchObject({ subtype: 'success', is_error: false, stop_reason: 'end_turn', result: terminal, session_id: wire.at(-2).session_id });
        expect(wire.at(-2).parent_tool_use_id).toBeNull();
        expect(wire.at(-2).message.id).not.toBe(wire[1].message.id);
      } else {
        expect(wire.at(-1).type).toBe('turn.completed');
        expect(wire.some(row => row.type === 'item.started' && row.item.type === 'agent_message')).toBe(false);
      }
    }
  }
});
