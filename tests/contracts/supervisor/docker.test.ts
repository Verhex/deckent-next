import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerSupervisor, openSqliteAttemptStore } from '#adapters/index.js';
import { AttemptApplication, type SandboxRequest } from '#engine/index.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const roots: string[] = []; const releases: (() => Promise<void>)[] = [];
afterEach(async () => { for (const release of releases.splice(0)) await release(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(argv: string[], deadlineMs = 10000) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-supervisor-')); roots.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace); await writeFile(join(root, 'sentinel'), 'host-only');
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: imageId!,
    uid: process.getuid!(), gid: process.getgid!(), logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 268435456, pids: 64, cpus: 1, tmpBytes: 16777216,
    deadlineMs, controlTimeoutMs: 10000, outputBytes: 65536 });
  const request: SandboxRequest = { protocolVersion: 1, identity: { runId: 'run', taskId: 'task', attemptId: randomUUID(), scopeId: 'test',
    generation: 1, layoutRevision: 'layout' }, workspace, argv };
  releases.push(() => supervisor.release(request));
  return { root, supervisor, request };
}
describe.skipIf(!imageId)('real Docker supervisor (explicit pinned test image required)', () => {
  it('confines writes and persists terminal evidence without accepting a task or rerunning on replay', async () => {
    const f = await fixture(['node', '-e', `const fs=require('node:fs');const os=require('node:os');
      fs.appendFileSync('/workspace/result','once');
      let denied=false;try{fs.writeFileSync('/outside','bad')}catch{denied=true}
      let hidden=false;try{fs.readFileSync(process.argv[1])}catch(e){hidden=e.code==='ENOENT'}
      if(!denied||!hidden||Object.keys(os.networkInterfaces()).some(x=>x!=='lo'))process.exit(1);
      console.log('isolated');`, 'placeholder']);
    const request = { ...f.request, argv: [...f.request.argv.slice(0, -1), join(f.root, 'sentinel')] };
    releases.pop(); releases.push(() => f.supervisor.release(request));
    const store = await openSqliteAttemptStore(join(f.root, 'state.db'), { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' });
    try {
      const app = new AttemptApplication(store, { async authorize(command) { if (command.scopeId !== 'test') throw new Error('DENIED'); } }, { async verify() { return { id: 'tester', issuer: 'test', subject: '1', assurance: 'workload-verified', scopeIds: ['test'] }; } });
      const envelope = { schemaVersion: 2, scopeId: 'test' };
      await app.execute({ ...envelope, commandId: 'create', action: { kind: 'create', identity: request.identity } });
      const result = await f.supervisor.execute(request);
      expect(result.result).toEqual({ kind: 'exited', exitCode: 0 }); expect(result.stdout).toContain('isolated');
      const receipt = await app.execute({ ...envelope, commandId: 'terminal', action: { kind: 'observe', observation: {
        protocolVersion: 1, identity: request.identity, sequence: 1, eventId: 'exit', result: result.result } } });
      expect(receipt.snapshot.lastObservation!.result.kind).toBe('exited'); expect(receipt.snapshot).not.toHaveProperty('accepted');
      const replay = await f.supervisor.execute(request);
      expect(replay.result).toEqual(result.result); expect(replay.outputCompleteness).toBe('unavailable');
      expect(result.outputCompleteness).toBe('complete');
      expect(await readFile(join(request.workspace, 'result'), 'utf8')).toBe('once');
      expect(await readFile(join(f.root, 'sentinel'), 'utf8')).toBe('host-only');
      await expect(f.supervisor.execute({ ...request, argv: ['node', '-e', 'process.exit(0)'] })).rejects.toThrow('SUPERVISOR_IDENTITY_CONFLICT');
    } finally { store.close(); }
  });
  it('records nonzero process exit without calling it a transport interruption', async () => {
    const f = await fixture(['node', '-e', 'process.exit(7)']);
    const result = await f.supervisor.execute(f.request);
    expect(result.result).toEqual({ kind: 'exited', exitCode: 7 }); expect(result.interrupted).toBe(false);
  });
  it('kills the actual container on deadline and observes daemon terminal evidence', async () => {
    const f = await fixture(['node', '-e', 'setInterval(()=>{},1000)'], 700);
    const result = await f.supervisor.execute(f.request);
    expect(result.interrupted).toBe(true); expect(result.result.kind).toBe('exited');
    if (result.result.kind === 'exited') expect(result.result.exitCode).not.toBe(0);
  });
  it('cancels a confirmed running container rather than merely disconnecting its CLI', async () => {
    const f = await fixture(['node', '-e', "require('node:fs').writeFileSync('/workspace/ready','yes');setInterval(()=>{},1000)"]);
    const controller = new AbortController(); const execution = f.supervisor.execute(f.request, controller.signal);
    let ready = false;
    try {
      for (let i = 0; i < 60; i++) {
        try { ready = await readFile(join(f.request.workspace, 'ready'), 'utf8') === 'yes'; } catch { /* Startup not yet observed. */ }
        if (ready) break;
        await sleep(50);
      }
    } finally { controller.abort(); }
    const result = await execution;
    expect(ready).toBe(true); expect(result.interrupted).toBe(true); expect(result.result.kind).toBe('exited');
  });

});
