import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfiguredTerminalSessions } from '#composition/core/cli/index.js';
import { getConfigKnownSecrets, loadConfig, prepareProductDirectory } from '#platform/index.js';
import { bindSessionScope, type AgentChatMessage } from '#surfaces/core/terminal-kit/index.js';
import { terminalRenderLabels, terminalSessionLabels } from '#surfaces/core/terminal-labels/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKLINE_TEST_LABELS, mountWorkline, settle, until } from '../support/workline-harness.js';
import { resumedHistoryEntries, RESUME_SHOWN_MESSAGES, RESUME_USER_TEXT_CHARS } from '#surfaces/core/terminal/index.js';

const user = (content: string) => ({ role: 'user' as const, content });
const assistant = (content: string) => ({ role: 'assistant' as const, content, toolCalls: [] });
const tool = (content: string) => ({ role: 'tool' as const, toolCallId: 'c', name: 'read_file', content });
const texts = (rows: ReturnType<typeof resumedHistoryEntries>) => rows.map(row => row.kind === 'chat' ? `${row.role}:${row.text}` : row.kind === 'notice' ? `notice:${row.text}` : row.kind);

describe('resumed conversation replay (TERM-UX-1 b)', () => {
  it('replays user and assistant text in order and folds tool results into one count line', () => {
    const rows = resumedHistoryEntries([user('hello'), assistant(''), tool('a'), tool('b'), assistant('done')]);
    expect(texts(rows)).toEqual(['user:hello', 'notice:· 2 tool', 'assistant:done']);
  });
  it('does not replay attached file bodies or unbounded pastes, and marks a compaction summary', () => {
    const rows = resumedHistoryEntries([user(`read this\n\n--- attached file a.ts (3 bytes) ---\nSECRET-BODY\n--- end of a.ts ---`),
      user('x'.repeat(RESUME_USER_TEXT_CHARS + 50)), user('[Deckent context summary: replaces 4 earlier messages. ...]')]);
    const shown = texts(rows);
    expect(shown[0]).toBe('user:read this');
    expect(shown[1]!.length).toBeLessThan(RESUME_USER_TEXT_CHARS + 20);
    expect(shown[2]).toBe('notice:· summary');
    expect(shown.join('\n')).not.toContain('SECRET-BODY');
  });
  it('shows only the newest bounded part and says how much was left out', () => {
    const many = Array.from({ length: RESUME_SHOWN_MESSAGES + 6 }, (_, index) => index % 2 ? assistant(`a${index}`) : user(`u${index}`));
    const rows = texts(resumedHistoryEntries(many));
    expect(rows[0]).toBe('notice:… 6');
    expect(rows).toHaveLength(RESUME_SHOWN_MESSAGES + 1);
    expect(rows.at(-1)).toBe(`assistant:a${RESUME_SHOWN_MESSAGES + 5}`);
  });
  it('uses catalog templates when provided', () => {
    const rows = texts(resumedHistoryEntries([user('q'), tool('r')], { omitted: 'O{count}', toolResults: 'T{count}', summarized: 'S' }));
    expect(rows).toEqual(['user:q', 'notice:T1']);
  });
});

const views: Array<ReturnType<typeof mountWorkline>> = [];
afterEach(() => { for (const view of views.splice(0)) view.instance.unmount(); });

describe('/resume through the real workline (TERM-UX-1 b)', () => {
  it('prints the resumed conversation after the notice and sends it with the next turn', async () => {
    const earlier = { sessionId: '11111111-2222-4333-8444-555555555555', updatedAtMs: 0, messages: 2, preview: 'old question' };
    const sent: (readonly { role: string; content: string }[])[] = [];
    const streamTurn = async function* (messages: readonly { role: string; content: string }[]) {
      sent.push(messages); yield { kind: 'text' as const, text: 'fresh' }; yield { kind: 'done' as const, finish: 'stop' as const, note: null };
    };
    const view = mountWorkline({ completeTurn: async () => 'unused', streamTurn: streamTurn as never, historyMessages: 20,
      sessions: { async save() {}, async list() { return [earlier]; }, async load() { return [user('old question'), assistant('OLD-ANSWER-TEXT')]; } } });
    views.push(view);
    await until(() => view.stdout.text.includes('READY'), 'ready');
    view.stdin.write(`/resume ${earlier.sessionId}\r`); await until(() => view.stdout.text.includes('RESUMED 2 11111111'), 'resumed');
    await until(() => view.stdout.text.includes('OLD-ANSWER-TEXT'), 'earlier answer printed');
    await settle(20);
    view.stdin.write('next\r'); await until(() => sent.length === 1, 'turn sent');
    expect(sent[0]!.map(message => message.content)).toEqual(['SYSTEM', 'old question', 'OLD-ANSWER-TEXT', 'next']);
  });
});

