import { describe, expect, it } from 'vitest';
import { clipboardRequest, copyableAnswers, createClipboardWriter, runCopyCommand, CLIPBOARD_LIMITS, type CopyLabels } from '#surfaces/core/terminal-host/index.js';
import { stepSpaceBefore } from '#surfaces/core/terminal-work/index.js';
import { notice, WORK_LEDGER_SCHEMA_VERSION, type WorkLedgerEntry } from '#surfaces/core/terminal-ledger/index.js';
import { terminalComposerLabels } from '#surfaces/core/terminal-labels/index.js';
import { WORKLINE_SLASH_COMMANDS, slashHelpText } from '#surfaces/core/terminal-kit/index.js';
import { t, snapshotKnownSecrets } from '#platform/index.js';
import { terminalConfigSchema, readTerminalResponseStyle, TERMINAL_RESPONSE_STYLES } from '#adapters/index.js';
import { renderAgentTurnSystemPrompt } from '#engine/index.js';
import { resolveProductLayout } from '#platform/index.js';

// T1 /copy [n] + spacing, T6 response style (alpha.54). Behaviour copied from Claude Code: /copy puts the latest answer on the clipboard; a new prompt stands apart.
const labels = (locale: 'en' | 'tr'): CopyLabels => ({ sent: t('tuicopy.sent', {}, locale), none: t('tuicopy.none', {}, locale), range: t('tuicopy.range', {}, locale),
  usage: t('tuicopy.usage', {}, locale), tooLarge: t('tuicopy.tooLarge', {}, locale), unavailable: t('tuicopy.unavailable', {}, locale) });
const decode = (sequence: string) => Buffer.from(sequence.slice(sequence.indexOf('52;c;') + 5, sequence.indexOf('\u0007')), 'base64').toString('utf8');
const history = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'one' }, { role: 'assistant', content: 'progress line' }, { role: 'tool', content: 'result' },
  { role: 'assistant', content: 'first answer' }, { role: 'user', content: 'two' }, { role: 'assistant', content: 'second answer, çğış' }];

describe('clipboard request (OSC 52)', () => {
  it('encodes the exact UTF-8 text; tmux wraps it in a DCS passthrough with ESC doubled; empty and over-cap texts are refused before any write', () => {
    const plain = clipboardRequest('merhaba çğış', {});
    expect(plain.ok && decode(plain.sequence)).toBe('merhaba çğış');
    const wrapped = clipboardRequest('x', { TMUX: '/tmp/tmux-1000/default,1,0' });
    expect(wrapped.ok && wrapped.sequence.startsWith('\u001bPtmux;\u001b\u001b]52;c;') && wrapped.sequence.endsWith('\u0007\u001b\\')).toBe(true);
    expect(clipboardRequest('', {})).toMatchObject({ ok: false, reason: 'empty' });
    expect(clipboardRequest('a'.repeat(CLIPBOARD_LIMITS.maxBytes + 1), {})).toMatchObject({ ok: false, reason: 'too-large', bytes: CLIPBOARD_LIMITS.maxBytes + 1 });
    expect(clipboardRequest('a'.repeat(CLIPBOARD_LIMITS.maxBytes), {}).ok).toBe(true);
  });

  it('writes only to a TTY: a pipe receives nothing', () => {
    const writes: string[] = [];
    expect(createClipboardWriter({ isTTY: false, write: (chunk: string) => { writes.push(chunk); return true; } } as never, {})('hi')).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(writes).toEqual([]);
    expect(createClipboardWriter({ isTTY: true, write: (chunk: string) => { writes.push(chunk); return true; } } as never, {})('hi')).toEqual({ ok: true, bytes: 2 });
    expect(writes).toHaveLength(1);
  });
});

