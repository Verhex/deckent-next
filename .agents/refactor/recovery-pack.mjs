#!/usr/bin/env node
// alpha.56 N1 recovery scenario pack (R-DESIGN §G5; owner Q-A7). Host tooling for the lead: never in src/, never published, never run by a
// worker. Default is a dry run that prints the planned steps and spawns nothing. `--apply` runs them against N1 only:
//   node .agents/refactor/recovery-pack.mjs <1|2|2b|3|4> [--k 4] [--scope live] [--apply]
// Safety (law-audit MAJOR): a container is removed only by the exact 64-hex id in the dispatch record of an Attempt of a Run this pack admitted
// itself, re-read right before removal and matched by `docker inspect` (same id, /workspace bind under the N1 root); never a name or label filter.
// It refuses to start, and stops before every destructive step, without a valid WINDOW.json covering now. Any unexpected state stops it.
// It never writes a verdict, promotion or grant, never restarts Docker (item 4 is the owner's sudo step) and never touches live or proje-wsl.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULTS = Object.freeze({
  cli: '/home/alperen/deckent-dogfood/bin/cli.sh', n1Root: '/home/alperen/deckent-dogfood', unit: 'deckent-n1.service',
  accept: '/home/alperen/deckent-refactor-work/proof/ALPHA56-2026-10-24/accept', scope: 'live', k: 4,
  batchDeadlineMs: 10 * 60_000, pollMs: 15_000, windowMaxMs: 4 * 3_600_000, restartGapMs: 5_000,
});
/** Rule ids are the Nervous seed's (assets/nervous/rules.json); `expect` is the per-rule detection delta one batch must produce (null: measured only). */
export const SCENARIOS = Object.freeze({
  '1': { title: 'container killed', steps: ['admit', 'await-containers', 'verify-targets', 'remove-containers', ['await-records', { 'container-gone': 'k' }], 'cancel-runs'] },
  '2': { title: 'service SIGKILL (orphans), then orphan removal', steps: ['admit', 'await-containers', 'verify-targets', 'kill-service', 'await-service',
    ['await-records', { 'launcher-dead-orphan': 'k' }], 'verify-targets', 'remove-containers', ['await-records', { 'container-gone': 'k' }], 'cancel-runs'] },
  '2b': { title: 'service SIGKILL + container removed in the restart gap', steps: ['admit', 'await-containers', 'verify-targets', 'kill-service', 'remove-containers',
    'await-service', ['await-records', { 'launcher-dead-gone': 'k' }], 'cancel-runs'] },
  '3': { title: 'service graceful stop/start (measured; any detection is reported)', steps: ['admit', 'await-containers', 'verify-targets', 'stop-service', 'start-service',
    'await-service', ['await-records', null], 'cancel-runs'] },
  '4': { title: 'Docker daemon restart by the owner (sudo, live idle)', docker: true, steps: ['admit', 'await-containers', 'verify-targets', 'owner-docker-restart',
    ['await-records', null], 'cancel-runs'] },
});
const DESTRUCTIVE = new Set(['admit', 'remove-containers', 'kill-service', 'stop-service', 'start-service', 'cancel-runs']);
const HEX64 = /^[a-f0-9]{64}$/u;
export class PackStop extends Error { constructor(code, detail = {}) { super(`${code} ${JSON.stringify(detail)}`); this.code = code; this.detail = detail; } }

