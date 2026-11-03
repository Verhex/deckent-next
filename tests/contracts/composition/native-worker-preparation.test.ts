import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as adapters from '#adapters/index.js';
import { modelInvocationProfileSchema } from '#domain/index.js';
import { modelInvocationProfileDigest } from '#engine/index.js';
import { createConfiguredNativeCliWorkerRuntime } from '#composition/core/execution/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import { nativeAgentRealmAvailable, writeFakeAgentCli } from '../../fixtures/native-headless/agent.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'k26-preparation-')); roots.push(root);
  const global = join(root, 'global'), configDir = join(global, 'headless', 'logins', 'fixture'), stateDir = join(global, 'headless', 'connections', 'fixture'), bin = join(root, 'bin');
  for (const path of [configDir, stateDir, bin]) await mkdir(path, { recursive: true, mode: 0o700 });
  const registry = (await import('../../../assets/native-coding/commands.json', { with: { type: 'json' } })).default;
  const family = registry.adapters.claude.capabilities.eventStream!;
  const executable = await writeFakeAgentCli(bin, family, { answer: 'must-not-run-a-model' });
  const f = await brainProviderFixture({ headless: { executable, configDir, stateDir, protocolFamily: family } });
  const profile = modelInvocationProfileSchema.parse(f.config.provider_invocation_profiles.profiles[0]);
  const runtime = createConfiguredNativeCliWorkerRuntime(f.project, { env: { ...f.options.env, DECKENT_GLOBAL_HOME: global } })!;
  const query = { surface: 'worker' as const, scopeId: profile.scopeId, reference: profile.reference,
    profileDigest: modelInvocationProfileDigest(profile), flagSetDigest: adapters.nativeAgentFlagSetDigest(adapters.nativeCliAgent(family)!) };
  return { f, profile, runtime, query, record: join(stateDir, `agent-${query.profileDigest}.json`), stateDir };
}

it('K26: the execution owner prepares cold and expired observations while readiness stays read-only', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath!, expect.getState().currentTestName!)) return;
  const h = await fixture();
  try {
    expect(await h.runtime.readiness.read(h.query)).toBeNull();
    await expect(readFile(h.record)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await h.runtime.prepare!(h.profile)).toBeNull();
    expect(await h.runtime.readiness.read(h.query)).toMatchObject({ cli: true, login: true, environment: true, toolSurface: null });
    const record = JSON.parse(await readFile(h.record, 'utf8'));
    record.checkedAtMs = Date.now() - adapters.nativeCliAgent(h.profile.protocol.family)!.agent.observationMaxAgeMs! - 1;
    await writeFile(h.record, JSON.stringify(record));
    expect(await h.runtime.readiness.read(h.query)).toBeNull();
    expect(await h.runtime.prepare!(h.profile)).toBeNull();
    expect(await h.runtime.readiness.read(h.query)).toMatchObject({ cli: true, execution: { profileDigest: h.query.profileDigest } });
    expect(JSON.parse(await readFile(h.record, 'utf8')).checkedAtMs).toBeGreaterThan(record.checkedAtMs);
    expect(h.f.posts).toBe(0);
  } finally { await h.f.close(); }
});

it('K26: a known-negative observation is never reprobed or overwritten', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath!, expect.getState().currentTestName!)) return;
  const h = await fixture();
  try {
    await h.runtime.prepare!(h.profile);
    const record = JSON.parse(await readFile(h.record, 'utf8')); record.observed.plugins = false;
    await writeFile(h.record, JSON.stringify(record)); const before = await readFile(h.record, 'utf8');
    const preflight = vi.spyOn(adapters, 'preflightNativeAgent');
    expect(await h.runtime.prepare!(h.profile)).toBeNull();
    expect(await h.runtime.readiness.read(h.query)).toMatchObject({ plugins: false });
    expect(preflight).not.toHaveBeenCalled(); expect(await readFile(h.record, 'utf8')).toBe(before); expect(h.f.posts).toBe(0);
  } finally { await h.f.close(); }
});

it('K26: a preflight failure returns its typed wait without starting a model or retrying', async () => {
  const h = await fixture();
  try {
    const preflight = vi.spyOn(adapters, 'preflightNativeAgent').mockRejectedValue({ code: 'HEADLESS_LOGIN_REQUIRED', message: 'private-cli-output' });
    const driver = vi.spyOn(adapters, 'createNativeCliWorkerDriver');
    expect(await h.runtime.prepare!(h.profile)).toBe('NATIVE_AGENT_LOGIN_REQUIRED');
    expect(preflight).toHaveBeenCalledTimes(1); expect(driver).not.toHaveBeenCalled();
    expect(await h.runtime.readiness.read(h.query)).toBeNull(); expect(h.f.posts).toBe(0);
  } finally { await h.f.close(); }
});

it('K26: concurrent preparation shares one binding claim and an abandoned claim is never stolen', async () => {
  const h = await fixture();
  try {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const preflight = vi.spyOn(adapters, 'preflightNativeAgent').mockImplementation(async () => { entered(); await held; throw { code: 'HEADLESS_CLI_UNAVAILABLE' }; });
    const first = h.runtime.prepare!(h.profile); await started;
    expect(await h.runtime.prepare!(h.profile)).toBe('NATIVE_AGENT_CAPABILITY_UNSEALED');
    release(); expect(await first).toBe('NATIVE_AGENT_CLI_UNAVAILABLE'); expect(preflight).toHaveBeenCalledTimes(1);
    await writeFile(join(h.stateDir, `worker-preflight-${h.query.profileDigest}.json.lock`), '', { mode: 0o600, flag: 'wx' });
    expect(await h.runtime.prepare!(h.profile)).toBe('NATIVE_AGENT_CAPABILITY_UNSEALED'); expect(preflight).toHaveBeenCalledTimes(1);
  } finally { await h.f.close(); }
});
