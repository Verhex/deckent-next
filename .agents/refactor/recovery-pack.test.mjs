import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execute, plan, checkWindow } from './recovery-pack.mjs';

// R-DESIGN §6 G5 negatives: a container id not from a self-admitted Attempt's dispatch record, a bind source outside the N1 root, or a
// missing/expired WINDOW.json stops the pack before any `docker rm -f`. All ports are fakes: no N1, no Docker, no systemd.
const START = Date.parse('2026-10-29T10:00:00Z');
const hex = n => String(n).repeat(64).slice(0, 64);
function fixture(t, { window = {}, workers: shapeWorker = row => row, mount = id => `/n1/data/workspaces/${id.slice(0, 6)}`, inspectId = id => id } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckent-recovery-pack-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const accept = path.join(dir, 'accept'); fs.mkdirSync(accept);
  const config = { k: 2, scope: 'live', n1Root: '/n1', accept, window: path.join(accept, 'WINDOW.json'), task: path.join(accept, 'scenario-task.json'),
    batchDeadlineMs: 60_000, pollMs: 1_000, windowMaxMs: 4 * 3_600_000, restartGapMs: 0 };
  if (window !== null) fs.writeFileSync(config.window, JSON.stringify({ schemaVersion: 1, ownerAnswer: 'R0b Q-A7', startUtc: '2026-10-29T09:30:00Z',
    endUtc: '2026-10-29T11:30:00Z', dockerRestart: 'out', n1DogfoodPaused: true, ...window }));
  fs.writeFileSync(config.task, JSON.stringify({ kind: 'claude-coding', workInput: { schemaVersion: 1, task: 'hold the container' } }));
  const calls = [], runs = [], foreign = [];
  let clock = START, gone = 0;
  const ids = new Map();
  const ports = {
    now: () => clock, sleep: async ms => { clock += Math.max(ms, 1); }, log: () => {},
    cli(argv) {
      calls.push(['cli', ...argv]);
      const [a, b] = argv, id = argv[argv.indexOf('--id') + 1];
      if (a === 'workers') return { code: 0, json: { sources: [{ id: 'current', workers: [...foreign, ...runs.map((runId, i) => {
        const identity = { scopeId: 'live', runId, taskId: 'scenario', attemptId: `a-${i}`, layoutRevision: 'l', generation: 1 };
        if (!ids.has(runId)) ids.set(runId, hex(i + 1));
        return shapeWorker({ identity, terminal: null, process: 'running', dispatch: { containerId: ids.get(runId) } });
      })] }] } };
      if (a === 'recovery') return { code: 0, json: { rules: [{ id: 'container-gone', version: 1, shadowCases: 10 + gone }] } };
      if (a === 'run' && b === 'create') { runs.push(id); return { code: 0, json: { run: {} } }; }
      if (a === 'run' && b === 'inspect') return { code: 0, json: { run: { revision: 3, state: { kind: 'running' }, cancellationRequested: false, recoveryMode: 'shadow' } } };
      if (a === 'run' && b === 'cancel') return { code: 0, json: { run: {} } };
      return { code: 1, json: null, error: 'unexpected' };
    },
    inspect(id) { calls.push(['inspect', id]); return [{ Id: inspectId(id), State: { Status: 'running' }, Mounts: [{ Type: 'bind', Destination: '/workspace', Source: mount(id) }] }]; },
    remove(id) { calls.push(['rm', id]); gone++; return 0; },
    systemctl(action) { calls.push(['systemctl', action]); return 0; }, daemonUp: () => true,
  };
  return { config, ports, calls, foreign, removed: () => calls.filter(call => call[0] === 'rm').map(call => call[1]), setClock: value => { clock = value; } };
}
const stop = async promise => { try { await promise; } catch (error) { return error.code; } return null; };