/** WINDOW.json (written by the lead from the owner's Q-A7 answer): `{schemaVersion:1, ownerAnswer, startUtc, endUtc, dockerRestart:'in'|'out', n1DogfoodPaused:true}`. */
export function checkWindow(path, now, scenario, maxMs = DEFAULTS.windowMaxMs) {
  if (!existsSync(path)) throw new PackStop('PACK_WINDOW_MISSING', { path });
  let w; try { w = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new PackStop('PACK_WINDOW_INVALID', { path }); }
  const start = Date.parse(w?.startUtc), end = Date.parse(w?.endUtc);
  if (w?.schemaVersion !== 1 || typeof w.ownerAnswer !== 'string' || !w.ownerAnswer || !Number.isFinite(start) || !Number.isFinite(end) || end <= start
    || end - start > maxMs || !['in', 'out'].includes(w.dockerRestart) || w.n1DogfoodPaused !== true) throw new PackStop('PACK_WINDOW_INVALID', { path });
  if (now < start || now >= end) throw new PackStop('PACK_OUTSIDE_WINDOW', { now: new Date(now).toISOString(), startUtc: w.startUtc, endUtc: w.endUtc });
  if (SCENARIOS[scenario]?.docker && w.dockerRestart !== 'in') throw new PackStop('PACK_DOCKER_RESTART_OUT', { scenario });
  return w;
}
/** The scenario Run: one `small` task (owner Q-A3: only low-risk classes may continue) from the lead's accept/scenario-task.json `{kind, workInput}`. */
export function scenarioGraph(task) {
  if (!task || typeof task.kind !== 'string' || !task.workInput || typeof task.workInput !== 'object') throw new PackStop('PACK_TASK_INVALID');
  return { schemaVersion: 4, revision: 1, tasks: [{ id: 'scenario', kind: task.kind, workClass: 'small', dependencies: [], acceptanceCriteria: ['exit'], workInput: task.workInput }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'recovery scenario worker; the pack cancels the Run after its records appear',
      evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
}
export function plan(scenario, k = DEFAULTS.k) {
  const s = SCENARIOS[scenario]; if (!s) throw new PackStop('PACK_SCENARIO_UNKNOWN', { scenario, known: Object.keys(SCENARIOS) });
  if (!Number.isInteger(k) || k < 1 || k > 8) throw new PackStop('PACK_K_INVALID', { k });
  return { scenario, title: s.title, k, steps: s.steps.map(step => Array.isArray(step) ? { step: step[0], expect: step[1] && Object.fromEntries(Object.entries(step[1]).map(([rule]) => [rule, k])) }
    : { step }).map(row => ({ ...row, destructive: DESTRUCTIVE.has(row.step) })) };
}

const same = (a, b) => ['scopeId', 'runId', 'taskId', 'attemptId', 'layoutRevision', 'generation'].every(key => a?.[key] === b?.[key]);
const workers = json => (json?.sources ?? []).filter(source => source.id === 'current').flatMap(source => source.workers ?? []);
/**
 * PENDING R3: the one named source of a container id is the dispatch record (`DispatchRecord.containerId`, engine/core/dispatch/internal/port.ts),
 * read through `workers --scope <s> --json` → `sources[id=current].workers[].dispatch.containerId` (the record `inspectConfiguredWorkers` already
 * loads with `loadBoundDispatch`). Today that field does not exist: the pack stops here. Monitor `attempt.container.containerId` and `handle` are
 * observations, never the source.
 */
export function dispatchContainerId(json, identity) {
  const rows = workers(json).filter(row => same(row.identity, identity));
  if (rows.length !== 1) throw new PackStop('PACK_ATTEMPT_NOT_FOUND', { identity, rows: rows.length });
  if (!rows[0].dispatch || !('containerId' in rows[0].dispatch)) throw new PackStop('PACK_PENDING_R3', { read: 'workers[].dispatch.containerId' });
  const id = rows[0].dispatch.containerId;
  if (typeof id !== 'string' || !HEX64.test(id)) throw new PackStop('PACK_CONTAINER_ID_MISSING', { identity });
  return id;
}
/** `docker inspect <id>` (JSON array) must be exactly that container, with its /workspace bind source inside the N1 root. */
export function checkInspect(inspected, id, n1Root) {
  const row = Array.isArray(inspected) && inspected.length === 1 ? inspected[0] : null;
  if (!row || row.Id !== id) throw new PackStop('PACK_CONTAINER_ID_MISMATCH', { id, observed: row?.Id ?? null });
  const binds = (row.Mounts ?? []).filter(mount => mount.Destination === '/workspace' && mount.Type === 'bind');
  const root = resolve(n1Root) + sep;
  if (binds.length !== 1 || typeof binds[0].Source !== 'string' || !resolve(binds[0].Source).startsWith(root)) {
    throw new PackStop('PACK_BIND_OUTSIDE_N1', { id, source: binds[0]?.Source ?? null, root });
  }
  return { id, workspace: binds[0].Source, status: row.State?.Status ?? null };
}
/**
 * PENDING R3: per-rule shadow case counts from `recovery --scope <s> --json` → `rules[]{id, version, shadowCases}` (G4 view). Counts only: the view
 * never returns a model action for an unreviewed case (blind), and the pack needs none.
 */
export function ruleCounts(json) {
  if (!Array.isArray(json?.rules)) throw new PackStop('PACK_PENDING_R3', { read: 'recovery --json rules[].shadowCases' });
  return Object.fromEntries(json.rules.map(rule => [rule.id, rule.shadowCases]));
}

/** Real host ports. Docker is reached only through `inspect`/`remove` by a validated id, systemd only for the N1 unit, Deckent only through cli.sh. */
export function hostPorts(config) {
  const run = (cmd, argv, timeout = 120_000) => spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 << 20, timeout });
  const json = text => { try { return JSON.parse(text); } catch { return null; } };
  return {
    cli(argv) { const r = run(config.cli, [...argv, '--json'], 300_000); return { code: r.status, json: json(r.stdout), error: json(r.stderr) ?? r.stderr?.trim() ?? null }; },
    inspect(id) { if (!HEX64.test(id)) throw new PackStop('PACK_CONTAINER_ID_MISSING', { id }); const r = run('docker', ['inspect', '--type', 'container', id]); return r.status === 0 ? json(r.stdout) : null; },
    remove(id) { if (!HEX64.test(id)) throw new PackStop('PACK_CONTAINER_ID_MISSING', { id }); return run('docker', ['rm', '-f', id]).status; },
    daemonUp() { return run('docker', ['info', '--format', '{{.ID}}'], 10_000).status === 0; },
    systemctl(action) {
      const argv = { kill: ['kill', '-s', 'KILL', config.unit], stop: ['stop', config.unit], start: ['start', config.unit] }[action];
      return run('systemctl', ['--user', ...argv]).status;
    },
    now: Date.now, sleep: ms => new Promise(done => setTimeout(done, ms)),
    log(record) { mkdirSync(config.accept, { recursive: true, mode: 0o700 }); appendFileSync(config.reportFile, `${JSON.stringify(record)}\n`); },
  };
}

