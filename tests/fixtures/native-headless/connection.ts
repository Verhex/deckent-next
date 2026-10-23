// One headless connection for tests: private state dir, a config dir of this uid, a scripted fake CLI and a v2 subscription profile.
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseModelBindingDefinition, parseModelInvocationProfile, type ModelInvocationDelta } from '#domain/index.js';
import { createNativeCliHeadlessPort, NATIVE_CLI_HEADLESS_ADAPTER } from '#adapters/core/native-cli-headless/index.js';
import { FAMILY, PINNED, writeFakeCli, type FakeScenario, type FakeStep } from './stream.js';

const roots: string[] = [];
export async function cleanupConnections() { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); }
export const PROMPT = 'Plan this: PROMPT-CANARY-7f3a';
export const binding = parseModelBindingDefinition({ encodingVersion: 1, provider: { id: 'cli-subscription', version: 1 },
  model: { id: 'pinned', version: 1, nativeId: PINNED, protocols: [{ family: FAMILY, version: 'v1', capabilities: [] }] } });
export const request = (over: Record<string, unknown> = {}) => ({ model: PINNED, messages: [{ role: 'system', content: 'You are a planner. Answer only JSON.' },
  { role: 'user', content: PROMPT }], max_completion_tokens: 1000, stream: false, ...over });
type Logged = { mode: string; argv: string[]; env: Record<string, string>; cwd: string; stdin?: string; system?: string; systemMode?: number; entries?: string[] };
/** A fresh connection: private state dir, a config dir of this uid, a scripted fake CLI; profile v2 subscription. */
export async function connection(scenario: Omit<FakeScenario, 'logPath'> = {}, definitionOver: Record<string, unknown> = {}, bindingDigest = 'a'.repeat(64)) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deckent-headless-'))); roots.push(root);
  const configDir = join(root, 'config'), bin = join(root, 'bin'), logPath = join(root, 'calls.jsonl');
  await mkdir(configDir, { mode: 0o700 }); await mkdir(bin);
  const write = (next: Omit<FakeScenario, 'logPath'>) => writeFakeCli(bin, { initCwd: 'actual', ...next, logPath });
  const executable = await write(scenario);
  const profile = parseModelInvocationProfile({ schemaVersion: 2, billingAxis: 'subscription', id: 'headless', version: 1, scopeId: 'scope',
    reference: { providerId: 'cli-subscription', providerVersion: 1, modelId: 'pinned', modelVersion: 1 }, bindingDigest,
    protocol: { family: FAMILY, version: 'v1' }, adapter: { ...NATIVE_CLI_HEADLESS_ADAPTER, definition: { schemaVersion: 1, executable, configDir,
      stateDir: join(root, 'state'), ownerUid: process.getuid!(), minCliVersion: '9.0.0', delegatedUse: null, ...definitionOver } },
    allocation: { id: 'allocation', maxCalls: null, maxInFlight: 1 }, limits: { requestMaxBytes: 65_536, responseMaxBytes: 65_536, timeoutMs: 5000 } });
  const port = createNativeCliHeadlessPort({ now: () => 1 });
  const log = async (): Promise<Logged[]> => existsSync(logPath) ? (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Logged) : [];
  const call = async (steps: readonly FakeStep[] | null = null, over: Record<string, unknown> = {}, signal?: AbortSignal, deltas?: ModelInvocationDelta[]) => {
    if (steps) await write({ ...scenario, steps });
    await port.preflight(profile, signal);
    const prepared = await port.prepare(profile, binding, request(over));
    return port.send(prepared, signal, deltas ? delta => deltas.push(delta) : undefined);
  };
  return { root, configDir, executable, profile, port, log, call, write, runDir: join(root, 'state', 'run'), logPath };
}
