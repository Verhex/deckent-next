import { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useInput, useWindowSize } from 'ink';
import { t, terminalSafeText, type Locale } from '#platform/index.js';
import { cardCopyLabels, cliCardGate, type CliCardIo } from '#surfaces/core/cli-human/index.js';
import { fillTemplate, truncateEnd, useSpinnerGlyph, wrapCells } from '#surfaces/core/terminal-render/index.js';
import { isCardCopyKey, type CardCopy } from '#surfaces/core/terminal-window/index.js';
import { streamCardCopy } from '#surfaces/core/terminal-host/index.js';
export type OnboardingQuestion = Readonly<{ title: string; body: readonly string[]; choices: readonly Readonly<{ id: string; label: string; disabled?: boolean }>[];
  step: number; total: number; initial?: string | null; text?: boolean }>;
export type QuestionAnswer = Readonly<{ id: string; text?: string }>;
export type CardWork = 'applying' | 'preparing';
/** How long the copy result stays on the key line. */
const COPIED_MS = 4_000;
/** `finish` takes the one answer and says whether its apply now runs behind this card: the card then shows that it is applying and every key is
 * visibly not used (BeUser walk19R: never a silent drop, and never kept for the next card, which is another question). */
export function OnboardingQuestionView({ question, locale, finish, copy = null, work = 'applying' }: { readonly question: OnboardingQuestion; readonly locale: Locale; readonly finish: (answer: QuestionAnswer) => boolean;
  /** What the card says while that work runs: a write (`applying`) or a preview or check that writes nothing (`preparing`). */ readonly work?: CardWork;
  /** Ctrl+Y sends the step's title and body (never the typed text) through the host's clipboard writer; absent off a TTY. */ readonly copy?: CardCopy | null }) {
  const initial = question.initial === null ? -1 : Math.max(0, question.choices.findIndex(row => row.id === question.initial));
  const [at, select] = useState(initial), [text, setText] = useState(''), [empty, setEmpty] = useState(false), [bodyAt, scroll] = useState(0), done = useRef(false), busy = useRef(false);
  const [applying, setApplying] = useState(false), [refused, setRefused] = useState(false), spinner = useSpinnerGlyph(applying);
  const size = useWindowSize(), width = Math.max(8, size.columns - 4), height = Math.max(1, Math.min(question.choices.length || 1, Math.floor(size.rows / 3)));
  const bodyHeight = Math.max(1, size.rows - height - 9 - (question.text ? 3 : 0)), bodyLines = question.body.flatMap(line => wrapCells(terminalSafeText(line), width));
  const send = (answer: QuestionAnswer) => { if (done.current) return; done.current = true; if (finish(answer)) { busy.current = true; setApplying(true); } };
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => { if (copied === null) return undefined; const timer = setTimeout(() => setCopied(null), COPIED_MS); return () => clearTimeout(timer); }, [copied]);
  useInput((input, key) => {
    if (done.current) { if (busy.current) setRefused(true); return; }
    if (input.length > 1 && !question.text) return;
    if (copy && isCardCopyKey(input, key)) {
      const text = terminalSafeText([question.title, ...question.body].join('\n')), result = copy.write(text);
      setCopied(result.ok ? fillTemplate(copy.labels.sent, { count: [...text].length }) : result.reason === 'too-large' ? fillTemplate(copy.labels.tooLarge, { bytes: result.bytes, max: copy.maxBytes }) : copy.labels.unavailable);
      return;
    }
    if (key.escape) { send({ id: 'later' }); return; }
    if (key.ctrl && input === 'c') { send({ id: 'exit' }); return; }
    if (key.pageUp) { scroll(value => Math.max(0, value - bodyHeight)); return; }
    if (key.pageDown) { scroll(value => Math.min(Math.max(0, bodyLines.length - bodyHeight), value + bodyHeight)); return; }
    if (key.upArrow) select(value => Math.max(0, value - 1));
    else if (key.downArrow) select(value => Math.min(question.choices.length - 1, value + 1));
    else if (key.return) {
      if (question.text) { if (text.trim()) send({ id: 'submit', text: text.trim() }); else setEmpty(true); }
      else if (question.choices[at] && !question.choices[at]!.disabled) send({ id: question.choices[at]!.id });
    } else if (question.text && (key.backspace || key.delete)) setText(value => Array.from(value).slice(0, -1).join(''));
    else if (question.text && !key.ctrl && !key.meta && !input.includes('\u001b')) setText(value => (value + terminalSafeText(input)).slice(0, 4096));
  });
  const start = Math.max(0, at - height + 1), body = bodyLines.slice(Math.min(bodyAt, Math.max(0, bodyLines.length - bodyHeight)), bodyAt + bodyHeight);
  return <Box flexDirection="column" paddingX={1} paddingY={1}>
    <Text>{t('onboarding.session.step', { n: question.step, total: question.total }, locale)}</Text>
    <Text> </Text><Text bold>{terminalSafeText(question.title)}</Text><Text> </Text>
    {body.map((line, index) => <Text key={index}>{truncateEnd(terminalSafeText(line), width, '…')}</Text>)}
    <Text>{bodyLines.length > bodyHeight ? t('onboarding.session.scroll', {}, locale) : ' '}</Text>
    {question.text ? <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1}><Text>{'> '}{truncateEnd(text || t('onboarding.firstTask.freeText', {}, locale), Math.max(1, width - 6), '…')}{text ? '|' : ''}</Text></Box>
      <Text>{empty && !text.trim() ? t('onboarding.firstTask.empty', {}, locale) : ' '}</Text>
    </Box>
      : question.choices.slice(start, start + height).map((row, index) => <Text key={row.id}>{at === start + index ? '> ' : '  '}{truncateEnd(terminalSafeText(row.label), width - 2, '…')}</Text>)}
    <Text> </Text>{applying ? <Text>{spinner} {work === 'preparing' ? t('onboarding.session.preparing', {}, locale) : t('onboarding.session.applying', {}, locale)}{refused ? ` · ${t('onboarding.session.busyKey', {}, locale)}` : ''}</Text>
      : <Text>{t('onboarding.session.continue', {}, locale)} · {t('onboarding.session.later', {}, locale)}{copy ? ` · ${copied ?? copy.labels.hint}` : ''}</Text>}
  </Box>;
}
/**
 * A single input owner; unmounted before a foreground owner takes the real terminal. One live card region (walk19R): the card's frame is erased
 * when it closes, so the next card draws where it was instead of under it; what was on the terminal before the card stays. `apply` (optional)
 * runs a chosen answer (not Later or exit) while this card stays up and says it is applying; its failure rejects after the card is gone.
 */
