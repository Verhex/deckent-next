import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerSupervisor, FileArtifactStore } from '#adapters/index.js';
import { nativeCliCommand } from '#adapters/core/native-cli-registry/index.js';
import { WorkerTranscriptApplication, type DispatchRecord, type SandboxRequest, type SupervisorError } from '#engine/index.js';
import { attemptIdentitySchema, readWorkerFinalReport, workerReportLimits, type VerifiedPrincipal } from '#domain/index.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const secret = 'handoff-fixture-secret';
const note = { toTask: 'next', summary: `Continue ${secret}`, artifacts: [{ name: 'result', digest: 'a'.repeat(64) }], openQuestions: ['Bearer abc.def.ghi'] };
const nativeReport = { schemaVersion: 1, summary: 'Done', changedFiles: [], checks: [], openIssues: [], handoff: note, sharedNotes: [secret] };

describe('current standalone producer and retained handoff custody', () => {
  it.each([['claude', 'valid'], ['codex', 'missing'], ['codex', 'no-handoff'], ['codex', 'codex-handoff'], ['cursor', 'unsupported'], ['cursor', 'no-report'], ['claude', 'wrong-context'], ['claude', 'oversized-context']])(
    '%s %s uses fresh source without a repository build', async (provider, mode, context) => {
      // This fixture binds a host POSIX socket into a Linux Docker worker; report rules stay portable in worker-handoff-report.
      const capability: { code: SupervisorError['code']; reason: string } | null = process.platform === 'linux' ? null
        : { code: 'SUPERVISOR_OPTIONS_INVALID', reason: 'standalone fixture requires Linux Docker UID/GID and private Unix socket mounts' };
      if (capability) context.skip(`${capability.code}: ${capability.reason}`);
      if (!imageId) context.skip('DECKENT_TEST_DOCKER_IMAGE is not configured: standalone Docker producer verify-not-run');
      const root = await mkdtemp(join(tmpdir(), 'dn-handoff-native-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
      const workspace = join(root, 'workspace'); await mkdir(workspace);
      // Erase TypeScript only into this private fixture. Production source is unchanged and dist/ is never built or read.
      const source = await readFile(new URL('../../../src/adapters/core/native-connection/internal/worker.ts', import.meta.url), 'utf8');
      const bootstrap = stripTypeScriptTypes(source), bootstrapPath = join(root, 'worker.mjs');
      await writeFile(bootstrapPath, bootstrap, { mode: 0o600 });
      const contextText = mode === 'oversized-context' ? 'x'.repeat(workerReportLimits.promptBytes + 1) : 'Untrusted worker handoff: continue from /deckent/inputs/_handoff/source.json';
      const dependencyContext = { maxBytes: workerReportLimits.promptBytes, text: contextText, sha256: mode === 'wrong-context' ? '0'.repeat(64) : hash(contextText) };
      const channel = { claude: 'claude-system-prompt', codex: 'codex-instructions-file', cursor: 'inline' }[provider!];
      const task = 'Perform dependent task', core = 'Authorized fixture instructions';
      const args = provider === 'claude' ? ['--system-prompt', '__DECKENT_CORE_PROMPT__', '--', '__DECKENT_TASK_PROMPT__']
        : provider === 'codex' ? ['model_instructions_file="/tmp/deckent-prompt/core.txt"', 'project_doc_max_bytes=0', '--', '__DECKENT_TASK_PROMPT__']
          : ['--', '__DECKENT_TASK_PROMPT__'];
      const argv = ['/workspace/native.mjs', ...args];
      const body = { schemaVersion: 1, channel, core, task, segments: [] };
      const delivery = { ...body, sha256: hash(JSON.stringify(body)), argvSha256: hash(JSON.stringify(argv)) };
      const native = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture-1'); process.exit(0); }
if (args.includes('--help')) { console.log('--print --json-schema --output-schema'); process.exit(0); }
if (!args.at(-1).includes(${JSON.stringify(contextText)})) process.exit(44);
const i = args.indexOf('--json-schema');
if (${JSON.stringify(provider === 'claude')}) {
  const schema = JSON.parse(args[i+1]);
  if (!schema.properties.handoff || !schema.properties.sharedNotes || schema.properties.handoff.properties.summary.maxLength !== ${workerReportLimits.handoffSummaryChars}) process.exit(45);
}
if (${JSON.stringify(provider === 'codex')}) {
  const schema = JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1], 'utf8'));
  if (schema.required.length !== Object.keys(schema.properties).length || schema.properties.handoff.anyOf[0].required.length !== Object.keys(schema.properties.handoff.anyOf[0].properties).length) process.exit(46);
}
if (${JSON.stringify(mode === 'valid')}) console.log(JSON.stringify({type:'result', subtype:'success', structured_output:${JSON.stringify(nativeReport)}}));
if (${JSON.stringify(mode === 'no-handoff' || mode === 'codex-handoff')}) console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:JSON.stringify(${JSON.stringify(mode === 'no-handoff' ? { ...nativeReport, handoff: null, sharedNotes: [] } : { ...nativeReport, handoff: { ...note, toTask: null } })})}}));
`;
      await writeFile(join(workspace, 'native.mjs'), native, { mode: 0o755 });
      const socketPath = join(root, 'connection.sock');
      const server = createServer((request, response) => {
        if (request.url === '/events') { request.resume(); response.writeHead(204).end(); return; }
        response.end(JSON.stringify({ schemaVersion: 1, provider, capabilities: nativeCliCommand(provider as 'claude' | 'codex' | 'cursor').capabilities, home: '.fixture', file: 'auth.json', credential: { token: secret }, environment: {},
          limits: { connections: 2, idleMs: 1000 }, preflight: { schemaVersion: 1, cliVersion: 'fixture-1', helpArgs: ['--help'], requiredFlags: ['--print'] },
          promptDelivery: delivery, dependencyContext, ...(mode === 'no-report' ? {} : { finalReport: { schemaVersion: 1, limits: workerReportLimits } }) }));
      });
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); }); await chmod(socketPath, 0o600);
      cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
      const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
        logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 536870912, pids: 128, cpus: 1, tmpBytes: 67108864, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536,
        connection: { schemaVersion: 1, socketPath, bootstrapPath, bootstrapSha256: hash(bootstrap) } });
      const sandbox: SandboxRequest = { protocolVersion: 1, identity: { scopeId: 'test', runId: 'run', taskId: 'dependent', attemptId: randomUUID(), generation: 1, layoutRevision: 'layout' }, workspace, argv };
      cleanup.push(async () => { await supervisor.cancel(sandbox); await supervisor.release(sandbox); });
      const result = await supervisor.execute(sandbox);
      if (mode!.includes('context')) {
        expect(result.result).toEqual({ kind: 'exited', exitCode: 78 });
        expect(result.stdout).not.toContain('native-prompt-delivery'); expect(result.stdout).not.toContain('native-worker-report'); return;
      }
      expect(result.result).toEqual({ kind: 'exited', exitCode: 0 });
      const receipt = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(value => value.kind === 'native-prompt-delivery');
      expect(receipt).toMatchObject({ sha256: delivery.sha256, taskSha256: hash(task + '\n\n' + contextText), dependencyContextSha256: dependencyContext.sha256 });
      const final = readWorkerFinalReport(result.stdout);
      if (mode === 'valid' || mode === 'codex-handoff') {
        expect(final).toMatchObject({ status: 'reported', report: { handoff: { summary: 'Continue [REDACTED]', artifacts: note.artifacts, openQuestions: ['[REDACTED]'] }, sharedNotes: ['[REDACTED]'] } });
        expect(result.stdout).not.toContain(secret); expect(result.stdout).not.toContain('abc.def.ghi');
        if (mode === 'codex-handoff' && final.status === 'reported') expect(final.report.handoff).not.toHaveProperty('toTask');
      } else if (mode === 'no-handoff') {
        expect(final).toMatchObject({ status: 'reported', report: { sharedNotes: [] } });
        if (final.status === 'reported') expect(final.report).not.toHaveProperty('handoff');
      } else expect(final).toMatchObject({ status: 'unavailable', reason: mode === 'no-report' ? 'missing' : mode });
      const artifactRoot = join(root, 'artifacts'); await mkdir(artifactRoot, { mode: 0o700 });
      const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: 1048576 });
      const output = await artifacts.put('test', Buffer.from(JSON.stringify({ schemaVersion: 1, identity: sandbox.identity, completeness: result.outputCompleteness, stdout: result.stdout, stderr: result.stderr })));
      const app = new WorkerTranscriptApplication({ async loadWorkerEventLog() { return null; }, async loadBoundDispatch() { return { output } as DispatchRecord; }, async loadRun() { return null; } },
        artifacts, { async authorizeIdentity() {} });
      expect((await app.inspect(attemptIdentitySchema.parse(sandbox.identity), { id: 'fixture' } as VerifiedPrincipal)).finalReport).toEqual(final);
      const retained = await artifacts.prepareReadOnlyFile('test', output); await writeFile(retained.path, 'tampered');
      expect((await app.inspect(attemptIdentitySchema.parse(sandbox.identity), { id: 'fixture' } as VerifiedPrincipal)).finalReport).toMatchObject({ status: 'unavailable', reason: 'invalid' });
    }, 30000);
});
