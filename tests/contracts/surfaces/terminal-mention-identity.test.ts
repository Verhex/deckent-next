import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_COMPOSER, mentionAt, mentionPaths, mentionText, reduceComposer, type ComposerKey, type ComposerState } from '#surfaces/core/terminal-composer/index.js';
import type { WorklineProps } from '#surfaces/core/terminal/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';

// Astra 2134 R3: the file picked in the `@` picker must reach the attachment port with its exact path. Keys go through the
// real Ink WorklineApp; the attachment port records what the service would be asked to attach.
const DOWN = '\u001b[B';
const views: Array<ReturnType<typeof mountWorkline>> = [];
afterEach(() => { for (const view of views.splice(0)) view.instance.unmount(); });

async function open(candidates: (query: string) => readonly string[], props: Partial<WorklineProps> = {}) {
  const queries: string[] = [], requested: string[][] = [];
  const view = mountWorkline({ mentionDelayMs: 0, ...props,
    mentions: async query => { queries.push(query); return candidates(query); },
    attachMentions: async (text, paths) => { requested.push([...paths]); return { content: text, notes: [] }; } });
  views.push(view);
  await until(() => view.stdout.text.includes('READY'), 'ready');
  const type = async (chunk: string) => { for (const char of chunk.startsWith('\u001b') ? [chunk] : [...chunk]) { view.stdin.write(char); await settle(5); } };
  return { ...view, queries, requested, type };
}

const FILES = ['src/a.ts', 'src/a b.ts', 'src/a.ts!', 'src/a', '@types/x.d.ts', 'src/@scope/x.ts', 'docs/my notes.md'];
const filtered = (query: string) => FILES.filter(path => path.toLowerCase().includes(query.toLowerCase()));

describe('a picked @file keeps its exact path to the attachment (real Ink workline)', () => {
  // Ported from the reviewer's negative (astra-2132-mentions.test.ts.txt): red before the fix with ['src/a'] and ['src/a.ts'].
  it.each(['src/a b.ts', 'src/a.ts!'])('Astra: selecting %s attaches exactly that candidate', async selected => {
    const view = await open(() => [selected]);
    await view.type('@src/a');
    await until(() => view.stdout.text.includes(selected), 'candidate shown');
    view.stdin.write('\t'); await settle(40);
    view.stdin.write('\r');
    await until(() => view.requested.length > 0, 'attachment requested');
    expect(view.requested).toEqual([[selected]]);
  });

  it('of two files sharing a prefix, the one picked is the one attached', async () => {
    for (const [moves, expected] of [['', 'src/a'], [DOWN, 'src/a b.ts']] as const) {
      const view = await open(() => ['src/a', 'src/a b.ts']);
      await view.type('@src/a');
      await until(() => view.stdout.text.includes('src/a b.ts'), 'both candidates shown');
      if (moves) await view.type(moves);
      await settle(20);
      await view.type('\t'); await settle(20);
      await view.type('\r');
      await until(() => view.requested.length > 0, 'attachment requested');
      expect(view.requested).toEqual([[expected]]);
    }
  });

  it('a name starting with @ is picked and attached exactly; an inner @ stays a plain path', async () => {
    const view = await open(filtered);
    await view.type('@x.d');
    await until(() => view.stdout.text.includes('@types/x.d.ts'), 'candidate shown');
    await view.type('\t'); await settle(20);
    await view.type('and @scope');
    await until(() => view.stdout.text.includes('> @src/@scope/x.ts'), 'plain candidate shown');
    await view.type('\t'); await settle(20);
    await until(() => view.stdout.text.includes('@"@types/x.d.ts" and @src/@scope/x.ts |'), 'both completed');
    await view.type('\r');
    await until(() => view.requested.length > 0, 'attachment requested');
    expect(view.requested).toEqual([['@types/x.d.ts', 'src/@scope/x.ts']]);
  });

  it('typed and picked mentions mix in one line: punctuation still ends a typed path, repeats are attached once', async () => {
    const view = await open(filtered);
    // A quoted query looks spaced names up while it is typed.
    await view.type('see @src/a.ts, then @"a b');
    await until(() => view.stdout.text.includes('> @"src/a b.ts"'), 'spaced candidate offered for a quoted query');
    await view.type('\t'); await settle(20);
    // A spaced name typed by hand is written in quotes; `\"` and `\\` are its only escapes.
    await view.type('and @"docs/my notes.md". also @src/a.ts again');
    await settle(20);
    await view.type('\r');
    await until(() => view.requested.length > 0, 'attachment requested');
    expect(view.requested).toEqual([['src/a.ts', 'src/a b.ts', 'docs/my notes.md']]);
  });

  it('Enter on a typed-out name that needs quotes completes it instead of sending a shortened path', async () => {
    const view = await open(filtered);
    await view.type('@src/a.ts!');
    await until(() => view.stdout.text.includes('> @"src/a.ts!"'), 'candidate shown');
    await view.type('\r');
    await until(() => view.stdout.text.includes('> @"src/a.ts!" |'), 'completed, not sent');
    expect(view.requested).toEqual([]);
    await view.type('\r');
    await until(() => view.requested.length > 0, 'attachment requested');
    expect(view.requested).toEqual([['src/a.ts!']]);
  });

  it('an @ inside a paste chip is never attached, next to a quoted mention', async () => {
    const view = await open(filtered);
    view.stdin.write('\u001b[200~line1 @"src/a b.ts" @src/a.ts\nline2\nline3\nline4\u001b[201~');
    await settle(30);
    await view.type(' see @"docs/my notes.md" ok\r');
    await until(() => view.requested.length > 0, 'attachment requested');
    expect(view.requested).toEqual([['docs/my notes.md']]);
  });
});

