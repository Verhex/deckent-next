import { useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import { t, terminalSafeText, type Locale } from '#platform/index.js';
import { cliCardGate, type CliCardIo } from '#surfaces/core/cli-human/index.js';
import { truncateEnd, wrapCells } from '#surfaces/core/terminal-render/index.js';
export type OnboardingQuestion = Readonly<{ title: string; body: readonly string[]; choices: readonly Readonly<{ id: string; label: string; disabled?: boolean }>[];
  step: number; total: number; initial?: string | null; text?: boolean }>;
export type QuestionAnswer = Readonly<{ id: string; text?: string }>;
export function OnboardingQuestionView({ question, locale, finish }: { readonly question: OnboardingQuestion; readonly locale: Locale; readonly finish: (answer: QuestionAnswer) => void }) {
  const initial = question.initial === null ? -1 : Math.max(0, question.choices.findIndex(row => row.id === question.initial));
  const [at, select] = useState(initial), [text, setText] = useState(''), [bodyAt, scroll] = useState(0), done = useRef(false), { exit } = useApp();
  const size = useWindowSize(), width = Math.max(8, size.columns - 4), height = Math.max(1, Math.min(question.choices.length || 1, Math.floor(size.rows / 3)));
  const bodyHeight = Math.max(1, size.rows - height - 9), bodyLines = question.body.flatMap(line => wrapCells(terminalSafeText(line), width));
  const send = (answer: QuestionAnswer) => { if (done.current) return; done.current = true; finish(answer); exit(); };
  useInput((input, key) => {
    if (done.current || input.length > 1 && !question.text) return;
    if (key.escape) { send({ id: 'later' }); return; }
    if (key.ctrl && input === 'c') { send({ id: 'exit' }); return; }
    if (key.pageUp) { scroll(value => Math.max(0, value - bodyHeight)); return; }
    if (key.pageDown) { scroll(value => Math.min(Math.max(0, bodyLines.length - bodyHeight), value + bodyHeight)); return; }
    if (key.upArrow) select(value => Math.max(0, value - 1));
    else if (key.downArrow) select(value => Math.min(question.choices.length - 1, value + 1));
    else if (key.return) {
      if (question.text) { if (text.trim()) send({ id: 'submit', text: text.trim() }); }
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
    {question.text ? <Text>{truncateEnd(text || t('onboarding.firstTask.freeText', {}, locale), width, '…')}</Text>
      : question.choices.slice(start, start + height).map((row, index) => <Text key={row.id}>{at === start + index ? '> ' : '  '}{truncateEnd(terminalSafeText(row.label), width - 2, '…')}</Text>)}
    <Text> </Text><Text>{t('onboarding.session.continue', {}, locale)} · {t('onboarding.session.later', {}, locale)}</Text>
  </Box>;
}
/** A single input owner; unmounted before a foreground owner takes the real terminal. */
export async function askOnboardingQuestion(question: OnboardingQuestion, io: CliCardIo): Promise<QuestionAnswer> {
  if (io.signal?.aborted) return { id: 'exit' };
  cliCardGate({ title: question.title, options: [{ id: 'later', label: '-' }] }, io);
  let answer: QuestionAnswer = { id: 'exit' };
  const view = render(<OnboardingQuestionView question={question} locale={io.locale} finish={value => { answer = value; }} />,
    { stdin: (io.stdin ?? process.stdin) as NodeJS.ReadStream, stdout: (io.stdout ?? process.stdout) as NodeJS.WriteStream,
      interactive: true, patchConsole: false, exitOnCtrlC: false });
  const stop = () => view.unmount(); io.signal?.addEventListener('abort', stop, { once: true });
  try { await view.waitUntilExit(); } finally { view.unmount(); io.signal?.removeEventListener('abort', stop); }
  return answer;
}
