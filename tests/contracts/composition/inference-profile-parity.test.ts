import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { createMcpServer, main } from '#surfaces/index.js';
import { clearConfigCache, resolveGlobalConfigPaths } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { describeMcpInference } from '#composition/core/mcp/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const profile = (id: string, computeCap: number) => ({
  schemaVersion: 1, id, scopeId: 'pilot',
  hardware: { gpus: 1, vramGbPerGpu: 32, arch: 'blackwell_consumer', topology: 'single' },
  model: { modelId: 'Qwen/Qwen3-Next-27B', weightGb: 17.5, kvBytesPerTokenBf16: 65536, kvBytesPerTokenFp8: 32768, deltaNetStateGbPerSeq: 0.1 },
  serving: { backend: 'vllm', weightQuant: 'nvfp4', kvDtype: 'fp8', gpuMemUtil: 0.92, overheadGb: 3, imageRef: 'vllm/vllm-openai:v0.10.2' },
  workload: { maxCtx: 163840, avgActiveCtx: 32768, roleMaxCtx: { brain: 163840, worker: 65536, auditor: 32768 } },
  calibration: { computeCap },
});

async function project(serving: Record<string, unknown> | undefined) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-inference-parity-')); roots.push(root);
  const home = join(root, 'home'), projectRoot = join(root, 'project');
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') };
  const projectPath = join(projectRoot, '.deckent', 'config.json');
  await Promise.all([mkdir(dirname(resolveGlobalConfigPaths(env).platformPath), { recursive: true }), mkdir(dirname(projectPath), { recursive: true })]);
  await writeFile(projectPath, JSON.stringify(serving ? { inference_serving: serving } : {}));
  return { projectRoot, env };
}

async function cli(projectRoot: string, env: Record<string, string>, ...args: string[]) {
  const stdout: string[] = [], stderr: string[] = [];
  // Same initializer as the composed CLI entry (config sections registered before loading).
  const code = await main(['inference', 'plan', ...args, '--json', '--lang', 'en'], { initialize: registerProviderConfig, root: projectRoot, env,
    stdout: { write(value: string) { stdout.push(value); } }, stderr: { write(value: string) { stderr.push(value); } } });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

async function mcp(projectRoot: string, env: Record<string, string>, args: Record<string, unknown>) {
  registerProviderConfig(); // as the composed MCP entry does at start
  const server = createMcpServer({ async inspectRun() { return null; }, async inspectInventory() { return null; },
    inferencePlan: input => describeMcpInference(projectRoot, 'plan', input.profileId, { env }),
    inferenceBudget: input => describeMcpInference(projectRoot, 'budget', input.profileId, { env }) },
  { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'inference-parity', version: '1' });
  await client.connect(clientTransport);
  try { return await client.callTool({ name: 'inference_plan', arguments: args }); }
  finally { await client.close(); await server.close(); }
}

it('selects configured inference profiles identically through CLI and MCP and types an unknown profile as a failure, not absence', async () => {
  const configured = await project({ schemaVersion: 1, activeProfileId: 'dev', profiles: [profile('dev', 8), profile('alt', 4)] });

  // Known explicit profile: both surfaces return the same plan.
  const known = await cli(configured.projectRoot, configured.env, '--profile', 'alt');
  expect(known.code, known.stderr).toBe(0);
  const knownMcp = await mcp(configured.projectRoot, configured.env, { profileId: 'alt' });
  expect(knownMcp.isError).not.toBe(true);
  expect((knownMcp.structuredContent as { configured: boolean; plan: unknown })).toEqual({ schemaVersion: 1, configured: true, plan: JSON.parse(known.stdout) });

  // Omitted profile resolves activeProfileId on both surfaces.
  const active = await cli(configured.projectRoot, configured.env);
  expect((await mcp(configured.projectRoot, configured.env, {})).structuredContent).toEqual({ schemaVersion: 1, configured: true, plan: JSON.parse(active.stdout) });
  expect(JSON.parse(active.stdout)).not.toEqual(JSON.parse(known.stdout));

  // Unknown explicit profile against a configured set: the same typed failure, never `configured: false`.
  const unknown = await cli(configured.projectRoot, configured.env, '--profile', 'typo');
  expect(unknown.code).toBe(2); expect(unknown.stdout).toBe(''); expect(unknown.stderr).toContain('INFERENCE_PROFILE_UNKNOWN');
  const unknownMcp = await mcp(configured.projectRoot, configured.env, { profileId: 'typo' });
  expect(unknownMcp.isError).toBe(true);
  expect(JSON.parse((unknownMcp.content as { text: string }[])[0]!.text)).toEqual({ schemaVersion: 1, code: 'INFERENCE_PROFILE_UNKNOWN' });
  await expect(describeMcpInference(configured.projectRoot, 'budget', 'typo', { env: configured.env })).rejects.toMatchObject({ code: 'INFERENCE_PROFILE_UNKNOWN' });

  // No inference_serving section: absence on both surfaces, with or without a requested profile.
  const empty = await project(undefined);
  const absent = await cli(empty.projectRoot, empty.env, '--profile', 'typo');
  expect(absent.code).toBe(0); expect(absent.stderr).toContain('inference_serving is not configured');
  expect((await mcp(empty.projectRoot, empty.env, { profileId: 'typo' })).structuredContent).toEqual({ schemaVersion: 1, configured: false });
});