export async function askOnboardingQuestion(question: OnboardingQuestion, io: CliCardIo, apply?: (answer: QuestionAnswer) => Promise<void>, work: CardWork = 'applying'): Promise<QuestionAnswer> {
  if (io.signal?.aborted) return { id: 'exit' };
  cliCardGate({ title: question.title, options: [{ id: 'later', label: '-' }] }, io);
  let answer: QuestionAnswer = { id: 'exit' }, applying = null as Promise<void> | null, settle = () => {};
  const answered = new Promise<void>(resolve => { settle = resolve; });
  const finish = (value: QuestionAnswer) => {
    answer = value;
    if (!apply || value.id === 'later' || value.id === 'exit') { settle(); return false; }
    applying = apply(value); applying.then(settle, settle);
    return true;
  };
  const view = render(<OnboardingQuestionView question={question} locale={io.locale} finish={finish} work={work}
    copy={streamCardCopy((io.stdout ?? process.stdout) as NodeJS.WriteStream, cardCopyLabels(io.locale), io.env ?? process.env)} />,
    { stdin: (io.stdin ?? process.stdin) as NodeJS.ReadStream, stdout: (io.stdout ?? process.stdout) as NodeJS.WriteStream,
      interactive: true, patchConsole: false, exitOnCtrlC: false });
  // An abort closes an open question (exit); an apply already running is waited for, as before the card stayed up for it.
  const stop = () => { if (!applying) settle(); };
  io.signal?.addEventListener('abort', stop, { once: true });
  // A frame still queued by the renderer (the "applying" line of a short apply) is written first, so the erase takes it too.
  try { await Promise.race([answered, view.waitUntilExit()]); await view.waitUntilRenderFlush(); } finally { view.clear(); view.unmount(); io.signal?.removeEventListener('abort', stop); }
  if (applying) await applying;
  return answer;
}
