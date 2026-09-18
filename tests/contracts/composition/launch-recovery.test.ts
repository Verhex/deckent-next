import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { DockerSupervisor, identifyDockerRequest, openSqliteAttemptStore, validateDockerSupervisorProfile, type SqliteAttemptStore } from '#adapters/index.js';
import { clearConfigCache, prepareProductDirectory } from '#platform/index.js';
import { reconcileAttempt } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyPrincipal } from '../support/custody.js';
import { startTestRuntimeService, stopTestRuntimeService } from '../support/runtime-service.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE; const exec = promisify(execFile);
it.skipIf(!imageId || process.platform !== 'linux').each(['sdk', 'mcp'])('keeps a granted pre-start crash unresolved after %s controller restart', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-launch-recovery-')); const project = join(root, 'project'); const data = join(root, 'data');
  const configPath = join(project, '.deckent/config.json'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const docker = { executable: '/usr/bin/docker', imageId: imageId!, memoryBytes: 268435456, pids: 64, cpus: 1,
    logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
  await writeFile(configPath, JSON.stringify({ layout: { root: data }, execution: { docker,
    git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } } }));
  const options = { env: { HOME: join(root, 'home') } }; const configured = await openConfiguredAttemptStore(project, options); configured.store.close();
  const workspaceRoot = await prepareProductDirectory(configured.layout, 'workspaces'); await prepareProductDirectory(configured.layout, 'artifacts');
  const workspace = join(workspaceRoot, 'worker'); await mkdir(workspace, { mode: 0o700 }); const os = userInfo();
  const supervisorOptions = { ...docker, workspaceRoot, uid: os.uid, gid: os.gid };
  const supervisor = new DockerSupervisor(supervisorOptions); const profile = await supervisor.captureProfile();
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: randomUUID(), generation: 1, layoutRevision: configured.layout.revision };
  const request = { protocolVersion: 1 as const, identity, workspace,
    argv: ['node', '-e', "require('node:fs').writeFileSync('/workspace/effect','must-not-run')"] };
  const claim = { request, owner: 'crashed-controller' };
  const seed = await openSqliteAttemptStore(configured.path, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }, 'allow',
    { validate: validateDockerSupervisorProfile });
  await admitRunAttempts(seed, [identity]); seed.close();
  const policy = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'member', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(os.uid) }], resource: { kind: 'run', ids: ['r'] } },
    { id: 'reconcile', effect: 'allow', actions: ['reconcile'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(os.uid) }], resource: { kind: 'attempt', ids: [identity.attemptId] } },
  ] };
  await writeFile(join(data, 'policy.json'), JSON.stringify(policy), { mode: 0o600 });
  const runtime = await startTestRuntimeService(project, options.env);
  const program = `
    import { openSqliteAttemptStore, validateDockerSupervisorProfile } from './dist/adapters/index.js';
    const [path, claimText, profileText, principalText] = process.argv.slice(1);
    const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }, 'allow', { validate: validateDockerSupervisorProfile });
    const claim = JSON.parse(claimText); const profile = JSON.parse(profileText); const principal = JSON.parse(principalText);
    await store.claimDispatch({ ...claim, profile }); const decision = await store.grantLaunch({ claim, principal, now: 1 });
    process.stdout.write(JSON.stringify({ launch: decision.record.launch, terminal: decision.record.terminal }), () => process.exit(23));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, configured.path, JSON.stringify(claim), JSON.stringify(profile), JSON.stringify(custodyPrincipal)],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  const closed = new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
  const transport = mode === 'mcp' ? new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/composition/core/mcp/internal/entry.js'), '--project', project], env: options.env, stderr: 'pipe' }) : null;
  const client = transport ? new Client({ name: 'launch-recovery-proof', version: '1' }) : null;
  let store: SqliteAttemptStore | undefined; let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([closed, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('CRASH_CONTROLLER_TIMEOUT')), 10_000);
    })]);
    if (timeout) clearTimeout(timeout);
    expect({ exitCode, stderr }).toEqual({ exitCode: 23, stderr: '' }); expect(JSON.parse(stdout)).toEqual({ launch: 'granted', terminal: null });
    store = await openSqliteAttemptStore(configured.path, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }, 'forbid');
    const before = (await store.readDispatch(request))!; expect(before).toMatchObject({ launch: 'granted', terminal: null, grant: { generation: 1 } });
    const { handle } = identifyDockerRequest(request, supervisorOptions);
    const endpoint = (profile.parameters as { endpoint: string }).endpoint;
    await expect(exec('/usr/bin/docker', ['--host', endpoint, 'inspect', handle])).rejects.toMatchObject({ stderr: expect.stringMatching(/no such object/i) });
    if (client && transport) await client.connect(transport);
    const result = client ? await client.callTool({ name: 'reconcile_attempt', arguments: identity }) : await reconcileAttempt(project, identity, options);
    const reconciliation = client ? (result as { structuredContent: { reconciliation: unknown } }).structuredContent.reconciliation
      : result.reconciliation;
    expect(reconciliation).toMatchObject({ status: 'unresolved', terminal: null, outputRecorded: false });
    expect(await store.readDispatch(request)).toEqual(before);
    await expect(readFile(join(workspace, 'effect'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(exec('/usr/bin/docker', ['--host', endpoint, 'inspect', handle])).rejects.toMatchObject({ stderr: expect.stringMatching(/no such object/i) });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed.catch(() => null); }
    store?.close(); await client?.close(); await transport?.close(); await stopTestRuntimeService(runtime); clearConfigCache(); await rm(root, { recursive: true, force: true });
  }
}, 30000);
