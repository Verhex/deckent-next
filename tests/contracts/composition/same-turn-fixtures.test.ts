import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { nativeAgentToolResultSchema, nativeAgentInitReason } from '#capabilities/index.js';
import { parseBrainDraft } from '#capabilities/core/run-planner/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { AI_PROPOSAL_TOOL_SPECS } from '#engine/index.js';

const base = new URL('../../fixtures/same-turn-planning/', import.meta.url);
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
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
