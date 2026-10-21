import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordFor, summarise, report, appendRecord, ENTRY_SKILL } from './skill-usage.mjs';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'skill-usage.mjs');
const now = new Date('2026-10-21T12:00:00.000Z');
const skillCall = (skill, extra = {}) => ({ hook_event_name: 'PostToolUse', tool_name: 'Skill', session_id: 's1', tool_input: { skill }, ...extra });

test('a model Skill call records name, via and input keys only', () => {
  const record = recordFor(skillCall('deckent-closure', { tool_input: { skill: 'deckent-closure', args: 'secret prompt text' } }), now);
  assert.deepEqual(record, { at: now.toISOString(), session: 's1', agent: 'main', kind: 'skill', via: 'model', name: 'deckent-closure', inputKeys: ['args', 'skill'] });
  assert.doesNotMatch(JSON.stringify(record), /secret prompt text/u);
});

test('a typed /skill expansion records the skill but never the prompt', () => {
  const record = recordFor({ hook_event_name: 'UserPromptExpansion', session_id: 's2', command_name: '/deckent-retro', prompt: '/deckent-retro private words' }, now);
  assert.equal(record.via, 'typed');
  assert.equal(record.name, 'deckent-retro');
  assert.deepEqual(record.inputKeys, ['command_name', 'hook_event_name', 'session_id']);
  assert.doesNotMatch(JSON.stringify(record), /private words/u);
});

test('edits mark the session; other events and odd names are not guessed', () => {
  assert.equal(recordFor({ hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: 's1', tool_input: { file_path: '/x/secret.md' } }, now).kind, 'edit');
  assert.doesNotMatch(JSON.stringify(recordFor({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/x/secret.md' } }, now)), /secret/u);
  assert.equal(recordFor({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, now), null);
  assert.equal(recordFor({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'x' } }, now), null);
  assert.equal(recordFor(skillCall('../../etc/passwd'), now).name, null);
  assert.equal(recordFor({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: 'not an object' }, now).name, null);
  assert.equal(recordFor(skillCall('superpowers:brainstorming', { agent_type: 'Explore' }), now).agent, 'Explore');
});

test('summary counts edit sessions that loaded the entry skill, per skill and per input shape', () => {
  const r = (o) => ({ at: now.toISOString(), agent: 'main', ...o });
  const summary = summarise([
    r({ session: 'a', kind: 'edit' }), r({ session: 'a', kind: 'skill', via: 'model', name: ENTRY_SKILL, inputKeys: ['skill'] }),
    r({ session: 'b', kind: 'edit' }),
    r({ session: 'c', kind: 'skill', via: 'typed', name: 'deckent-grill', inputKeys: ['command_name'] }),
    r({ session: 'c', kind: 'skill', via: 'model', name: null, inputKeys: ['skill'] }),
    null,
  ]);
  assert.equal(summary.sessions, 3);
  assert.equal(summary.sessionsWithSkill, 2);
  assert.equal(summary.sessionsWithEdits, 2);
  assert.equal(summary.editSessionsWithEntrySkill, 1);
  assert.deepEqual(summary.skills[ENTRY_SKILL], { model: 1, typed: 0, sessions: 1 });
  assert.deepEqual(summary.skills['deckent-grill'], { model: 0, typed: 1, sessions: 1 });
  assert.deepEqual(summary.skills['(unknown)'], { model: 1, typed: 0, sessions: 1 });
  assert.deepEqual(summary.inputShapes, { 'model:skill': 2, 'typed:command_name': 1 });
  assert.equal(summary.unparsedLines, 1);
});

test('records land in a private per-day file and the report reads only the requested window', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-usage-'));
  appendRecord(root, recordFor(skillCall(ENTRY_SKILL), now));
  appendRecord(root, recordFor({ hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: 's1' }, now));
  const dir = join(root, '.deckent', 'host', 'skill-usage');
  assert.deepEqual(readdirSync(dir), ['2026-10-21.jsonl']);
  assert.equal(statSync(join(dir, '2026-10-21.jsonl')).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  writeFileSync(join(dir, '2026-10-01.jsonl'), `${JSON.stringify({ session: 'old', kind: 'edit' })}\nnot json\n`);
  const week = report(root, 7, now);
  assert.equal(week.files, 1);
  assert.equal(week.editSessionsWithEntrySkill, 1);
  assert.equal(week.unparsedLines, 0);
  const month = report(root, 30, now);
  assert.equal(month.files, 2);
  assert.equal(month.sessions, 2);
  assert.equal(month.unparsedLines, 1);
});

test('the hook prints {} and exits 0 on valid, broken and unwritable input', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-usage-'));
  const run = (input, at = root) => execFileSync('node', [script, 'hook', '--root', at], { input, encoding: 'utf8' });
  assert.equal(run(JSON.stringify(skillCall('deckent-observe'))), '{}');
  assert.match(readFileSync(join(root, '.deckent', 'host', 'skill-usage', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8'), /deckent-observe/u);
  assert.equal(run('{not json'), '{}');
  const blocked = join(root, 'blocked');
  mkdirSync(blocked);
  writeFileSync(join(blocked, '.deckent'), 'a file where a directory is expected');
  assert.equal(run(JSON.stringify(skillCall('deckent-observe')), blocked), '{}');
});

test('report refuses an out-of-range window', () => {
  assert.throws(() => execFileSync('node', [script, 'report', '--days', '0'], { encoding: 'utf8', stdio: 'pipe' }), /--days must be/u);
});
