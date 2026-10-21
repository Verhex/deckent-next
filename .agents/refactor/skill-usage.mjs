#!/usr/bin/env node
// Skill usage measurement for the development host (owner 2026-10-18 decision 6, 2026-10-21 decision 1).
// Host tooling only: never part of the product, never a product authority, never a gate.
//
// Usage:
//   node skill-usage.mjs hook [--root <checkout>]        one Claude Code hook event as JSON on stdin
//   node skill-usage.mjs report [--days N] [--root ...]  read-only JSON summary of the last N days (default 7)
//
// The hook only appends one line to <root>/.deckent/host/skill-usage/<UTC date>.jsonl and prints `{}`: it adds
// no context, never blocks, and exits 0 even on error (fail-open). Recorded fields: time, session id, agent type,
// event kind and skill name. Prompt text, tool arguments other than the skill name, and file paths are never kept.
// Recognised events: PostToolUse on the Skill tool (model invocation), UserPromptExpansion (owner typed /skill),
// PostToolUse on Edit/Write/NotebookEdit (marks a session that changed files). The hook docs do not spell out the
// payloads; the schemas inside Claude Code 2.1.306 (read 2026-10-21) are Skill `{ skill, args? }` and
// UserPromptExpansion `{ expansion_type, command_name, command_args, command_source?, prompt }`. Each skill record
// also keeps the sorted input key names, so a later payload change shows up in the report instead of silently.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENTRY_SKILL = 'deckent-next-refactor';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/u;
const MAX_DAYS = 90;

const usageDir = (root) => join(resolve(root), '.deckent', 'host', 'skill-usage');
const keysOf = (value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
/** The first string field that looks like a skill name; anything else stays unknown rather than guessed. */
function skillName(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const name = candidate.trim().replace(/^\//u, '').split(/\s/u)[0];
    if (NAME.test(name)) return name;
  }
  return null;
}

/** Maps one hook payload to a record, or null when the event is not measured. Pure; `now` is injected. */
export function recordFor(input, now) {
  const event = input?.hook_event_name;
  const tool = input?.tool_name;
  const base = { at: now.toISOString(), session: typeof input?.session_id === 'string' ? input.session_id : null,
    agent: typeof input?.agent_type === 'string' ? input.agent_type : 'main' };
  if (event === 'PostToolUse' && tool === 'Skill') {
    const ti = input.tool_input;
    return { ...base, kind: 'skill', via: 'model', name: skillName(ti?.skill, ti?.name, ti?.command), inputKeys: keysOf(ti) };
  }
  if (event === 'UserPromptExpansion') {
    return { ...base, kind: 'skill', via: 'typed', name: skillName(input.skill_name, input.command_name, input.skill, input.name, input.command),
      inputKeys: keysOf(input).filter(key => !['prompt', 'transcript_path', 'cwd'].includes(key)) };
  }
  if (event === 'PostToolUse' && EDIT_TOOLS.has(tool)) return { ...base, kind: 'edit' };
  return null;
}

export function appendRecord(root, record) {
  const dir = usageDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${record.at.slice(0, 10)}.jsonl`);
  const fresh = !existsSync(file);
  appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  if (fresh) chmodSync(file, 0o600);
}

/** Summarises records (already parsed). Pure; percentages are left to the reader, counts stay exact. */
export function summarise(records) {
  const sessions = new Map();
  const skills = new Map();
  const shapes = new Map();
  let unparsed = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object') { unparsed++; continue; }
    const id = record.session ?? 'unknown';
    const session = sessions.get(id) ?? { edited: false, skills: new Set() };
    sessions.set(id, session);
    if (record.kind === 'edit') session.edited = true;
    if (record.kind !== 'skill') continue;
    const name = record.name ?? '(unknown)';
    session.skills.add(name);
    const entry = skills.get(name) ?? { model: 0, typed: 0, sessions: new Set() };
    entry[record.via === 'typed' ? 'typed' : 'model']++;
    entry.sessions.add(id);
    skills.set(name, entry);
    const shape = `${record.via}:${(record.inputKeys ?? []).join(',')}`;
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  const all = [...sessions.values()];
  const edited = all.filter(s => s.edited);
  return {
    sessions: all.length,
    sessionsWithSkill: all.filter(s => s.skills.size).length,
    sessionsWithEdits: edited.length,
    editSessionsWithEntrySkill: edited.filter(s => s.skills.has(ENTRY_SKILL)).length,
    skills: Object.fromEntries([...skills.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([name, e]) => [name, { model: e.model, typed: e.typed, sessions: e.sessions.size }])),
    inputShapes: Object.fromEntries([...shapes.entries()].sort()),
    unparsedLines: unparsed,
  };
}

export function report(root, days, now) {
  const dir = usageDir(root);
  const wanted = new Set(Array.from({ length: days }, (_, i) => new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10)));
  const files = existsSync(dir) ? readdirSync(dir).filter(f => wanted.has(f.replace(/\.jsonl$/u, ''))).sort() : [];
  const records = files.flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } }));
  return { days, from: [...wanted].sort()[0], to: now.toISOString().slice(0, 10), files: files.length, ...summarise(records),
    note: 'Counts of recorded hook events only (Claude Code on this host). Codex, Cursor and Docker workers are not measured; a missing record is not proof that a skill was unused.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const opt = (name, fallback) => { const i = rest.indexOf(name); return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback; };
  const root = opt('--root', process.cwd());
  if (command === 'hook') {
    try {
      const raw = readFileSync(0, 'utf8');
      const record = recordFor(raw.trim() ? JSON.parse(raw) : {}, new Date());
      if (record) appendRecord(root, record);
    } catch { /* fail-open: measurement never disturbs work */ }
    process.stdout.write('{}');
    process.exit(0);
  }
  if (command === 'report') {
    const days = Number(opt('--days', '7'));
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) { process.stderr.write(`--days must be an integer from 1 to ${MAX_DAYS}\n`); process.exit(2); }
    process.stdout.write(`${JSON.stringify(report(root, days, new Date()), null, 2)}\n`);
    process.exit(0);
  }
  process.stderr.write('usage: node skill-usage.mjs hook [--root DIR] | report [--days N] [--root DIR]\n');
  process.exit(2);
}
