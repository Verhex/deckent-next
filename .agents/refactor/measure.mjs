#!/usr/bin/env node
// Worker throughput measurement log (owner 2026-10-03): one JSONL file per UTC day under .deckent/host/measurements/,
// never a single growing file. Samples Deckent worker containers (label deckent.request) plus host load and the other
// load on the machine (Codex lanes, vitest, vLLM), so a measurement states what else was running. Host tooling only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DIR = path.resolve(here, '../../.deckent/host/measurements');
export const dailyFile = (dir, at) => path.join(dir, `${at.toISOString().slice(0, 10)}.jsonl`);
/** Appends one record to the file of the record's UTC day (created 0600, directory 0700). */
export function append(dir, record, at = new Date()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = dailyFile(dir, at);
  fs.appendFileSync(file, JSON.stringify({ at: at.toISOString(), ...record }) + '\n', { mode: 0o600 });
  return file;
}
const percent = value => Number.parseFloat(String(value).replace('%', '')) || 0;
const mib = value => { const m = /^([\d.]+)\s*([A-Za-z]*)/.exec(String(value).trim()); if (!m) return 0; const k = { B: 1 / 1048576, KiB: 1 / 1024, kB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 }[m[2] || 'B'] ?? 0; return Math.round(Number.parseFloat(m[1]) * k); };
/** Pure: docker stats JSON lines → worker container usage (only Deckent workers). */
export function parseStats(lines, workerIds) {
  return lines.filter(Boolean).map(line => JSON.parse(line)).filter(s => workerIds.has(s.ID?.slice(0, 12)) || workerIds.has(s.Name))
    .map(s => ({ name: s.Name.slice(0, 20), cpuPct: percent(s.CPUPerc), memMiB: mib(String(s.MemUsage).split('/')[0]) }));
}
function cpuTimes() { return os.cpus().reduce((t, c) => { const v = c.times; t.busy += v.user + v.nice + v.sys + v.irq; t.all += v.user + v.nice + v.sys + v.irq + v.idle; return t; }, { busy: 0, all: 0 }); }
/** An observation is either text or a typed failure — a failed docker/ps call is never read as an empty machine. */
export const exec = (cmd, args) => { try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }) }; }
  catch (error) { return { ok: false, error: error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM' ? 'timeout' : String(error.code ?? error.status ?? 'failed') }; } };
const lines = result => result.out.split('\n').filter(Boolean);
function otherLoad(run) {
  const ps = run('ps', ['-eo', 'args']), vllm = run('docker', ['ps', '--filter', 'name=vllm', '-q']);
  return { codexLanes: ps.ok ? lines(ps).filter(a => /codex exec/.test(a) && !/vendor/.test(a)).length : null,
    vitest: ps.ok ? lines(ps).filter(a => /^node .*vitest/.test(a)).length : null, vllm: vllm.ok ? lines(vllm).length : null };
}
/** One sample. inventory = docker ps of Deckent workers; stats = their usage. Unknown stays null with its error. */
export function sample(previous, run = exec) {
  const inventory = run('docker', ['ps', '--filter', 'label=deckent.request', '--format', '{{.ID}}']);
  const ids = inventory.ok ? new Set(lines(inventory)) : null;
  const stats = ids?.size ? run('docker', ['stats', '--no-stream', '--format', '{{json .}}']) : null;
  const perWorker = ids === null ? null : stats?.ok ? parseStats(lines(stats), ids) : ids.size ? null : [];
  const now = cpuTimes(), cpuBusyPct = previous ? Math.round(1000 * (now.busy - previous.busy) / Math.max(1, now.all - previous.all)) / 10 : null;
  return { times: now, record: { kind: 'sample',
    observation: { inventory: inventory.ok ? 'ok' : 'unavailable', stats: stats === null ? 'not-needed' : stats.ok ? 'ok' : 'unavailable',
      ...(inventory.ok ? {} : { inventoryError: inventory.error }), ...(stats && !stats.ok ? { statsError: stats.error } : {}) },
    workers: ids ? ids.size : null, workerCpuPct: perWorker ? Math.round(perWorker.reduce((s, w) => s + w.cpuPct, 0)) : null,
    workerMemMiB: perWorker ? perWorker.reduce((s, w) => s + w.memMiB, 0) : null,
    host: { cpus: os.cpus().length, cpuBusyPct, load1: os.loadavg()[0], memUsedMiB: Math.round((os.totalmem() - os.freemem()) / 1048576) },
    other: otherLoad(run), perWorker } };
}
/** Idle-stop counts only successful, empty inventories after workers were seen; an unavailable observation never ends a run
 * and restarts the idle window, because whether workers ran during the outage is unknown (Sol 2295 R2). */
export function idleStep(state, record, now, idleStopMs) {
  if (record.workers === null) return { ...state, idleSince: null, stop: false };
  if (record.workers > 0) return { seen: true, idleSince: null, stop: false };
  if (!state.seen) return { ...state, stop: false };
  const idleSince = state.idleSince ?? now; return { seen: true, idleSince, stop: now - idleSince >= idleStopMs };
}
async function main() {
  const [command, ...rest] = process.argv.slice(2); const opt = k => { const i = rest.indexOf(`--${k}`); return i < 0 ? undefined : rest[i + 1]; };
  const dir = opt('dir') ?? DEFAULT_DIR, tag = opt('tag') ?? 'adhoc';
  if (command === 'note') { console.log(append(dir, { kind: 'note', tag, text: rest.filter(a => !a.startsWith('--') && a !== tag && a !== opt('dir')).join(' ') })); return; }
  if (command !== 'watch') throw new Error('Usage: measure.mjs watch --tag T [--interval 5] [--max 1800] [--idle-stop 60] | note --tag T TEXT');
  const interval = Number(opt('interval') ?? 5) * 1000, max = Number(opt('max') ?? 1800) * 1000, idleStop = Number(opt('idle-stop') ?? 60) * 1000;
  const start = Date.now(); let state = { seen: false, idleSince: null, stop: false }, previous = cpuTimes(); append(dir, { kind: 'start', tag, intervalMs: interval });
  while (Date.now() - start < max) {
    await new Promise(r => setTimeout(r, interval)); const { times, record } = sample(previous); previous = times; append(dir, { tag, ...record });
    state = idleStep(state, record, Date.now(), idleStop); if (state.stop) break;
  }
  console.log(append(dir, { kind: 'stop', tag, seconds: Math.round((Date.now() - start) / 1000) }));
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