/** Runs one batch. Every port call is the pack's; `state.runs` holds only Runs this invocation admitted. */
export async function execute(config, ports, scenario) {
  const p = plan(scenario, config.k), stamp = new Date(ports.now()).toISOString().replace(/[-:.]/gu, '').slice(0, 15).toLowerCase();
  const window = () => checkWindow(config.window, ports.now(), scenario, config.windowMaxMs);
  window();
  const task = JSON.parse(readFileSync(config.task, 'utf8')), graph = scenarioGraph(task);
  const state = { scenario, stamp, runs: [], identities: [], targets: [], baseline: null, records: [], allowed: new Set() };
  const log = (step, detail = {}) => ports.log({ at: new Date(ports.now()).toISOString(), scenario, step, ...detail });
  const must = (argv, code = 'PACK_CLI_FAILED') => { const r = ports.cli(argv); if (r.code !== 0 || !r.json) throw new PackStop(code, { argv: argv.slice(0, 2), error: r.error }); return r.json; };
  const deadline = ports.now() + config.batchDeadlineMs;
  const until = async (what, probe) => {
    for (;;) { const value = await probe(); if (value) return value; if (ports.now() >= deadline) throw new PackStop('PACK_DEADLINE', { what }); await ports.sleep(config.pollMs); }
  };
  const own = row => state.runs.includes(row.identity?.runId);
  const steps = {
    async admit() {
      // N1 dogfood is paused for the window: an unsettled worker of any other Run would be hit by a service kill. Refuse rather than touch it.
      const foreign = workers(must(['workers', '--scope', config.scope])).filter(row => row.terminal == null && !own(row));
      if (foreign.length) throw new PackStop('PACK_FOREIGN_WORKERS', { runs: [...new Set(foreign.map(row => row.identity?.runId))] });
      state.baseline = ruleCounts(must(['recovery', '--scope', config.scope]));
      for (let i = 1; i <= config.k; i++) {
        const id = `rp${scenario}-${stamp}-${i}`, file = join(config.accept, `${id}-graph.json`);
        mkdirSync(config.accept, { recursive: true, mode: 0o700 }); writeFileSync(file, `${JSON.stringify(graph, null, 2)}\n`);
        must(['run', 'create', '--scope', config.scope, '--id', id, '--command-id', `create-${id}`, '--graph', file]); state.runs.push(id);
        // Only a Run admitted after the owner set N1 to shadow freezes a recovery section (R-DESIGN F-f); otherwise the batch measures nothing.
        const mode = must(['run', 'inspect', '--scope', config.scope, '--id', id]).run?.recoveryMode;
        if (mode !== 'shadow') throw new PackStop('PACK_RECOVERY_NOT_SHADOW', { runId: id, recoveryMode: mode ?? null });
      }
    },
    async 'await-containers'() {
      state.identities = await until('containers', () => {
        const rows = workers(must(['workers', '--scope', config.scope])).filter(row => own(row) && row.terminal == null && row.process === 'running');
        return new Set(rows.map(row => row.identity.runId)).size === state.runs.length ? rows.map(row => row.identity) : null;
      });
    },
    async 'verify-targets'() {
      const json = must(['workers', '--scope', config.scope]);
      state.targets = state.identities.map(identity => { const id = dispatchContainerId(json, identity); return { identity, ...checkInspect(ports.inspect(id), id, config.n1Root) }; });
    },
    async 'remove-containers'() {
      for (const target of state.targets) {
        window();
        // Re-inspect by the verified id right before removal (the service may be down here, so the ledger read stays the one in verify-targets).
        checkInspect(ports.inspect(target.id), target.id, config.n1Root);
        if (ports.remove(target.id) !== 0) throw new PackStop('PACK_REMOVE_FAILED', { id: target.id });
        log('removed', { id: target.id, identity: target.identity });
      }
    },
    async 'kill-service'() { if (ports.systemctl('kill') !== 0) throw new PackStop('PACK_SYSTEMCTL_FAILED', { action: 'kill' }); },
    async 'stop-service'() { if (ports.systemctl('stop') !== 0) throw new PackStop('PACK_SYSTEMCTL_FAILED', { action: 'stop' }); },
    async 'start-service'() { if (ports.systemctl('start') !== 0) throw new PackStop('PACK_SYSTEMCTL_FAILED', { action: 'start' }); },
    async 'await-service'() { await ports.sleep(config.restartGapMs); await until('service', () => ports.cli(['runtime', 'describe']).code === 0); },
    async 'owner-docker-restart'() {
      log('owner-step', { say: 'Owner: run `sudo systemctl restart docker` now (live idle). The pack only observes the outage.' });
      await until('daemon-down', () => !ports.daemonUp()); await until('daemon-up', () => ports.daemonUp());
    },
    async 'await-records'(expect) {
      const delta = counts => Object.fromEntries(Object.entries(counts).map(([rule, n]) => [rule, n - (state.baseline[rule] ?? 0)]).filter(([, n]) => n !== 0));
      if (!expect) { await ports.sleep(config.batchDeadlineMs / 2); state.records.push(delta(ruleCounts(must(['recovery', '--scope', config.scope])))); return; }
      for (const rule of Object.keys(expect)) state.allowed.add(rule);
      state.records.push(await until('records', () => { const seen = delta(ruleCounts(must(['recovery', '--scope', config.scope])));
        // A rule this scenario does not provoke fired: unexpected state (a false positive or foreign work), stop and report.
        if (Object.keys(seen).some(rule => !state.allowed.has(rule))) throw new PackStop('PACK_UNEXPECTED_RECORDS', { seen, expect });
        return Object.entries(expect).every(([rule, n]) => (seen[rule] ?? 0) >= n) ? seen : null; }));
    },
    async 'cancel-runs'() {
      for (const id of state.runs) {
        const run = must(['run', 'inspect', '--scope', config.scope, '--id', id]).run;
        if (run && run.state?.kind !== 'terminal' && !run.cancellationRequested) must(['run', 'cancel', '--scope', config.scope, '--id', id, '--command-id', `cancel-${id}`, '--expected-revision', String(run.revision)]);
      }
    },
  };
  for (const row of p.steps) {
    if (row.destructive) window();
    log('step', { step: row.step });
    try { await steps[row.step](row.expect); } catch (error) { log('stopped', { step: row.step, code: error.code ?? 'PACK_ERROR', detail: error.detail ?? String(error) }); throw error; }
  }
  log('done', { runs: state.runs, records: state.records });
  return state;
}

async function main(argv) {
  const scenario = argv[0], opt = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const config = { ...DEFAULTS, k: opt('--k') === undefined ? DEFAULTS.k : Number(opt('--k')), scope: opt('--scope') ?? DEFAULTS.scope };
  config.window = join(config.accept, 'WINDOW.json'); config.task = join(config.accept, 'scenario-task.json');
  config.reportFile = join(config.accept, `pack-${scenario}.jsonl`);
  const shown = plan(scenario, config.k);
  if (!argv.includes('--apply')) {
    let window; try { checkWindow(config.window, Date.now(), scenario); window = 'ok'; } catch (error) { window = error.code ?? String(error); }
    console.log(JSON.stringify({ mode: 'dry-run', ...shown, window, task: existsSync(config.task) ? config.task : 'missing', apply: 'add --apply to run these steps on N1' }, null, 2));
    return;
  }
  const state = await execute(config, hostPorts(config), scenario);
  console.log(JSON.stringify({ mode: 'applied', runs: state.runs, records: state.records, report: config.reportFile }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ code: error.code ?? 'PACK_ERROR', detail: error.detail ?? String(error) })); process.exitCode = 1; });
}
