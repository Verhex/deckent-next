import { cells, plainText, span, type Span, type SpanRole } from '#surfaces/core/terminal-render/index.js';
import type { WindowLine } from './window.js';

/**
 * The typed view model of an information window (SW-1, owner 2026-10-08): surfaces fill sections of rows; nothing builds ad-hoc text. A
 * value is the human label; a hash, digest or identity rides in `id` and is drawn muted and shortened after it, never as the primary label.
 * Colour is never the only cue: every chip carries a word and a shape, so NO_COLOR and TERM=dumb stay readable. Pure (no React): react-free
 * producers (terminal-admin) import these types only.
 */
export type InfoChipState = 'ok' | 'warn' | 'fail' | 'info' | 'neutral';
/** A status chip: `state` picks the colour and the shape, `text` is the word that carries the meaning. */
export type InfoChip = Readonly<{ state: InfoChipState; text: string }>;
/** One aligned key/value row (bold key). `muted` de-emphasises the value; `exact` keeps a command or path character for character. */
export type InfoRow = Readonly<{ key: string; value: string; chip?: InfoChip; id?: string; muted?: boolean; exact?: boolean }>;
/** One list item (bullet). */
export type InfoItem = Readonly<{ text: string; chip?: InfoChip; id?: string; muted?: boolean }>;
/** A small table: one header row of column names, then rows of cells. */
export type InfoTable = Readonly<{ columns: readonly string[]; rows: readonly (readonly string[])[] }>;
/** A row the person can pick with the arrow keys and Enter; the window answers its `id`. */
export type InfoChoice = Readonly<{ id: string; label: string; detail?: string; chip?: InfoChip }>;
/** One section, drawn in this order: header (title and chip), rows, items, table, choices, notes. */
export type InfoSection = Readonly<{ title?: string; chip?: InfoChip; rows?: readonly InfoRow[]; items?: readonly InfoItem[]; table?: InfoTable;
  choices?: readonly InfoChoice[]; notes?: readonly string[] }>;
/** A whole window. `summary` is the one system summary line the window leaves in the scrollback when it closes. */
export type InfoWindowModel = Readonly<{ title: string; chips?: readonly InfoChip[]; sections: readonly InfoSection[]; summary: string }>;

/** The shapes that carry a chip's state next to its word. */
export type InfoGlyphs = Readonly<{ chip: Readonly<Record<InfoChipState, string>>; section: string; bullet: string; selected: string; ellipsis: string }>;
export const INFO_GLYPHS_UNICODE: InfoGlyphs = Object.freeze({ chip: Object.freeze({ ok: '✓', warn: '!', fail: '✗', info: 'i', neutral: '·' }),
  section: '▸', bullet: '•', selected: '›', ellipsis: '…' });
export const INFO_GLYPHS_ASCII: InfoGlyphs = Object.freeze({ chip: Object.freeze({ ok: '+', warn: '!', fail: 'x', info: 'i', neutral: '-' }),
  section: '>', bullet: '-', selected: '>', ellipsis: '...' });

const CHIP_ROLE: Readonly<Record<InfoChipState, SpanRole>> = { ok: 'chipOk', warn: 'chipWarn', fail: 'chipFail', info: 'info', neutral: 'muted' };
/** Identities up to this length are shown whole; longer ones keep their head and an ellipsis. */
const ID_WHOLE = 10, ID_HEAD = 8;

/** A hash, digest or identity shortened for display (`abc12345…`); the full value stays in the producer's record. */
export function shortenIdentity(value: string, ellipsis = INFO_GLYPHS_UNICODE.ellipsis): string {
  return value.length <= ID_WHOLE ? value : `${value.slice(0, ID_HEAD)}${ellipsis}`;
}

/** `[✓ ready]`: the shape and the word, in the chip's colour role. */
export function chipSpans(chip: InfoChip, glyphs: InfoGlyphs = INFO_GLYPHS_UNICODE): Span[] {
  return [span(`[${glyphs.chip[chip.state]} ${chip.text}]`, { role: CHIP_ROLE[chip.state] })];
}

