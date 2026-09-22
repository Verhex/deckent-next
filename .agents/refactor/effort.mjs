#!/usr/bin/env node
// A02/W0-3 development duration instrument. Host tooling only: not a product feature,
// not a second work-tracking authority beside the product execution ledger.
// Each slice is a private directory of immutable sequenced events (start, phase, pause, end).
// Time is accounted only between explicit events; a pause or an open tail is unknown, never
// active. Unknown time is reported, never estimated. Commit counts are not effort.
import { readFile, realpath, opendir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensure, instant } from './jev-context.mjs';
import { privateDirectory, writeEvent, readEvent } from './jev-journal.mjs';

export const KINDS = ['active', 'blocked', 'verification', 'rework'];
export const END_STATUSES = ['done', 'canceled', 'handed-off'];
export const BLOCKED_REASONS = ['owner-decision', 'external-review', 'dependency', 'environment', 'quota', 'other'];
const SLICE = /^[A-I](0[1-9]|[1-3][0-9]|40)-[a-z0-9]+(-[a-z0-9]+)*$/;
const MILESTONE = /^M[1-5]$/;
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 400;
const strings = a => Array.isArray(a) && a.every(text);
const here = dirname(fileURLToPath(import.meta.url));

export function validateConfig(c) {
  ensure(c && typeof c === 'object' && c.schemaVersion === 1 && text(c.journalRoot), 'EFFORT_CONFIG');
  ensure(Number.isSafeInteger(c.longIntervalMinutes) && c.longIntervalMinutes > 0 && Number.isSafeInteger(c.reportLimit) && c.reportLimit > 0, 'EFFORT_CONFIG');
  return c;
}
export function sliceDirectory(root, sliceId) { ensure(SLICE.test(sliceId), 'EFFORT_SLICE_ID'); return join(root, sliceId); }

