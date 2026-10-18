import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Text, type Key } from 'ink';
import { useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { useRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { Window } from './window.js';
import { WINDOW_PRIORITY } from './window-stack.js';
import DECISION from './decision.json' with { type: 'json' };

/**
 * One question contract for the terminal (TERMINAL-SABIT-DUZEN slice 2, owner 2026-10-18): approvals, single-choice and multi-choice
 * questions share these keys — ↑↓ or j/k move, 1–9 jump, Space toggles (multi), Enter submits the highlighted option (single) or the ticked
 * ones (multi), Esc and Ctrl+C cancel, and an option's own letter (`y`, `n`, `s`, `a`) answers a single-choice question at once. Pasted or
 * multi-character input never answers. A question that takes the keyboard by itself is armed only after `armMs` (registry
 * `decision.json`), so keys typed for the input just before it appeared never decide it. Display and keys only: what a choice is allowed to
 * mean stays with the caller's controller and the service.
 */
export type QuestionKind = 'single' | 'multi';
export type QuestionOption = Readonly<{ id: string; label: string; key?: string }>;
export type QuestionState = Readonly<{ at: number; ticked: readonly string[] }>;
export type QuestionStep = Readonly<{ kind: 'move'; state: QuestionState }> | Readonly<{ kind: 'submit'; ids: readonly string[] }> | Readonly<{ kind: 'cancel' }> | Readonly<{ kind: 'ignored' }>;

export const DECISION_ARM_DEFAULT: number = DECISION.armMs;
/** The arming delay in force (tests may set 0; production keeps the registry value). */
export const DecisionArmContext = createContext<number>(DECISION_ARM_DEFAULT);

export function questionStep(kind: QuestionKind, options: readonly QuestionOption[], state: QuestionState, input: string, key: Key): QuestionStep {
  const last = Math.max(0, options.length - 1), move = (at: number): QuestionStep => ({ kind: 'move', state: { ...state, at: Math.min(last, Math.max(0, at)) } });
  if (key.escape || (key.ctrl && input === 'c')) return { kind: 'cancel' };
  if (key.ctrl || key.meta) return { kind: 'ignored' };
  if (key.upArrow || input === 'k') return move(state.at - 1);
  if (key.downArrow || input === 'j') return move(state.at + 1);
  if (key.return) {
    if (kind === 'multi') return { kind: 'submit', ids: options.filter(option => state.ticked.includes(option.id)).map(option => option.id) };
    const option = options[state.at];
    return option ? { kind: 'submit', ids: [option.id] } : { kind: 'ignored' };
  }
  if (input.length !== 1) return { kind: 'ignored' };
  if (/^[1-9]$/u.test(input) && Number(input) <= options.length) return move(Number(input) - 1);
  if (kind === 'multi' && input === ' ') {
    const id = options[state.at]?.id;
    if (id === undefined) return { kind: 'ignored' };
    return { kind: 'move', state: { ...state, ticked: state.ticked.includes(id) ? state.ticked.filter(item => item !== id) : [...state.ticked, id] } };
  }
  const lower = input.toLowerCase(), shortcut = kind === 'single' ? options.find(option => option.key !== undefined && option.key.toLowerCase() === lower) : undefined;
  return shortcut ? { kind: 'submit', ids: [shortcut.id] } : { kind: 'ignored' };
}

/** True once `ms` has passed since `active` last turned true; false whenever the question does not hold the keyboard. */
export function useArmed(active: boolean, ms: number): () => boolean {
  const armed = useRef(ms <= 0 && active);
  useEffect(() => {
    armed.current = false;
    if (!active) return undefined;
    if (ms <= 0) { armed.current = true; return undefined; }
    const timer = setTimeout(() => { armed.current = true; }, ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return () => armed.current;
}

/** The option rows: a pointer on the highlighted row, its number, `[x]` for ticked rows of a multi-choice question, the letter it answers to. */
export function QuestionRows({ kind, options, state, focused }: { readonly kind: QuestionKind; readonly options: readonly QuestionOption[]; readonly state: QuestionState; readonly focused: boolean }) {
  const palette = useWorklinePalette(), glyphs = useRenderGlyphs(), pointer = glyphs.ascii ? '>' : '›';
  return <>{options.map((option, index) => {
    const here = index === state.at, box = kind === 'multi' ? `${state.ticked.includes(option.id) ? '[x]' : '[ ]'} ` : '';
    return <Text key={option.id} wrap="truncate-end" {...(here && focused ? palette.selection : {})}>
      {`${here ? pointer : ' '} ${index + 1}. ${box}${option.label}${option.key ? ` (${option.key})` : ''}`}</Text>;
  })}</>;
}

/** A question in its own window (single or multi choice): it takes the keyboard by itself, arms, and answers once. */
export function QuestionWindow({ title, kind, options, initial = 0, hints, position, onAnswer }: { readonly title: string; readonly kind: QuestionKind; readonly options: readonly QuestionOption[];
  readonly initial?: number; readonly hints: string; readonly position: string; readonly onAnswer: (ids: readonly string[] | null) => void }) {
  const [state, setState] = useState<QuestionState>({ at: initial, ticked: [] });
  const [focused, setFocused] = useState(false), armed = useArmed(focused, useContext(DecisionArmContext));
  const done = useRef(false), current = useRef(state); current.current = state;
  return <Window title={[{ text: title }]} hints={hints} position={position} footerRows={options.length} decision
    priority={WINDOW_PRIORITY.approval} onFocusChange={setFocused} footer={owns => <QuestionRows kind={kind} options={options} state={state} focused={owns} />}
    onInput={(input, key) => {
      if (done.current) return true;
      if (!armed()) return true;
      const step = questionStep(kind, options, current.current, input, key);
      if (step.kind === 'move') { current.current = step.state; setState(step.state); return true; }
      if (step.kind === 'submit' || step.kind === 'cancel') { done.current = true; onAnswer(step.kind === 'submit' ? step.ids : null); return true; }
      return key.tab;
    }} />;
}