// The replay and the /context split recognize the engine's summary message and the composition's attached-file blocks by their text:
// these tests keep that coupling honest (a changed marker would otherwise leak a summary or an attachment body silently).
describe('markers shared with the engine and the mention composition', () => {
  it('a real compaction message replays as one marker and a real attached-file block is neither replayed nor counted as typed text', async () => {
    const { planAgentCompaction, renderAgentCompaction } = await import('#engine/index.js');
    const { attachTerminalMentions } = await import('#composition/core/terminal-chat/index.js');
    const { contextBreakdown } = await import('#surfaces/core/terminal-render/index.js');
    const older = Array.from({ length: 14 }, (_, index) => index % 2 ? assistant(`a${index}`) : user(`u${index}`));
    const plan = planAgentCompaction(older)!;
    const summary = renderAgentCompaction(plan, { objective: 'goal', findings: [], decisions: [], unresolved: [], nextActions: [], inspectedAreas: [] });
    const excerpt = renderAgentCompaction(plan, null);
    expect(texts(resumedHistoryEntries([summary, excerpt]))).toEqual(['notice:· summary', 'notice:· summary']);
    const attached = await attachTerminalMentions({ projectRoot: '/p', scopeId: 's', text: 'look', paths: ['a.ts'], options: {} }, {
      find: async () => ({ schemaVersion: 1, paths: [], truncated: false, incomplete: false }),
      attach: async () => ({ schemaVersion: 1, path: 'a.ts', status: 'attached', content: 'BODY-OF-A', bytes: 9, totalBytes: 9, truncated: false }) });
    const message = user(attached.content);
    expect(texts(resumedHistoryEntries([message]))).toEqual(['user:look']);
    expect(contextBreakdown([message]).attachments).toBeGreaterThan(9);
  });
});