function tail(chip: InfoChip | undefined, id: string | undefined, glyphs: InfoGlyphs): Span[] {
  return [...(chip ? [span(' '), ...chipSpans(chip, glyphs)] : []), ...(id ? [span(' '), span(shortenIdentity(id, glyphs.ellipsis), { role: 'mutedId' })] : [])];
}

/** Every choice of the model in display order (the arrow keys move through this list). */
export function infoChoices(model: InfoWindowModel): readonly InfoChoice[] {
  return model.sections.flatMap(section => section.choices ?? []);
}

export type InfoLayout = Readonly<{ lines: readonly WindowLine[]; choiceLines: readonly number[] }>;

/** Lays the model out as window body lines (labels in the key column); `choiceLines[i]` is the body line of the i-th choice. */
export function infoWindowLines(model: InfoWindowModel, selected: number | null = null, glyphs: InfoGlyphs = INFO_GLYPHS_UNICODE): InfoLayout {
  const lines: WindowLine[] = [], choiceLines: number[] = [];
  if (model.chips?.length) lines.push({ spans: model.chips.flatMap((chip, index) => [...(index ? [span(' ')] : []), ...chipSpans(chip, glyphs)]) });
  let choice = 0;
  model.sections.forEach((section, index) => {
    if (lines.length || index > 0) lines.push({ spans: [] });
    if (section.title) lines.push({ spans: [span(`${glyphs.section} ${section.title}`, { role: 'sectionHeader' }), ...tail(section.chip, undefined, glyphs)] });
    for (const row of section.rows ?? []) {
      lines.push({ label: [span(row.key, { role: 'keyLabel' })], spans: [span(row.value, row.muted ? { role: 'muted' } : {}), ...tail(row.chip, row.id, glyphs)],
        ...(row.exact ? { exact: true } : {}) });
    }
    for (const item of section.items ?? []) {
      lines.push({ spans: [span(`  ${glyphs.bullet} `), span(item.text, item.muted ? { role: 'muted' } : {}), ...tail(item.chip, item.id, glyphs)] });
    }
    if (section.table) lines.push(...tableLines(section.table));
    for (const entry of section.choices ?? []) {
      const on = selected === choice;
      choiceLines.push(lines.length);
      lines.push({ spans: [span(on ? `${glyphs.selected} ` : '  ', on ? { role: 'selection' } : {}), span(entry.label, on ? { role: 'selection' } : { bold: true }),
        ...(entry.detail ? [span('  '), span(entry.detail, { role: 'muted' })] : []), ...tail(entry.chip, undefined, glyphs)] });
      choice++;
    }
    for (const note of section.notes ?? []) lines.push({ spans: [span(note, { role: 'muted' })] });
  });
  return { lines, choiceLines };
}

function tableLines(table: InfoTable): WindowLine[] {
  const widths = table.columns.map((column, index) => Math.max(cells(column), ...table.rows.map(row => cells(row[index] ?? ''))));
  const pad = (text: string, index: number) => index === widths.length - 1 ? text : `${text}${' '.repeat(Math.max(0, widths[index]! - cells(text)))}  `;
  return [{ spans: table.columns.map((column, index) => span(pad(column, index), { role: 'keyLabel' })) },
    ...table.rows.map(row => ({ spans: row.map((value, index) => span(pad(value, index))) }))];
}

/** The model as plain text rows (proof renders and tests); the key column is aligned as in the window. */
export function infoModelText(model: InfoWindowModel, glyphs: InfoGlyphs = INFO_GLYPHS_ASCII): readonly string[] {
  const { lines } = infoWindowLines(model, null, glyphs);
  const column = Math.max(0, ...lines.filter(line => line.label?.length).map(line => cells(plainText(line.label!)))) + 1;
  const padded = (label: string) => `${label}${' '.repeat(Math.max(1, column - cells(label)))}`;
  return [model.title, ...lines.map(line => line.label?.length ? `${padded(plainText(line.label))}${plainText(line.spans)}` : plainText(line.spans))];
}
