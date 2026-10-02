import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseProviderCatalogDocument, planModelCatalogRegistration, parseModelCatalogCommand } from '#domain/index.js';
const read = async (path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const seed = () => read('../../fixtures/catalog/claude-v2.json');
const provenance = { sourceUrl: 'https://example.com/models', fetchedOn: '2026-10-02' };
export async function v3() {
  const doc = await seed(); doc.schemaVersion = 3;
  for (const p of doc.providers) {
    Object.assign(p.channel, { client: p.channel.cli, billing: 'subscription', protocolFamily: 'claude-code-stream-json', aliasesRefused: p.channel.aliases, provenance });
    for (const m of p.models) Object.assign(m, { channelModelId: m.nativeId, vendorId: 'anthropic', canonicalModelId: m.nativeId, displayName: m.id,
      modalities: { input: ['text'], output: ['text'] }, contextWindow: null, maxOutputTokens: null,
      reasoning: { supportedEfforts: m.efforts, defaultEffort: null }, capabilities: { tools: 'unknown', vision: 'unknown', pdf: 'unknown', structuredOutput: 'unknown', promptCaching: 'unknown', streaming: 'unknown' },
      pricing: { kind: 'subscription', source: provenance, asOf: '2026-10-02' }, minClientVersion: m.minCliVersion, provenance });
  }
  return doc;
}
describe('catalog document v3', () => {
  it('accepts v3, unknown limits and ultra; preserves v2 bytes', async () => {
    const old = await seed(); expect(parseProviderCatalogDocument(old).schemaVersion).toBe(2);
    const doc = await v3(); doc.providers[0].models[0].efforts.push('ultra');
    expect(parseProviderCatalogDocument(doc).schemaVersion).toBe(3);
    expect(parseProviderCatalogDocument(doc).providers[0]!.models[0]).toMatchObject({ vendorId: 'anthropic', contextWindow: null, reasoning: { supportedEfforts: expect.arrayContaining(['ultra']) } });
  });
  it('links the canonical model across channels without changing exact row keys', async () => {
    const doc = await v3(); const other = structuredClone(doc.providers[0]); other.id = 'other-subscription';
    for (const m of other.models) { m.nativeId = 'other.' + m.nativeId; m.channelModelId = m.nativeId; }
    doc.providers.push(other);
    const plan = planModelCatalogRegistration(parseModelCatalogCommand({ schemaVersion: 1, scopeId: 's', commandId: 'v3', action: 'register', catalog: doc }), { channel: () => null, models: () => [] });
    expect(plan.models).toHaveLength(8);
    expect(plan.models.filter(m => 'canonicalModelId' in m.model && m.model.canonicalModelId === 'claude-opus-5-5').map(m => m.channelId)).toEqual(['claude-cli-subscription', 'other-subscription']);
  });
  it('rejects divergent compatibility pins, reasoning and minimums', async () => {
    for (const edit of [(m: Record<string, unknown>) => { m.channelModelId = 'other'; }, (m: Record<string, unknown>) => { m.minClientVersion = '9.0.0'; },
      (m: Record<string, unknown>) => { m.reasoning = { supportedEfforts: ['low'], defaultEffort: 'ultra' }; }]) {
      const doc = await v3(); edit(doc.providers[0].models[0]); expect(() => parseProviderCatalogDocument(doc)).toThrow();
    }
  });
  it('requires all v3 metadata; rejects numeric/negative prices and independent activation state', async () => {
    for (const edit of [(m: Record<string, unknown>) => { delete m.vendorId; }, (m: Record<string, unknown>) => { (m.pricing as Record<string, unknown>).inputPerMTok = 1; },
      (m: Record<string, unknown>) => { (m.pricing as Record<string, unknown>).inputPerMTok = '-1'; }, (m: Record<string, unknown>) => { m.active = true; }]) {
      const doc = await v3(); edit(doc.providers[0].models[0]); expect(() => parseProviderCatalogDocument(doc)).toThrow();
    }
  });
});
