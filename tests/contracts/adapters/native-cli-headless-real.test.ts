// Lead-only acceptance against the real CLI (S3-2): skipped unless DECKENT_HEADLESS_REAL_CLI names the absolute executable. Preflight makes no
// model call; DECKENT_HEADLESS_REAL_SEND=1 adds exactly one tiny one-turn call on the person's own subscription. Nothing personal is stored here.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseModelBindingDefinition, parseModelInvocationProfile } from '#domain/index.js';
import { createNativeCliHeadlessPort, NATIVE_CLI_HEADLESS_ADAPTER } from '#adapters/core/native-cli-headless/index.js';
import catalog from '../../../assets/model-catalog/claude-cli-subscription.json' with { type: 'json' };

const executable = process.env.DECKENT_HEADLESS_REAL_CLI, roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe.skipIf(!executable)('S3-2 real CLI acceptance (lead only)', () => {
  it('preflights the real CLI without a model call and, when asked, runs one guarded turn', async () => {
    // The exact native id comes from catalog data (env override: DECKENT_HEADLESS_REAL_MODEL = a catalog native id), never from this file.
    const provider = catalog.providers[0]!, nativeId = process.env.DECKENT_HEADLESS_REAL_MODEL ?? catalog.recommendedActivations[0]!.modelIds[0]!;
    const model = provider.models.find(entry => entry.nativeId === nativeId)!;
    const root = await realpath(await mkdtemp(join(tmpdir(), 'deckent-headless-real-'))); roots.push(root);
    const family = provider.channel.protocolFamily, binding = parseModelBindingDefinition({ encodingVersion: 1, provider: { id: provider.id, version: provider.version },
      model: { id: model.id, version: model.version, nativeId: model.nativeId, protocols: [{ family, version: 'v1', capabilities: [] }] } });
    const profile = parseModelInvocationProfile({ schemaVersion: 2, billingAxis: 'subscription', id: 'real', version: 1, scopeId: 'scope',
      reference: { providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version }, bindingDigest: 'a'.repeat(64),
      protocol: { family, version: 'v1' }, adapter: { ...NATIVE_CLI_HEADLESS_ADAPTER, definition: { schemaVersion: 1, executable: await realpath(executable!),
        configDir: await realpath(process.env.DECKENT_HEADLESS_CONFIG_DIR ?? join(homedir(), '.claude')), stateDir: join(root, 'state'), ownerUid: process.getuid!(),
        minCliVersion: model.minCliVersion ?? '0.0.0', delegatedUse: null } },
      allocation: { id: 'real', maxCalls: 1, maxInFlight: 1 }, limits: { requestMaxBytes: 65_536, responseMaxBytes: 65_536, timeoutMs: 60_000 } });
    const port = createNativeCliHeadlessPort({ now: Date.now });
    await port.preflight(profile);
    if (process.env.DECKENT_HEADLESS_REAL_SEND !== '1') return;
    const prepared = await port.prepare(profile, binding, { model: model.nativeId, messages: [{ role: 'system', content: 'You are a planner. Answer only JSON.' },
      { role: 'user', content: 'Reply exactly {"ok":true}' }], stream: false, reasoning_effort: 'low' });
    const result = await port.send(prepared);
    expect(result).toMatchObject({ native: { model: model.nativeId, headless: { guard: 'passed' } } });
  }, 120_000);
});