describe('mention syntax (one tokenizer for lookup, completion and submit)', () => {
  const NAMES = ['src/a.ts', 'src/a b.ts', 'src/a.ts!', 'src/a.ts.', '"quoted".md', 'say "hi".txt', 'back\\slash.ts', 'trail\\', '@types/x.d.ts',
    'src/@scope/x.ts', 'two  spaces', 'tab\tname', 'line\nbreak', 'paren)', 'ç ğ ı İ ö ş ü.md'];

  it('every name round-trips exactly through the written form; plain names stay unquoted', () => {
    for (const name of NAMES) expect(mentionPaths(`before ${mentionText(name)} after @"${'x'}"`), name).toEqual([name, 'x']);
    expect(['src/a.ts', 'src/@scope/x.ts', 'README.md'].map(mentionText)).toEqual(['@src/a.ts', '@src/@scope/x.ts', '@README.md']);
    expect(mentionText('src/a b.ts')).toBe('@"src/a b.ts"');
    expect(mentionText('say "hi".txt')).toBe('@"say \\"hi\\".txt"');
  });

  it('parses typed mentions: quotes, escapes, an unclosed quote, emails, @@ and chip spans', () => {
    expect(mentionPaths('see @"src/a b.ts", @src/a.ts, and @src/a.ts.')).toEqual(['src/a b.ts', 'src/a.ts']);
    expect(mentionPaths('@"a \\"q\\" \\\\b \\n"')).toEqual(['a "q" \\b \\n']);
    // An unclosed quote is read like a plain mention (and the service reports it), never swallowing later mentions.
    expect(mentionPaths('@"src/a b and @README.md')).toEqual(['"src/a', 'README.md']);
    expect(mentionPaths('mail a@"b c" and @@literal')).toEqual([]);
    const pastes = [{ chip: '[PASTE 5]', body: '@hidden' }];
    expect(mentionPaths('@"x [PASTE 5] y" @b', pastes)).toEqual(['b']);
  });

  it('the identity lives in the draft text, so history recall and Ctrl+C then Ctrl+Y keep it', () => {
    const context = { now: 0, busy: false, pasteChip: '[PASTE {lines}]' };
    const run = (keys: readonly ComposerKey[], from: ComposerState = EMPTY_COMPOSER) => keys.reduce<{ state: ComposerState; mentions: string[][] }>((acc, key) => {
      const next = reduceComposer(acc.state, key, context);
      return { state: next.state, mentions: [...acc.mentions, ...next.intents.flatMap(intent => intent.type === 'submit' ? [[...intent.mentions]] : [])] };
    }, { state: from, mentions: [] });
    const picked = run([...'see @src/a'].map(char => ({ type: 'text', text: char }) as const)).state;
    const completed = run([{ type: 'mentions', start: 4, query: 'src/a', items: ['src/a b.ts'] }, { type: 'tab' }], picked).state;
    expect(completed.text).toBe('see @"src/a b.ts" ');
    const sent = run([{ type: 'submit' }], completed);
    expect(run([{ type: 'move', to: 'up' }, { type: 'submit' }], sent.state).mentions).toEqual([['src/a b.ts']]);
    expect(run([{ type: 'interrupt' }, { type: 'yank' }, { type: 'submit' }], completed).mentions).toEqual([['src/a b.ts']]);
    expect(sent.mentions).toEqual([['src/a b.ts']]);
  });

  it('looks up a quoted query while it is typed and stops at the closing quote', () => {
    expect(mentionAt('see @"src/a b', 13)).toEqual({ start: 4, query: 'src/a b' });
    expect(mentionAt('see @"', 6)).toEqual({ start: 4, query: '' });
    expect(mentionAt('@"a b" c', 8)).toBeNull();
    expect(mentionAt('@"a b" c', 5)).toEqual({ start: 0, query: 'a b' });
    expect(mentionAt('@"x y @src/a', 12)).toEqual({ start: 6, query: 'src/a' });
    expect(mentionAt('see @src/ma', 11)).toEqual({ start: 4, query: 'src/ma' });
    expect(mentionAt('mail a@b.c', 10)).toBeNull();
    expect(mentionAt('@@literal', 9)).toBeNull();
  });
});