describe('/copy [n]', () => {
  it('takes the last non-empty assistant message of each user turn, newest first (progress lines are not answers)', () => {
    expect(copyableAnswers(history)).toEqual(['second answer, çğış', 'first answer']);
    expect(copyableAnswers([{ role: 'user', content: 'q' }, { role: 'assistant', content: '  ' }])).toEqual([]);
  });

  it.each(['en', 'tr'] as const)('sends answer n, refuses a bad argument, an empty history, a range overrun, an oversize answer and a missing clipboard (%s)', locale => {
    const words = labels(locale), sent: string[] = [];
    const clipboard = (text: string) => { sent.push(text); return { ok: true as const, bytes: Buffer.byteLength(text) }; };
    expect(runCopyCommand('', history, clipboard, words)).toEqual({ level: 'info', text: expect.stringContaining('1') });
    expect(runCopyCommand('2', history, clipboard, words).level).toBe('info');
    expect(sent).toEqual(['second answer, çğış', 'first answer']);
    expect(runCopyCommand('3', history, clipboard, words)).toEqual({ level: 'error', text: words.range.replace(/\{max\}/g, '2') });
    for (const bad of ['0', '-1', 'x', '1 2', '10000']) expect(runCopyCommand(bad, history, clipboard, words)).toEqual({ level: 'error', text: words.usage });
    expect(runCopyCommand('', [{ role: 'system', content: 's' }], clipboard, words)).toEqual({ level: 'error', text: words.none });
    expect(runCopyCommand('', history, undefined, words)).toEqual({ level: 'error', text: words.unavailable });
    const big = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a'.repeat(CLIPBOARD_LIMITS.maxBytes + 1) }];
    const refused = runCopyCommand('', big, createClipboardWriter({ isTTY: true, write: () => true } as never, {}), words);
    expect(refused.level).toBe('error'); expect(refused.text).toContain(String(CLIPBOARD_LIMITS.maxBytes + 1)); expect(refused.text).toContain(String(CLIPBOARD_LIMITS.maxBytes));
  });

  it('masks a known secret exactly as the display does before anything reaches the clipboard', () => {
    const sent: string[] = [];
    const secret = 'sk-live-0123456789abcdef0123456789';
    runCopyCommand('', [{ role: 'user', content: 'q' }, { role: 'assistant', content: `the key is ${secret}` }], text => { sent.push(text); return { ok: true, bytes: 1 }; }, labels('en'), snapshotKnownSecrets([{ name: 'API_KEY', value: secret }]));
    expect(sent[0]).not.toContain(secret);
  });

  it('is a registered command with catalog words in both languages', () => {
    expect(WORKLINE_SLASH_COMMANDS.find(command => command.name === 'copy')).toMatchObject({ descriptionKey: 'tuicopy.slash.copy', argumentKey: 'tuicopy.slash.copyArgument' });
    for (const locale of ['en', 'tr'] as const) {
      const slash = terminalComposerLabels(locale).slash;
      expect(slash['tuicopy.slash.copy']).not.toBe('tuicopy.slash.copy');
      expect(slashHelpText(slash)).toContain(locale === 'en' ? '/copy [n]' : '/copy [sıra]');
    }
  });
});

const chat = (role: 'user' | 'assistant', text: string): WorkLedgerEntry => ({ schemaVersion: WORK_LEDGER_SCHEMA_VERSION, kind: 'chat', id: `${role}-${text}`, role, text });
describe('spacing above the person\'s message', () => {
  it('puts a blank line above a user row that follows anything, and none above the first row', () => {
    expect(stepSpaceBefore(undefined, chat('user', 'hi'))).toBe(false);
    expect(stepSpaceBefore(chat('assistant', 'answer'), chat('user', 'next'))).toBe(true);
    expect(stepSpaceBefore(notice('info', 'x'), chat('user', 'next'))).toBe(true);
    expect(stepSpaceBefore(chat('user', 'a'), chat('assistant', 'b'))).toBe(false);
    expect(stepSpaceBefore(chat('assistant', 'a'), chat('assistant', 'b'))).toBe(false);
  });
});

describe('response style (T6)', () => {
  const layout = resolveProductLayout({ projectRoot: '/p', root: '/p/.deckent/live-data' });
  const model = { providerId: 'vllm-local', providerVersion: 2, modelId: 'qwen', modelVersion: 3, nativeId: 'Qwen/Qwen3-Coder' };
  const prompt = (responseStyle?: ReturnType<typeof readTerminalResponseStyle>) => renderAgentTurnSystemPrompt({ projectRoot: '/p', layout, tools: [], model, language: 'en', ...(responseStyle ? { responseStyle } : {}) });

  it('is registry data: the default adds nothing, every other id adds exactly one instruction line, an unknown id is refused', () => {
    expect(TERMINAL_RESPONSE_STYLES[0]).toBe('standard');
    expect(terminalConfigSchema.parse({}).responseStyle).toBe('standard');
    expect(readTerminalResponseStyle({})).toEqual({ id: 'standard', instruction: null });
    expect(terminalConfigSchema.safeParse({ responseStyle: 'poetic' }).success).toBe(false);
    const standard = prompt(readTerminalResponseStyle({ terminal: {} }));
    expect(standard).toBe(prompt());
    for (const id of TERMINAL_RESPONSE_STYLES.filter(style => style !== 'standard')) {
      const style = readTerminalResponseStyle({ terminal: { responseStyle: id } });
      expect(style.instruction).toBeTruthy();
      expect(prompt(style).split('\n').filter(line => !standard.split('\n').includes(line))).toEqual([`- Response style (${id}, chosen by the person): ${style.instruction}`]);
    }
  });
});
