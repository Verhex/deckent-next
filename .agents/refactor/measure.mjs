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
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }); } catch { return ''; } };
function otherLoad() {
  const ps = run('ps', ['-eo', 'args']).split('\n');
  return { codexLanes: ps.filter(a => /codex exec/.test(a) && !/vendor/.test(a)).length, vitest: ps.filter(a => /^node .*vitest/.test(a)).length,
    vllm: run('docker', ['ps', '--filter', 'name=vllm', '-q']).trim().split('\n').filter(Boolean).length };
}
export function sample(previous) {
  const ids = new Set(run('docker', ['ps', '--filter', 'label=deckent.request', '--format', '{{.ID}}']).split('\n').filter(Boolean));
  const workers = ids.size ? parseStats(run('docker', ['stats', '--no-stream', '--format', '{{json .}}']).split('\n'), ids) : [];
  const now = cpuTimes(), cpuBusyPct = previous ? Math.round(1000 * (now.busy - previous.busy) / Math.max(1, now.all - previous.all)) / 10 : null;
  return { times: now, record: { kind: 'sample', workers: workers.length, workerCpuPct: Math.round(workers.reduce((s, w) => s + w.cpuPct, 0)),
    workerMemMiB: workers.reduce((s, w) => s + w.memMiB, 0), host: { cpus: os.cpus().length, cpuBusyPct, load1: os.loadavg()[0], memUsedMiB: Math.round((os.totalmem() - os.freemem()) / 1048576) },
    other: otherLoad(), perWorker: workers } };
}
async function main() {
  const [command, ...rest] = process.argv.slice(2); const opt = k => { const i = rest.indexOf(`--${k}`); return i < 0 ? undefined : rest[i + 1]; };
  const dir = opt('dir') ?? DEFAULT_DIR, tag = opt('tag') ?? 'adhoc';
  if (command === 'note') { console.log(append(dir, { kind: 'note', tag, text: rest.filter(a => !a.startsWith('--') && a !== tag && a !== opt('dir')).join(' ') })); return; }
  if (command !== 'watch') throw new Error('Usage: measure.mjs watch --tag T [--interval 5] [--max 1800] [--idle-stop 60] | note --tag T TEXT');
  const interval = Number(opt('interval') ?? 5) * 1000, max = Number(opt('max') ?? 1800) * 1000, idleStop = Number(opt('idle-stop') ?? 60) * 1000;
  const start = Date.now(); let seen = false, idleSince = null, previous = cpuTimes(); append(dir, { kind: 'start', tag, intervalMs: interval });
  while (Date.now() - start < max) {
    await new Promise(r => setTimeout(r, interval)); const { times, record } = sample(previous); previous = times; append(dir, { tag, ...record });
    if (record.workers) { seen = true; idleSince = null; } else if (seen) { idleSince ??= Date.now(); if (Date.now() - idleSince >= idleStop) break; }
  }
  console.log(append(dir, { kind: 'stop', tag, seconds: Math.round((Date.now() - start) / 1000) }));
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
