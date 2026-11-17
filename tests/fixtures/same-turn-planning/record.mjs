// LEAD ONLY; never imported by tests. One isolated invocation, no retry, no login/version command.
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { nativeAgentLaunch, nativeAgentCorrelationKind, nativeAgentFlagSetDigest, nativeBridgeLimits, runHeadlessIsolated } from '#adapters/core/native-cli-headless/index.js';
import { createNativeToolBridge } from '#adapters/core/native-tool-bridge/index.js';
import { redactForRecord } from '#platform/index.js';
import { preparationFixture, recordingSystem, recordingStdin } from './preparation.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fileInfo = bytes => ({ sha256: sha(bytes), bytes: bytes.length, lines: bytes.length ? bytes.toString().split('\n').length - (bytes.at(-1) === 10 ? 1 : 0) : 0 });
const [inputFile] = process.argv.slice(2);
if (!inputFile) throw new Error('Usage: node record.mjs <lead-sandbox-input.json>');
const input = JSON.parse(await readFile(inputFile, 'utf8'));
for (const key of ['outDir', 'sandboxConfigDir', 'executable', 'isolationModule', 'catalogFile', 'modelId', 'cliVersion']) {
  if (typeof input[key] !== 'string' || !input[key]) throw new Error('MISSING_INPUT_' + key);
}
if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) throw new Error('MISSING_TIMEOUT');
const catalogBytes = await readFile(input.catalogFile), catalog = JSON.parse(catalogBytes);
const candidates = catalog.providers.flatMap(provider => provider.models.filter(model => model.id === input.modelId && model.lifecycle.state === 'active')
  .map(model => ({ provider, model })));
if (candidates.length !== 1) throw new Error('EXACT_ACTIVE_REGISTRY_MODEL_REQUIRED');
const { provider, model } = candidates[0], entry = nativeCliAgent(provider.channel.protocolFamily);
if (!entry) throw new Error('AGENT_ENTRY_REQUIRED');
const minimum = model.minCliVersion ?? model.minClientVersion;
const versionParts = value => value.split('.').map(Number);
const actual = versionParts(input.cliVersion), required = minimum ? versionParts(minimum) : [];
if (actual.some(Number.isNaN) || required.some(Number.isNaN) || required.some((n, i) => actual.slice(0, i).every((v, j) => v === required[j]) && (actual[i] ?? 0) < n)) throw new Error('CLI_BELOW_REGISTRY_MINIMUM');
// mkdir without recursive is the once-only marker: an existing/failed recording directory is never reused.
const outDir = resolve(input.outDir); await mkdir(outDir, { mode: 0o700 });
const runDir = join(outDir, 'run'), stateDir = join(outDir, 'fixture-state');
await mkdir(runDir, { mode: 0o700 }); await mkdir(stateDir, { mode: 0o700 });
const fixture = preparationFixture('recording-turn', input.timeoutMs, join(outDir, 'custody.jsonl'));
const abort = new AbortController(), limits = nativeBridgeLimits();
if (!limits) throw new Error('REGISTRY_BRIDGE_DISABLED');
const bridge = await createNativeToolBridge({ port: fixture.port, bridge: entry.bridge, limits, correlationKind: nativeAgentCorrelationKind(entry), signal: abort.signal });
let launch, result, failure;
const argv = [], executable = await realpath(input.executable), binary = await readFile(executable);
try {
  const { isolation } = await import(pathToFileURL(resolve(input.isolationModule)).href);
  if (typeof isolation !== 'function') throw new Error('LEAD_SANDBOX_ISOLATION_PORT_REQUIRED');
  // nativeAgentLaunch calls codexAgentArgv / prepareClaudeAgentRun, including all registry security flags.
  launch = await nativeAgentLaunch(entry, { session: fixture.session, runDir, configDir: input.sandboxConfigDir, model: model.nativeId,
    system: recordingSystem, user: recordingStdin, effortArgs: [], turnToken: bridge.turnToken, bridgeUrl: bridge.url,
    timeoutMs: input.timeoutMs, outputMaxBytes: entry.headless.limits.stdinMaxBytes });
  argv.push(...launch.spawn.args);
  process.stdout.write(JSON.stringify({ cli: entry.id, argv, argvSha256: sha(JSON.stringify(argv)) }) + '\n');
  result = await runHeadlessIsolated(entry, isolation, { ...launch.spawn, executable, stateDir, mcp: bridge, now: Date.now }, launch.bounds, abort.signal);
} catch (error) { failure = typeof error?.code === 'string' ? error.code : 'RECORDING_FAILED'; }
finally { abort.abort(); await bridge.close(); await launch?.dispose(); }
const raw = result ? { stdout: Buffer.from(result.stdoutBase64, 'base64'), stderr: Buffer.from(result.stderrBase64, 'base64') } : {};
const credentialPattern = /sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.eyJ|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const secretFree = Object.values(raw).every(bytes => !credentialPattern.test(bytes.toString()) && redactForRecord(bytes.toString(), bridge.known) === bytes.toString());
if (!secretFree) failure = 'SECRET_FREE_CHECK_FAILED_NO_RAW_SAVED';
if (result && (result.reason !== 'exit' || result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated || result.limit || fixture.calls !== 1)) failure ??= 'RECORDING_INCOMPLETE';
const files = {};
if (secretFree) for (const [name, bytes] of Object.entries(raw)) {
  const file = name === 'stdout' ? 'stdout.jsonl' : 'stderr.txt'; await writeFile(join(outDir, file), bytes, { mode: 0o600 }); files[file] = fileInfo(bytes);
}
const manifest = { provenance: 'recording', status: failure ?? 'wire-captured-awaits-protocol-review', cli: entry.id,
  binary: { path: executable, version: input.cliVersion, sha256: sha(binary), versionEvidence: input.versionEvidence ?? null },
  registry: { revision: catalog.revision, sha256: sha(catalogBytes), flagSetDigest: nativeAgentFlagSetDigest(entry), modelId: model.id, minimum },
  argv, argvSha256: sha(JSON.stringify(argv)), stdinSha256: sha(recordingStdin), systemSha256: sha(recordingSystem),
  files, secretFree, invocationCount: result?.started ? 1 : 0, preparationCalls: fixture.calls,
  process: result ? { reason: result.reason, exitCode: result.exitCode, signal: result.signal, stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated, limit: result.limit, egress: result.egress } : null,
  limits: 'Fixture custody is not real engine settlement/source/card evidence; inspect early draft, correlated delivery, terminal framing, normal close and exact D before opening K1/K2.' };
await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({ status: manifest.status, manifest: join(outDir, 'manifest.json') }) + '\n');
if (failure) process.exitCode = 1;