test('scenario 1 with --apply removes exactly the dispatch-record container of each self-admitted Attempt, then cancels its own Runs', async t => {
  const f = fixture(t);
  const state = await execute(f.config, f.ports, '1');
  assert.deepEqual(f.removed(), [hex(1), hex(2)]);
  assert.deepEqual(state.records, [{ 'container-gone': 2 }]);
  assert.deepEqual(f.calls.filter(call => call[0] === 'cli' && call[2] === 'create').map(call => call[call.indexOf('--id') + 1]), state.runs);
  assert.equal(f.calls.filter(call => call[0] === 'cli' && call[2] === 'cancel').length, 2);
  assert.ok(f.calls.every(call => call[0] !== 'systemctl'));
});

test('every G5 stop happens before any docker rm -f', async t => {
  const cases = [
    ['PACK_WINDOW_MISSING', { window: null }],
    ['PACK_OUTSIDE_WINDOW', { window: { endUtc: '2026-10-29T09:59:59Z' } }],
    ['PACK_WINDOW_INVALID', { window: { endUtc: '2026-10-29T19:00:00Z' } }], // longer than the bound: not the owner's ~2 h window
    ['PACK_WINDOW_INVALID', { window: { n1DogfoodPaused: false } }],
    ['PACK_PENDING_R3', { workers: row => ({ ...row, dispatch: undefined }) }], // the dispatch-record read does not exist yet
    ['PACK_CONTAINER_ID_MISSING', { workers: row => ({ ...row, dispatch: { containerId: 'deckent-name' } }) }],
    ['PACK_CONTAINER_ID_MISMATCH', { inspectId: () => hex(9) }],
    ['PACK_BIND_OUTSIDE_N1', { mount: () => '/n1-other/workspace' }], // a sibling with the root as prefix is outside
    ['PACK_BIND_OUTSIDE_N1', { mount: () => '/home/alperen/deckent-next' }],
  ];
  for (const [code, options] of cases) {
    const f = fixture(t, options);
    assert.equal(await stop(execute(f.config, f.ports, '1')), code, code);
    assert.deepEqual(f.removed(), [], code);
  }
  // A worker of another Run still unsettled: N1 dogfood is not paused; nothing is admitted.
  const busy = fixture(t);
  busy.foreign.push({ identity: { runId: 'd50-w7' }, terminal: null, process: 'running' });
  assert.equal(await stop(execute(busy.config, busy.ports, '1')), 'PACK_FOREIGN_WORKERS');
  assert.ok(busy.calls.every(call => call[2] !== 'create'));
  // The window ends after the targets were verified: the next destructive step refuses.
  const late = fixture(t), inspect = late.ports.inspect;
  late.ports.inspect = id => { late.setClock(Date.parse('2026-10-29T11:30:00Z')); return inspect(id); };
  assert.equal(await stop(execute(late.config, late.ports, '1')), 'PACK_OUTSIDE_WINDOW');
  assert.deepEqual(late.removed(), []);
  // Item 4 needs the owner's Docker restart recorded as in.
  const docker = fixture(t);
  assert.equal(await stop(execute(docker.config, docker.ports, '4')), 'PACK_DOCKER_RESTART_OUT');
  assert.throws(() => checkWindow(docker.config.window, START, '4'), { code: 'PACK_DOCKER_RESTART_OUT' });
});

test('the default is a dry run: it prints the planned steps and spawns nothing', () => {
  assert.deepEqual(plan('2b', 4).steps.filter(step => step.destructive).map(step => step.step), ['admit', 'kill-service', 'remove-containers', 'cancel-runs']);
  assert.deepEqual(plan('2', 4).steps.filter(step => step.expect).map(step => step.expect), [{ 'launcher-dead-orphan': 4 }, { 'container-gone': 4 }]);
  const script = fileURLToPath(new URL('./recovery-pack.mjs', import.meta.url));
  // PATH without docker/systemctl/cli.sh: any spawn would fail; the dry run must still succeed.
  const result = spawnSync(process.execPath, [script, '2', '--k', '3'], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.mode, 'dry-run'); assert.equal(out.k, 3); assert.ok(out.steps.some(step => step.step === 'kill-service' && step.destructive));
  assert.equal(spawnSync(process.execPath, [script, '9'], { encoding: 'utf8' }).status, 1);
});