it.skipIf(process.platform === 'win32').each(['ordinary', 'known-control'] as const)('S06 %s real config snapshot → full store preview/replay → selected Workline surfaces preserves loaded code units', async variant => {
  const root = await mkdtemp(join(tmpdir(), 'dn-s06-producer-'));
  const canary = `fictitious-s06-${variant === 'known-control' ? '\u0001' : ''}known-value-0123456789`;
  const csiSplit = variant === 'known-control' ? canary : `${canary.slice(0, 14)}\u001b[31m${canary.slice(14)}`;
  const controlSplit = variant === 'known-control' ? canary : `${canary.slice(0, 14)}\u0002${canary.slice(14)}`;
  const id = 'aaaaaaaa-1111-4111-8111-111111111111';
  const other = 'bbbbbbbb-2222-4222-8222-222222222222';
  try {
    await mkdir(join(root, '.deckent'));
    await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ projectName: '$DECK:S06_TEST', layout: { root: join(root, 'data') }, terminal: { persistHistory: true } }));
    const options = { env: { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, '.config'), DECKENT_GLOBAL_HOME: join(root, 'global'), S06_TEST: canary } };
    const store = (await openConfiguredTerminalSessions(root, options))!;
    const config = await loadConfig(root, options);
    const known = getConfigKnownSecrets(config);
    expect(JSON.stringify(known)).toBe('{}');
    const first = user(`${'x'.repeat(110)}${csiSplit} preview \u202e`);
    const second = user(`${'x'.repeat(590)}${controlSplit} cutoff \`a\u200bb\` \u202e`);
    const answer = assistant(`Türkçe می\u200cروم 👩\u200d💻 ❤️ <U+202E>\n\`a\u200bb\` \u202e \n\`\`\`sh\necho "tag\u{e0041}" ${canary} ${csiSplit} ${controlSplit}\n\`\`\`\n\u001b]52;c;ZmljdGl0aW91cw==\u0007DONE`);
    const messages = [first, second, answer];
    await store.save({ schemaVersion: 1, sessionId: other, scopeId: 'scope', updatedAtMs: 2, messages: [user('other')] });
    await store.save({ schemaVersion: 1, sessionId: id, scopeId: 'scope', updatedAtMs: 1, messages });
    // A historically edited snapshot supplies untrusted raw loaded units; the production save scrub is not bypassed by product code.
    const fixtureFile = join(await prepareProductDirectory(config.productLayout, 'terminalSessions'), `${id}.json`);
    const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'));
    fixture.messages = messages;
    await writeFile(fixtureFile, JSON.stringify(fixture));
    const summaries = await store.list('scope');
    expect.soft(summaries[1]!.preview).toContain('‹secret:S0');
    expect.soft(summaries[1]!.preview).not.toContain('fictitious');
    const loaded = (await store.load('scope', id))!;
    // The S06 list display seam changes no raw stored payload; this is loaded evidence, not pre-store original custody.
    expect(loaded[0]!.content).toBe(first.content);
    const before = loaded.map(message => createHash('sha256').update(Buffer.from(message.content, 'utf16le')).digest('hex'));
    const bound = bindSessionScope(store, 'scope');
    for (const locale of ['en', 'tr'] as const) {
      await writeFile(fixtureFile, JSON.stringify(fixture));
      const frames: string[] = [];
      let sent: readonly { content: string }[] = [];
      const view = mountWorkline({ knownSecrets: known, sessions: { ...bound, load: async target => target === id ? loaded : bound.load(target) },
        labels: { ...WORKLINE_TEST_LABELS, render: { ...WORKLINE_TEST_LABELS.render, hiddenCount: terminalRenderLabels(locale).hiddenCount },
          sessions: { ...WORKLINE_TEST_LABELS.sessions!, hiddenCount: terminalSessionLabels(locale).hiddenCount } },
        completeTurn: async () => 'unused', streamTurn: async function* (history: readonly AgentChatMessage[]) {
          sent = history; yield { kind: 'text' as const, text: 'fresh' }; yield { kind: 'done' as const, finish: 'stop' as const, note: null };
        } }, 200, { onFrame: frame => frames.push(frame) });
      views.push(view);
      await until(() => view.stdout.text.includes('READY'), 'ready');
      view.stdin.write('/resume\r');
      await until(() => view.stdout.frame.includes('> SESSION 1 bbbbbbbb'), 'actual store picker');
      await view.instance.waitUntilRenderFlush(); view.stdin.write('\u001b[B');
      await until(() => view.stdout.frame.includes('> SESSION 2 aaaaaaaa'), 'selected exact session');
      await view.instance.waitUntilRenderFlush(); view.stdin.write('\r');
      await until(() => view.stdout.text.includes('DONE') && view.stdout.text.includes('tag<U+E0041>'), 'actual resumed assistant code');
      const frame = view.stdout.frame;
      expect(frame).toContain('a<U+200B>b');
      expect(frame).toContain('Türkçe می\u200cروم 👩\u200d💻 ❤️');
      expect(frame).toContain(locale === 'en' ? '3 hidden characters' : '3 gizli karakter');
      expect.soft(frame).not.toContain(canary);
      expect.soft(frame).not.toContain('fictitious-s06');
      expect.soft(frame).not.toContain('known-value-0123456789');
      expect.soft(frame).not.toContain('[31m');
      expect(frame).not.toContain(']52;');
      await view.instance.waitUntilRenderFlush(); view.stdin.write('next\r');
      await until(() => sent.length > 0, 'loaded history next turn');
      await until(() => view.stdout.frame.includes('fresh') && view.stdout.frame.includes('READY'), 'turn settled before next locale fixture');
      expect(sent.slice(1, 4)).toEqual(loaded);
      expect(sent[1]).toBe(loaded[0]); expect(sent[3]).toBe(loaded[2]);
      const after = loaded.map(message => createHash('sha256').update(Buffer.from(message.content, 'utf16le')).digest('hex'));
      expect(after).toEqual(before);
      console.info('s06-source-surface-evidence', JSON.stringify({ locale, variant, source: 'openConfiguredTerminalSessions/loadConfig/bindSessionScope/Workline',
        loadedUtf16Hashes: before, afterUtf16Hashes: after, projectionFrame: frame, pickerFrames: frames.filter(value => value.includes('> SESSION')).slice(-2) }));
      view.instance.unmount();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
