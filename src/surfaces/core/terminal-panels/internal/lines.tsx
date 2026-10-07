import { useRef } from 'react';
import { projectApprovalDecisionText } from '#surfaces/core/approval-presentation/index.js';
import { span, useHumanTextSecrets } from '#surfaces/core/terminal-render/index.js';
import { Window, useWindowReserve, WINDOW_RESERVED_ROWS, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import { LIST_PICKER_MIN_ROWS } from '#surfaces/core/terminal-picker/index.js';
import { useWindowSize } from 'ink';
import type { KnownSecretSnapshot } from '#platform/index.js';
import type { PanelLine } from './contract.js';

/** Labelled panel rows as window lines: every value passes the decision projection (redaction, hidden code points) before it is drawn. */
export function panelWindowLines(lines: readonly PanelLine[], known?: KnownSecretSnapshot): WindowLine[] {
  return lines.map(line => {
    const spans = projectApprovalDecisionText(line.text, known).spans.map(part => line.tone && !part.role ? { ...part, role: line.tone } : part);
    return { ...(line.label ? { label: [span(line.label, { bold: true })] } : {}), spans };
  });
}

/** A read-only window of labelled rows (an MCP server's detail): Esc, Enter or `q` close it. */
export function LinesWindow({ title, lines, hints, position, onClose }: { readonly title: string; readonly lines: readonly PanelLine[]; readonly hints: string;
  readonly position: string; readonly onClose: () => void }) {
  const known = useHumanTextSecrets();
  return <Window title={[span(title)]} body={panelWindowLines(lines, known)} hints={hints} position={position} onClose={onClose}
    onInput={(input, key) => { if (key.return || input === 'q') { onClose(); return true; } return false; }} />;
}

/**
 * A question window: `y` answers yes, `n` no; Esc, Enter and Ctrl+C give no answer (null) — for a trust question nothing is recorded then.
 * One answer only; later keys are ignored. Arrows and page keys scroll a long body.
 */
export function QuestionWindow({ title, lines, hints, position, onAnswer }: { readonly title: string; readonly lines: readonly PanelLine[]; readonly hints: string;
  readonly position: string; readonly onAnswer: (answer: boolean | null) => void }) {
  const known = useHumanTextSecrets(), answered = useRef(false);
  const answer = (value: boolean | null) => { if (answered.current) return; answered.current = true; onAnswer(value); };
  return <Window title={[span(title)]} body={panelWindowLines(lines, known)} hints={hints} position={position} onClose={() => answer(null)}
    onInput={(input, key) => {
      if (input === 'y' || input === 'Y') { answer(true); return true; }
      if (input === 'n' || input === 'N') { answer(false); return true; }
      if (key.return || (key.ctrl && input === 'c')) { answer(null); return true; }
      return false;
    }} />;
}

/** Rows of a window's frame, title and key-hint row, and of the list's own chrome (path, position, reason, hints on two rows). */
const WINDOW_CHROME_ROWS = 4, PICKER_CHROME_ROWS = 5, FALLBACK_ROWS = 24;
/**
 * How many list rows fit under a window body of `bodyRows` (owner 2026-10-07: a window's height is capped to the terminal): the terminal's rows
 * minus what the rest of the live area keeps, the window's chrome, its body and the list's chrome. The list never goes below its minimum.
 */
export function usePickerRoom(bodyRows: number): Readonly<{ rows: number; footerRows: number }> {
  const size = useWindowSize(), reserved = useWindowReserve() ?? WINDOW_RESERVED_ROWS;
  const rows = Math.max(LIST_PICKER_MIN_ROWS, (size.rows || FALLBACK_ROWS) - reserved - WINDOW_CHROME_ROWS - bodyRows - PICKER_CHROME_ROWS);
  return { rows, footerRows: rows + PICKER_CHROME_ROWS };
}