async function listEvents(directory) {
  const names = [];
  try { for await (const e of await opendir(directory)) if (e.isFile() && /^\d{4}-(start|phase|pause|end)\.json$/.test(e.name)) names.push(e.name); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  names.sort();
  const events = [];
  for (const name of names) events.push(await readEvent(directory, name));
  events.forEach((ev, i) => ensure(ev.sequence === i + 1, 'EFFORT_SEQUENCE_GAP'));
  return events;
}
export async function events(root, sliceId) { return listEvents(sliceDirectory(root, sliceId)); }

function timestamp(opts, now) {
  const nowMs = instant(now); ensure(nowMs !== null, 'EFFORT_CLOCK');
  if (opts.at === undefined) return { at: now, atSource: 'clock' };
  const atMs = instant(opts.at); ensure(atMs !== null, 'EFFORT_AT');
  ensure(atMs <= nowMs, 'EFFORT_AT_FUTURE');
  return { at: opts.at, atSource: 'operator-supplied' };
}
function evidence(opts) { const refs = opts.evidenceRefs ?? []; ensure(strings(refs), 'EFFORT_EVIDENCE'); return refs; }
function note(opts) { ensure(opts.note === undefined || text(opts.note), 'EFFORT_NOTE'); return opts.note ?? null; }

export async function record(root, sliceId, type, opts, now = new Date().toISOString(), revision = gitRevision) {
  const directory = sliceDirectory(root, sliceId);
  const prior = await listEvents(directory);
  const last = prior.at(-1);
  ensure(type === 'start' ? prior.length === 0 : prior.length > 0, type === 'start' ? 'EFFORT_ALREADY_STARTED' : 'EFFORT_NOT_STARTED');
  ensure(!last || last.type !== 'end', 'EFFORT_ENDED');
  const { at, atSource } = timestamp(opts, now);
  ensure(!last || instant(at) >= instant(last.at), 'EFFORT_NOT_MONOTONIC');
  const base = { schemaVersion: 1, type, sliceId, sequence: prior.length + 1, at, atSource, note: note(opts), evidenceRefs: evidence(opts) };
  let data;
  if (type === 'start') {
    ensure(MILESTONE.test(opts.milestone) && text(opts.title) && text(opts.actor), 'EFFORT_START');
    ensure(opts.kind === undefined || KINDS.includes(opts.kind), 'EFFORT_KIND');
    data = { ...base, card: sliceId.slice(0, 3), milestone: opts.milestone, title: opts.title, actor: opts.actor, kind: opts.kind ?? null, revision: revision() };
  } else if (type === 'phase') {
    ensure(KINDS.includes(opts.kind), 'EFFORT_KIND');
    ensure(opts.kind === 'blocked' ? BLOCKED_REASONS.includes(opts.reason) : opts.reason === undefined, 'EFFORT_BLOCKED_REASON');
    data = { ...base, kind: opts.kind, reason: opts.reason ?? null };
  } else if (type === 'pause') {
    ensure(last.type !== 'pause', 'EFFORT_ALREADY_PAUSED');
    data = base;
  } else {
    ensure(type === 'end' && END_STATUSES.includes(opts.status), 'EFFORT_END_STATUS');
    data = { ...base, status: opts.status, revision: revision() };
  }
  const name = `${String(data.sequence).padStart(4, '0')}-${type}.json`;
  try { await writeEvent(directory, name, data, undefined); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('EFFORT_CONFLICT', { cause: e }); throw e; }
  return data;
}

export function summarize(list, config, now = new Date().toISOString()) {
  const start = list[0]; ensure(start?.type === 'start', 'EFFORT_NOT_STARTED');
  const nowMs = instant(now); ensure(nowMs !== null, 'EFFORT_CLOCK');
  const observedMs = Object.fromEntries(KINDS.map(k => [k, 0]));
  const blockedReasons = {}; const unknownGaps = []; const longIntervals = [];
  const longMs = config.longIntervalMinutes * 60_000;
  let kind = start.kind; let reason = null; let ended = null; let openSinceMs = null;
  for (let i = 0; i < list.length; i++) {
    const ev = list[i]; const next = list[i + 1];
    if (ev.type === 'phase') { kind = ev.kind; reason = ev.reason; }
    else if (ev.type === 'pause') { kind = null; reason = null; }
    else if (ev.type === 'end') { ended = ev; break; }
    const from = instant(ev.at);
    if (!next) { if (kind) openSinceMs = nowMs - from; else unknownGaps.push({ from: ev.at, to: null, ms: null, open: true }); break; }
    const ms = instant(next.at) - from;
    if (kind) {
      observedMs[kind] += ms;
      if (kind === 'blocked') blockedReasons[reason] = (blockedReasons[reason] ?? 0) + ms;
      if (ms > longMs) longIntervals.push({ kind, from: ev.at, to: next.at, ms, verdict: 'unverified-long; accounted as recorded' });
    } else unknownGaps.push({ from: ev.at, to: next.at, ms, open: false });
  }
  const unknownMs = unknownGaps.reduce((s, g) => s + (g.ms ?? 0), 0);
  const status = ended ? ended.status : list.at(-1).type === 'pause' ? 'paused' : kind ?? 'started';
  return { sliceId: start.sliceId, card: start.card, milestone: start.milestone, title: start.title, actor: start.actor, status,
    startedAt: start.at, endedAt: ended?.at ?? null, revisionAtStart: start.revision, revisionAtEnd: ended?.revision ?? null,
    observedMs, blockedReasons, unknownMs, unknownGaps, openSinceMs, longIntervals, events: list.length,
    operatorSuppliedTimestamps: list.filter(e => e.atSource === 'operator-supplied').length,
    evidenceRefs: list.flatMap(e => e.evidenceRefs) };
}

export async function report(root, config, filter = {}, now = new Date().toISOString()) {
  await privateDirectory(root);
  const ids = []; let truncated = false;
  for await (const e of await opendir(root)) {
    if (!e.isDirectory() || !SLICE.test(e.name)) continue;
    if (ids.length === config.reportLimit) { truncated = true; break; }
    ids.push(e.name);
  }
  ids.sort();
  const slices = [];
  for (const id of ids) {
    const s = summarize(await listEvents(join(root, id)), config, now);
    if (filter.milestone && s.milestone !== filter.milestone) continue;
    slices.push(s);
  }
  const milestones = {};
  for (const s of slices) {
    const m = milestones[s.milestone] ??= { slices: 0, ended: 0, observedMs: Object.fromEntries(KINDS.map(k => [k, 0])), unknownMs: 0, openSlices: 0 };
    m.slices++; if (s.endedAt) m.ended++; if (s.openSinceMs !== null) m.openSlices++;
    for (const k of KINDS) m.observedMs[k] += s.observedMs[k];
    m.unknownMs += s.unknownMs;
  }
  return { schemaVersion: 1, measuredAt: now, truncated, slices, milestones,
    basis: 'observed intervals between explicit recorded events only; unknown and open time are reported, never estimated; commit counts are not effort; forecast input, not acceptance' };
}

export function table(r) {
  const h = ms => (ms / 3_600_000).toFixed(2);
  const rows = r.slices.map(s => [s.sliceId, s.milestone, s.status, h(s.observedMs.active), h(s.observedMs.blocked), h(s.observedMs.verification), h(s.observedMs.rework), h(s.unknownMs), s.openSinceMs === null ? '-' : h(s.openSinceMs)]);
  const head = ['slice', 'ms', 'status', 'active_h', 'blocked_h', 'verify_h', 'rework_h', 'unknown_h', 'open_h'];
  const width = head.map((c, i) => Math.max(c.length, ...rows.map(row => row[i].length)));
  const line = row => row.map((c, i) => c.padEnd(width[i])).join('  ');
  return [line(head), ...rows.map(line), `basis: ${r.basis}`].join('\n');
}

function gitRevision() {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here, encoding: 'utf8', timeout: 5000 }).trim();
    const dirty = execFileSync('git', ['status', '--short'], { cwd: here, encoding: 'utf8', timeout: 5000 }).split('\n').filter(Boolean).length;
    return `${head}${dirty ? `+${dirty}dirty` : ''}`;
  } catch { return 'unavailable'; }
}
function parseArgs(rest) {
  const opts = { evidenceRefs: [] }; const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const value = rest[++i]; ensure(value !== undefined, 'EFFORT_USAGE');
    if (a === '--evidence') opts.evidenceRefs.push(value); else opts[a.slice(2)] = value;
  }
  return { opts, positional };
}
export async function main(args, env = process.env) {
  const [mode, ...rest] = args;
  const configPath = env.DECKENT_EFFORT_CONFIG || join(here, 'effort.config.json');
  const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
  const root = resolve(dirname(resolve(configPath)), config.journalRoot);
  const { opts, positional } = parseArgs(rest);
  if (mode === 'report') { ensure(positional.length === 0, 'EFFORT_USAGE'); const r = await report(root, config, { milestone: opts.milestone }); return opts.format === 'table' ? table(r) : r; }
  const [sliceId, second] = positional;
  if (mode === 'status') { ensure(sliceId && !second, 'EFFORT_USAGE'); return summarize(await events(root, sliceId), config); }
  ensure(['start', 'phase', 'pause', 'end'].includes(mode) && sliceId, 'EFFORT_USAGE');
  if (mode === 'phase') { ensure(second && positional.length === 2, 'EFFORT_USAGE'); opts.kind = second; }
  else if (mode === 'end') { ensure(second && positional.length === 2, 'EFFORT_USAGE'); opts.status = second; }
  else ensure(positional.length === 1, 'EFFORT_USAGE');
  return record(root, sliceId, mode, opts);
}
if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => { process.stdout.write((typeof result === 'string' ? result : JSON.stringify(result)) + '\n'); })
    .catch(e => { process.stderr.write(JSON.stringify({ error: /^EFFORT_[A-Z_]+$/.test(e.message) ? e.message : 'EFFORT_FAILED', detail: e.code ?? null }) + '\n'); process.exitCode = 1; });
}
